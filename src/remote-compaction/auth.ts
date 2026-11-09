import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { record, type BindingScope, type CheckpointScope, type Checkpoint } from "./checkpoint.ts";

// These fields are additive in the explicit Pi OAuth-continuity patch.
// Stock 1.5 retains the conservative token/account check.
type RequestAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>
  & { source?: string; oauthSessionId?: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const safeError = (value: unknown, secrets: string[] = []): string => {
  let text = typeof value === "string" ? value : value instanceof Error ? value.message : "provider request failed";
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/Bearer\s+[^\s";,]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1500);
};
const tokenAccount = (key: string): unknown => {
  try {
    const account = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString())["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof account === "string" && account ? account : undefined;
  } catch { return undefined; }
};
const accountHeader = (model: Model<Api>, auth: { headers?: Record<string, string | null> }) =>
  Object.entries({ ...model.headers, ...auth.headers }).findLast(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1] ?? undefined;
const route = (model: Model<Api>, baseUrl = model.baseUrl) => [model.provider, model.api, model.id, baseUrl];
// Pi emits model_select for model identity, not same-ID endpoint/API changes.
export const sameRoute = (before: Model<Api>, after: Model<Api> | undefined) => after !== undefined
  && before.provider === after.provider && before.api === after.api && before.id === after.id && before.baseUrl === after.baseUrl;
const boundIdentity = (model: Model<Api>, url: string, identity: unknown, header?: string) =>
  hash([...route(model, url), identity, header]);
const bindingScope = (model: Model<Api>, url: string, account: unknown, header?: string): Pick<BindingScope, "route" | "account"> => ({
  route: hash(route(model, url.replace(/\/+$/, ""))),
  ...(account !== undefined || header !== undefined ? { account: hash([account, header]) } : {}),
});
export async function resolveRequest(ctx: ExtensionContext, model: Model<Api>, resolvedAuth?: RequestAuth) {
  const provider = ctx.modelRegistry.getProvider(model.provider);
  const auth: RequestAuth = resolvedAuth ?? await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "Codex authentication unavailable" : safeError(auth.error));
  // Patched Pi resolves source and ownership atomically with model headers.
  // Stock Pi needs a second read; reject a race instead of mixing credentials.
  const needsSource = resolvedAuth === undefined && !("source" in auth);
  const legacy = needsSource ? await ctx.modelRegistry.getProviderAuth(model.provider) : undefined;
  if (!provider) throw new Error("Unsupported Codex API");
  if (needsSource && legacy?.auth.apiKey !== auth.apiKey)
    throw new Error("Codex authentication changed during resolution; retry with the current authentication");
  const account = tokenAccount(auth.apiKey), header = accountHeader(model, auth), url = auth.baseUrl ?? model.baseUrl;
  const baseScope = bindingScope(model, url, account, header);
  // The only explicit auth override is the read-only legacy Codex CLI login.
  const scope: CheckpointScope = resolvedAuth !== undefined || (auth.source ?? legacy?.source) === "OAuth"
    ? { ...baseScope, credential: "oauth" }
    : { ...baseScope, credential: "api_key", apiKeyDigest: hash(auth.apiKey) };
  const snapshot = { ...auth, headers: auth.headers ? { ...auth.headers } : undefined, env: auth.env ? { ...auth.env } : undefined };
  return { scope,
    registration: ctx.modelRegistry.getRegisteredProviderConfig(model.provider),
    nativeOwner: ctx.modelRegistry.getRegisteredNativeProvider(model.provider),
    provider, model: { ...model, headers: model.headers ? { ...model.headers } : undefined,
      baseUrl: url }, auth: snapshot };
}
export function requestChange(
  before: Awaited<ReturnType<typeof resolveRequest>>, after: Awaited<ReturnType<typeof resolveRequest>>,
): string | undefined {
  if (before.registration !== after.registration || before.nativeOwner !== after.nativeOwner)
    return "Provider registration changed";
  if (scopeState(before.scope, after.scope) !== "valid") return "Authentication scope changed";
  if (before.scope.credential === "oauth" && (before.auth.oauthSessionId || after.auth.oauthSessionId)) {
    if (before.auth.oauthSessionId !== after.auth.oauthSessionId) return "OAuth login changed";
  } else if (before.auth.apiKey !== after.auth.apiKey
    && !(before.scope.credential === "oauth" && before.scope.account !== undefined)) {
    return "OAuth refresh continuity unavailable; use the Pi OAuth-continuity patch";
  }
  if (JSON.stringify([before.auth.headers, before.auth.env, before.model.baseUrl])
    !== JSON.stringify([after.auth.headers, after.auth.env, after.model.baseUrl])) return "Request configuration changed";
}
// V1 API keys and unscoped records need the old key/account binding. OAuth
// checkpoints never pin access tokens, and Pi credentials are untouched.
export const matchesLegacyBinding = (binding: string | undefined, request: Awaited<ReturnType<typeof resolveRequest>>) => {
  if (!binding) return false;
  const account = tokenAccount(request.auth.apiKey!), header = accountHeader(request.model, request.auth);
  return [request.model.baseUrl, request.model.baseUrl.replace(/\/+$/, "")].some(url =>
    binding === boundIdentity(request.model, url, account ?? request.auth.apiKey, header));
};
export const scopeState = (previous: BindingScope, current: BindingScope) => {
  if (previous.route !== current.route || previous.credential && previous.credential !== current.credential
    || previous.account && current.account && previous.account !== current.account
    || previous.apiKeyDigest && previous.apiKeyDigest !== current.apiKeyDigest) return "incompatible";
  if (previous.account !== current.account || previous.credential === "api_key" && !previous.apiKeyDigest) return "unverified";
  return "valid";
};
export const bindingState = (data: Checkpoint, request: Awaited<ReturnType<typeof resolveRequest>>,
  origin?: { provider: string; modelId: string }) => {
  // Pi owns login and refresh. Opaque account metadata cannot establish a
  // client-side identity: on the original route, the backend validates its
  // encrypted checkpoint under Pi's current auth. Never pin OAuth to a token.
  if (data.scope?.credential) {
    const state = scopeState(data.scope, request.scope);
    if (state === "unverified" && data.version === 1 && data.scope.credential === "api_key"
      && data.scope.account === request.scope.account && matchesLegacyBinding(data.binding, request)) return "valid";
    return state;
  }
  if (data.scope && scopeState(data.scope, request.scope) !== "valid") return "incompatible";
  if (matchesLegacyBinding(data.binding, request)) return "valid";
  const model = data.model ?? origin;
  if (model && (model.provider !== request.model.provider || model.modelId !== request.model.id)) return "incompatible";
  return "unverified";
};

export async function codexRequest(ctx: ExtensionContext, model: Model<Api>) {
  const legacyModel: Model<Api> = ctx.modelRegistry.find("openai-codex", model.id) ?? {
    ...model, provider: "openai-codex", api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api", headers: undefined,
  };
  if (legacyModel.api !== "openai-codex-responses") throw new Error("Unsupported Codex API");
  if ((await ctx.modelRegistry.getProviderAuth(legacyModel.provider))?.source === "OAuth") {
    const request = await resolveRequest(ctx, legacyModel);
    if (request.scope.credential !== "oauth") throw new Error("Codex OAuth changed; retry with the current authentication");
    return request;
  }
  let token: unknown;
  try {
    const data = record(JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"), "utf8")));
    if (data.auth_mode === "chatgpt") token = record(data.tokens).access_token;
  } catch { /* A missing or unreadable CLI login cannot authorize compression. */ }
  if (typeof token !== "string" || !token) throw new Error("Legacy Codex OAuth unavailable; sign in with codex login");
  // CLI credentials belong to the official backend, not a configured proxy.
  return resolveRequest(ctx,
    { ...legacyModel, baseUrl: "https://chatgpt.com/backend-api", headers: undefined },
    { ok: true, apiKey: token });
}

