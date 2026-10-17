import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cleanupSessionResources, getCurrentSystemMessage, normalizeContext,
  type Model, type Api, type OAuthAuth, type OAuthLoginCallbacks, type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  buildSessionProjection, convertToLlm, estimateTokens,
  type ExtensionAPI, type ExtensionContext, type SessionEntry, type CompactionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  METIS_EVENTS, isCodexCompactionOwnerRequest,
  type CodexCompactionOwnerRequest, type BeforeRemoteCompactRequest, type CondenseProjectRequest,
  type GoalProjectRequest,
} from "./collaboration.ts";

const KEY = "metisCodexRemoteCompaction";
const MARKER = "[Metis Codex remote checkpoint ";
const TIMEOUT = 300_000;
const MAX_BYTES = 8 * 1024 * 1024;
const OAUTH_IDENTITY = "metisCodexCheckpointIdentity";
const OAUTH_LEGACY = "metisCodexCheckpointLegacyBindings";
const PORTABLE = "metisCodexPortableSummary";
const MAX_SUMMARY_BYTES = 64 * 1024;
const isPortableSummary = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && !value.trimStart().startsWith(MARKER) && Buffer.byteLength(value) <= MAX_SUMMARY_BYTES;
type Item = Record<string, any>;
interface BindingScope { route: string; account?: string; credential?: "oauth" | "api_key" }
interface LegacyBinding extends BindingScope { binding: string }
interface Checkpoint {
  version: 1; marker: string; binding: string; history: Item[];
  scope?: BindingScope; protocol?: "responses"; codexBinding?: string;
  model?: { provider: string; modelId: string };
}
interface GrantIdentity { identity: string; legacy: LegacyBinding[] }
type RequestAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceHash = (branch: SessionEntry[]) => hash(branch.filter(entry =>
  entry.type === "message" || entry.type === "context_edit" || entry.type === "compaction" || entry.type === "branch_summary"));
const record = (value: unknown): Item => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const legacyBinding = (value: unknown): value is LegacyBinding => {
  const entry = record(value);
  return digest(entry.route) && digest(entry.binding) && (entry.account === undefined || digest(entry.account));
};
const credentialGrant = (credential: Record<string, unknown>): GrantIdentity => {
  const identity = credential[OAUTH_IDENTITY], legacy = credential[OAUTH_LEGACY];
  return {
    identity: digest(identity) ? identity : hash(credential.access),
    legacy: digest(identity) && Array.isArray(legacy) ? legacy.filter(legacyBinding) : [],
  };
};
const safeError = (value: unknown, secrets: string[] = []): string => {
  let text = typeof value === "string" ? value : value instanceof Error ? value.message : "provider request failed";
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/Bearer\s+[^\s";,]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1500);
};
const tokenAccount = (key: string): unknown => {
  try { return JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString())["https://api.openai.com/auth"]?.chatgpt_account_id; }
  catch { return undefined; }
};
const accountHeader = (model: Model<Api>, auth: { headers?: Record<string, string | null> }) =>
  Object.entries({ ...model.headers, ...auth.headers }).findLast(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1] ?? undefined;
const route = (model: Model<Api>, baseUrl = model.baseUrl) => [model.provider, model.api, model.id, baseUrl];
const boundIdentity = (model: Model<Api>, url: string, identity: unknown, header?: string) =>
  hash([...route(model, url), identity, header]);
const bindingScope = (model: Model<Api>, url: string, account: unknown, header?: string): BindingScope => ({
  route: hash(route(model, url.replace(/\/+$/, ""))),
  ...(account !== undefined || header !== undefined ? { account: hash([account, header]) } : {}),
});
const isMarker = (value: unknown): value is string => typeof value === "string"
  && value.startsWith(MARKER) && /^[\da-f-]{36}\]$/.test(value.slice(MARKER.length));
const ours = (entry: SessionEntry): entry is CompactionEntry => entry.type === "compaction"
  && (Object.hasOwn(record(entry.details), KEY) || entry.fromHook === true && isMarker(entry.summary));

function isRemoteModel(model: ExtensionContext["model"]): model is Model<Api>;
function isRemoteModel(model: CodexCompactionOwnerRequest["model"]): boolean;
function isRemoteModel(model: CodexCompactionOwnerRequest["model"]): boolean {
  return (model?.api === "openai-codex-responses" || model?.api === "openai-responses")
    && (model.provider === "openai" || model.provider === "openai-codex");
}

function responsesHistory(value: unknown): value is Item[] {
  if (!Array.isArray(value) || !value.length || !value.every(item => item && typeof item === "object" && !Array.isArray(item))) return false;
  const checkpoints = value.filter(item => item.type === "compaction");
  return checkpoints.length > 0 && checkpoints.every(item => typeof item.encrypted_content === "string"
    && item.encrypted_content.length > 0 && (!item.status || item.status === "completed"));
}

function checkpoint(entry: CompactionEntry): Checkpoint | undefined {
  const data = record(record(entry.details)[KEY]);
  if (!isMarker(entry.summary) || data.version !== 1 || data.marker !== entry.summary
    || typeof data.binding !== "string" || !Array.isArray(data.history)) return;
  if (data.model !== undefined && (typeof record(data.model).provider !== "string" || typeof record(data.model).modelId !== "string")) return;
  if (data.scope && (!digest(data.scope.route)
    || data.scope.account !== undefined && !digest(data.scope.account)
    || data.scope.credential !== undefined && !["oauth", "api_key"].includes(data.scope.credential))) return;
  if (JSON.stringify(data.history).length > MAX_BYTES) return;
  if (data.protocol === "responses") return responsesHistory(data.history) ? data as Checkpoint : undefined;
  if (data.protocol !== undefined) return;
  const last = record(data.history.at(-1));
  if (last.type !== "compaction" || typeof last.encrypted_content !== "string" || !last.encrypted_content) return;
  if (!data.history.slice(0, -1).every((item: unknown) => record(item).role === "user"
    && (!record(item).type || record(item).type === "message"))) return;
  return data as Checkpoint;
}

/** Original entries remain in Pi's ledger. Removing only our boundaries restores
 * raw history without bypassing preceding plaintext compactions or context edits. */
function rawBranch(branch: SessionEntry[]): SessionEntry[] {
  return branch.map(entry => ours(entry)
    ? { ...entry, type: "custom" as const, customType: KEY, data: undefined }
    : entry);
}
function active(ctx: { sessionManager: CodexCompactionOwnerRequest["sessionManager"] }) {
  const projection = ctx.sessionManager.buildSessionProjection();
  const wrapper = projection.entries.find(e => e.sourceEntry.type === "compaction" && e.messages.length);
  const entry = wrapper?.sourceEntry;
  if (!entry || !ours(entry)) return;
  const data = checkpoint(entry);
  // A context edit of the summary invalidates its opaque history.
  const message = wrapper.messages.find(m => m.role === "compactionSummary");
  const branch = ctx.sessionManager.getBranch();
  const covered = new Set(branch.slice(0, branch.findIndex(e => e.id === entry.firstKeptEntryId)).map(e => e.id));
  const entryIndex = branch.findIndex(e => e.id === entry.id);
  const edited = branch.slice(entryIndex + 1).some(e => e.type === "context_edit" && covered.has(e.targetId));
  const origin = branch.slice(0, entryIndex).findLast(e => e.type === "model_change");
  return { entry, origin: origin?.type === "model_change" ? origin : undefined,
    data: !edited && message?.role === "compactionSummary" && message.summary === entry.summary ? data : undefined };
}
async function requestBinding(ctx: ExtensionContext, model: Model<Api>, accounts: Map<string, GrantIdentity>, resolvedAuth?: RequestAuth) {
  const provider = ctx.modelRegistry.getProvider(model.provider);
  const auth = resolvedAuth ?? await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "Codex authentication unavailable" : safeError(auth.error));
  const account = tokenAccount(auth.apiKey), grant = accounts.get(hash(auth.apiKey));
  if (!provider) throw new Error("Unsupported Codex API");
  const header = accountHeader(model, auth), url = auth.baseUrl ?? model.baseUrl;
  const scope: BindingScope = { ...bindingScope(model, url, account, header),
    credential: ctx.modelRegistry.isUsingOAuth(model) ? "oauth" : "api_key" };
  const snapshot = { ...auth, headers: auth.headers ? { ...auth.headers } : undefined, env: auth.env ? { ...auth.env } : undefined };
  return { identity: boundIdentity(model, url.replace(/\/+$/, ""), account ?? grant?.identity ?? auth.apiKey, header),
    legacyIdentity: boundIdentity(model, url, account ?? auth.apiKey, header),
    legacyBindings: grant?.legacy.filter(entry => entry.route === scope.route && entry.account === scope.account)
      .map(entry => entry.binding) ?? [], scope,
    registration: ctx.modelRegistry.getRegisteredProviderConfig(model.provider),
    nativeOwner: ctx.modelRegistry.getRegisteredNativeProvider(model.provider),
    provider, model: { ...model, headers: model.headers ? { ...model.headers } : undefined,
      baseUrl: auth.baseUrl ?? model.baseUrl }, auth: snapshot };
}
const sameProvider = (before: Awaited<ReturnType<typeof requestBinding>>, after: Awaited<ReturnType<typeof requestBinding>>) =>
  before.registration === after.registration && before.nativeOwner === after.nativeOwner
  && before.scope.credential === after.scope.credential
  && hash([before.auth.headers, before.auth.env, before.model.baseUrl]) === hash([after.auth.headers, after.auth.env, after.model.baseUrl]);
const matchesBinding = (data: Checkpoint, request: Awaited<ReturnType<typeof requestBinding>>) =>
  data.binding === request.identity || data.binding === request.legacyIdentity || request.legacyBindings.includes(data.binding);
const bindingState = (data: Checkpoint, request: Awaited<ReturnType<typeof requestBinding>>,
  origin?: { provider: string; modelId: string }) => {
  const previous = data.scope, current = request.scope;
  if (previous?.credential && previous.credential !== current.credential) return "incompatible";
  if (matchesBinding(data, request)) return "valid";
  if (origin && (origin.provider !== request.model.provider || origin.modelId !== request.model.id)) return "incompatible";
  if (previous && (previous.route !== current.route
    || previous.account && current.account && previous.account !== current.account)) return "incompatible";
  if (previous?.credential === "api_key" && current.credential === "api_key") return "incompatible";
  return "unverified";
};

async function codexRequest(ctx: ExtensionContext, model: Model<Api>, accounts: Map<string, GrantIdentity>) {
  const legacyModel: Model<Api> = ctx.modelRegistry.find("openai-codex", model.id) ?? {
    ...model, provider: "openai-codex", api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api", headers: undefined,
  };
  if (legacyModel.api !== "openai-codex-responses") throw new Error("Unsupported Codex API");
  if (ctx.modelRegistry.isUsingOAuth(legacyModel)) return requestBinding(ctx, legacyModel, accounts);
  let token: unknown;
  try {
    const data = record(JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"), "utf8")));
    if (data.auth_mode === "chatgpt") token = record(data.tokens).access_token;
  } catch { /* A missing or unreadable CLI login cannot authorize compression. */ }
  if (typeof token !== "string" || !token) throw new Error("Legacy Codex OAuth unavailable; sign in with codex login");
  // CLI credentials belong to the official backend, not a configured proxy.
  return requestBinding(ctx,
    { ...legacyModel, baseUrl: "https://chatgpt.com/backend-api", headers: undefined }, accounts,
    { ok: true, apiKey: token });
}

function summaryText(marker: string): string {
  const message = convertToLlm([{ role: "compactionSummary", summary: marker, tokensBefore: 0, timestamp: 0 }])[0];
  return typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
}
function matchesMarker(item: Item, expected: string): boolean {
  if (item.role !== "user" || item.type && item.type !== "message") return false;
  if (typeof item.content === "string") return item.content === expected;
  return Array.isArray(item.content)
    && item.content.map((part: Item) => part.type === "input_text" ? part.text : "").join("") === expected;
}
function replaceMarker(payload: unknown, data: Checkpoint): Item {
  const body = record(payload);
  if (!Array.isArray(body.input)) throw new Error("Codex payload has no input");
  const expected = summaryText(data.marker);
  let matches = 0;
  const input = body.input.flatMap((item: Item) => {
    if (!matchesMarker(item, expected)) return [item];
    matches++; return data.history;
  });
  if (matches !== 1) throw new Error("Codex checkpoint marker missing or ambiguous");
  return { ...body, input };
}

function responsesCompactionFetch(capture: (output: unknown) => void, fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith("/responses") || typeof init?.body !== "string")
      throw new Error("Codex provider did not expose native input");
    url.pathname += "/compact";
    const { model, input: history, instructions } = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    headers.delete("content-length");
    headers.set("accept", "application/json");
    const response = await fetcher(url, { ...init, headers, body: JSON.stringify({ model, input: history, instructions }) });
    if (!response.ok) return response;
    const compacted = record(await response.json());
    capture(compacted.object === "response.compaction" && !compacted.error ? compacted.output : undefined);
    // The native adapter supplies encoding, auth, retries and usage. Bridge the
    // non-streaming compact response back to its completion event contract.
    const event = { type: "response.completed", response: {
      id: compacted.id, status: compacted.status ?? "completed", usage: compacted.usage,
    } };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
}

async function capturePayload(request: Awaited<ReturnType<typeof requestBinding>>, context: ReturnType<typeof normalizeContext>,
  signal: AbortSignal, sessionId?: string, reasoning?: ThinkingLevel): Promise<Item> {
  let captured: Item | undefined;
  await request.provider.streamSimple(request.model, context, {
    apiKey: request.auth.apiKey, headers: request.auth.headers, env: request.auth.env,
    signal, transport: "sse", maxRetries: 0, cacheRetention: "short", sessionId, reasoning,
    onPayload(payload) {
      captured = structuredClone(record(payload));
      throw new Error("Offline native payload capture complete");
    },
  }).result();
  if (!Array.isArray(captured?.input)) throw new Error("Codex provider did not expose native input");
  return captured;
}

async function authoredUserInput(request: Awaited<ReturnType<typeof requestBinding>>,
  messages: Parameters<typeof convertToLlm>[0], signal: AbortSignal): Promise<Item[]> {
  if (!messages.length) return [];
  const body = await capturePayload(request, normalizeContext({ messages: convertToLlm(messages) }), signal);
  return body.input.filter((item: unknown) => record(item).role === "user");
}

// OMP/Codex retain the newest real user messages alongside the encrypted item.
// Keep a chronological suffix within the same 64k estimated-token budget.
function retainedUsers(input: Item[]): Item[] {
  const contextual = ["<environment_context>", "<user_instructions>", "<additional_context>", "<skills", "<token_budget>", "<model_switch>"];
  const result: Item[] = []; let tokens = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item.role !== "user" || item.type && item.type !== "message") continue;
    const parts = typeof item.content === "string" ? [{ type: "input_text", text: item.content }] : item.content;
    if (!Array.isArray(parts)) continue;
    const text = parts.filter(p => p.type === "input_text").map(p => p.text).join("\n");
    if (contextual.some(prefix => text.trimStart().startsWith(prefix))) continue;
    const cost = Math.ceil(Buffer.byteLength(text) / 4) + parts.filter(p => p.type === "input_image").length * 765;
    if (tokens + cost > 64_000) break;
    tokens += cost; result.unshift(item);
  }
  return result;
}

export function registerCodexCompaction(pi: ExtensionAPI) {
  const accounts = new Map<string, GrantIdentity>();
  const trackedOAuth = new Map<object, () => void | Promise<unknown>>();
  const trackOAuth = (ctx: ExtensionContext) => {
    for (const id of ["openai", "openai-codex"]) {
      const oauth = ctx.modelRegistry.getProvider(id)?.auth.oauth;
      if (!oauth) continue;
      const registry = ctx.modelRegistry;
      const native = registry.getRegisteredNativeProvider(id)?.auth.oauth;
      const configured = registry.getRegisteredProviderConfig(id)?.oauth;
      if (!native && !configured && !oauth.isSubscription) continue;
      const owner = native ?? configured;
      if (owner && trackedOAuth.has(owner)) continue;
      const source = native ?? oauth;
      const refresh = source.refresh, toAuth = source.toAuth;
      const configuredRefresh = configured?.refreshToken;
      const remember = (credential: Record<string, unknown>, key: string) => {
        accounts.set(hash(key), credentialGrant(credential));
        if (accounts.size > 16) accounts.delete(accounts.keys().next().value!);
      };
      // These digests migrate token-bound checkpoints only after the broker
      // successfully exchanges that exact old credential under its store lock.
      const trackedRefresh: typeof refresh = async (credential, signal) => {
        let legacy: LegacyBinding[] = [];
        try {
          const resolved = await oauth.toAuth(credential);
          const models = [ctx.model, ...registry.getAll()]
            .filter((m): m is Model<Api> => Boolean(m && m.provider === id)).slice(0, 64);
          legacy = resolved.apiKey ? models.map(model => {
            const url = resolved.baseUrl ?? model.baseUrl, account = tokenAccount(resolved.apiKey!), header = accountHeader(model, resolved);
            return { ...bindingScope(model, url, account, header),
              binding: boundIdentity(model, url, account ?? resolved.apiKey, header) };
          }) : [];
        } catch { /* Observing an expired grant must never block the broker's refresh. */ }
        const next = configuredRefresh
          ? { ...await configuredRefresh.call(configured, credential, signal), type: "oauth" as const }
          : await refresh.call(source, credential, signal);
        const grant = credentialGrant(credential);
        const bindings = [...new Map([
          ...grant.legacy, ...legacy,
        ].map(entry => [`${entry.route}:${entry.account}:${entry.binding}`, entry])).values()];
        // Retain the original migration proof and recent token-bound checkpoints.
        const retained = bindings.length > 128 ? [...bindings.slice(0, 64), ...bindings.slice(-64)] : bindings;
        return { ...next, [OAUTH_IDENTITY]: grant.identity, [OAUTH_LEGACY]: retained };
      };
      const trackedToAuth: typeof toAuth = async credential => {
        const resolved = await toAuth.call(source, credential);
        if (resolved.apiKey) remember(credential, resolved.apiKey);
        return resolved;
      };
      if (native) {
        native.refresh = trackedRefresh; native.toAuth = trackedToAuth;
        trackedOAuth.set(native, () => {
          if (native.refresh === trackedRefresh) native.refresh = refresh;
          if (native.toAuth === trackedToAuth) native.toAuth = toAuth;
        });
      } else {
        const originalKey = configured?.getApiKey;
        const trackedKey = (credential: Parameters<OAuthAuth["toAuth"]>[0]) => {
          const key = configured ? originalKey!(credential) : credential.access;
          remember(credential, key);
          return key;
        };
        const registration = configured ?? {
          name: oauth.name, isSubscription: oauth.isSubscription,
          login: (callbacks: OAuthLoginCallbacks) => oauth.login({
            signal: callbacks.signal ?? new AbortController().signal,
            notify: event => {
              if (event.type === "auth_url") callbacks.onAuth(event);
              else if (event.type === "device_code") callbacks.onDeviceCode(event);
              else callbacks.onProgress?.(event.message);
            },
            prompt: async prompt => {
              if (prompt.type === "select") return await callbacks.onSelect({ ...prompt, options: [...prompt.options] }) ?? "";
              // Pi's adapter spreads these fields back into the native prompt,
              // preserving its type and callback-race cancellation signal.
              return callbacks.onPrompt(prompt);
            },
          }),
          refreshToken: trackedRefresh,
          getApiKey: trackedKey,
        };
        if (configured) {
          registration.refreshToken = trackedRefresh;
          registration.getApiKey = trackedKey;
        } else registry.registerProvider(id, { oauth: registration });
        trackedOAuth.set(registration, () => {
          if (configured) {
            if (registration.refreshToken === trackedRefresh) registration.refreshToken = configuredRefresh!;
            if (registration.getApiKey === trackedKey) registration.getApiKey = originalKey!;
          } else {
            const current = registry.getRegisteredProviderConfig(id);
            if (current?.oauth !== registration) return;
            delete current.oauth;
            if (!Object.keys(current).length) registry.unregisterProvider(id);
          }
          return registry.refresh({ allowNetwork: false });
        });
      }
    }
  };
  const contextBudget = (messages: Parameters<typeof convertToLlm>[0], ctx: ExtensionContext,
    outputReserve = ctx.model?.maxTokens ?? 0, subject = "Restored history", additionalInputTokens = 0) => {
    const system = getCurrentSystemMessage(messages);
    const overhead = system ? 0 : Math.ceil((ctx.getSystemPrompt().length
      + JSON.stringify(pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name))).length) / 4);
    const inputTokensEstimate = messages.reduce((n, m) => n + estimateTokens(m), overhead) + additionalInputTokens;
    const window = ctx.model?.contextWindow;
    const budget = outputReserve ? "including output reserve" : "for compaction input";
    return { inputTokensEstimate, inputWindow: window, outputReserve,
      error: window && inputTokensEstimate + outputReserve > window
        ? `${subject} needs approximately ${inputTokensEstimate + outputReserve} tokens ${budget}; context window is ${window}`
        : undefined };
  };
  let generation = 0;
  let pending: AbortController | undefined;
  let preparedModel: Model<Api> | undefined;
  let preparedSession: string | undefined;
  let preparedGeneration = 0;
  let preparedMarker: string | undefined;
  let preparedPortable: string | undefined;
  let preparedSource: string | undefined;
  let requestCancelled = false;
  let unsubscribeOwner: (() => void) | undefined;
  const subscribeOwner = () => {
    unsubscribeOwner?.();
    unsubscribeOwner = pi.events.on(METIS_EVENTS.codexCompactionOwner, request => {
      if (!isCodexCompactionOwnerRequest(request)) return;
      request.owns = isRemoteModel(request.model) || Boolean(active(request));
    });
  };
  subscribeOwner();
  const invalidate = () => { generation++; pending?.abort(); };
  pi.on("session_start", (_event, ctx) => { invalidate(); subscribeOwner(); trackOAuth(ctx); });
  pi.on("session_tree", invalidate);
  pi.on("model_select", invalidate);
  pi.on("session_shutdown", async () => {
    invalidate(); unsubscribeOwner?.();
    await Promise.all([...trackedOAuth.values()].map(release => release()));
    trackedOAuth.clear(); accounts.clear();
  });
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_before_fork", invalidate);

  const cancelRequest = (ctx: ExtensionContext,
    reason = "Request cancelled because its context or model changed. Retry to use the current context."): void => {
    // Payload-handler throws are swallowed by Pi. Its public abort cancels
    // the provider's signal synchronously. Cached Codex sockets skip the
    // pre-send abort check, so clear this request's session resources as well.
    // A fresh request revalidates the checkpoint in the context phase; any
    // required restoration runs every domain/host projection before sending.
    const alreadyCancelled = requestCancelled;
    requestCancelled = true;
    ctx.abort();
    if (preparedModel?.api === "openai-codex-responses" && preparedSession)
      cleanupSessionResources(preparedSession);
    if (alreadyCancelled) return;
    pi.events.emit(METIS_EVENTS.checkpointRequestCancelled, {});
    try {
      ctx.ui.notify(reason, "warning");
    } catch { /* UI teardown cannot undo request cancellation. */ }
  };
  const emptyPayload = (payload: unknown) => {
    const body = record(payload);
    return { ...body, input: [], ...(Array.isArray(body.messages) ? { messages: [] } : {}),
      ...(Array.isArray(body.contents) ? { contents: [] } : {}) };
  };

  const portableHash = (current: NonNullable<ReturnType<typeof active>>) => hash([
    current.entry.id, current.entry.firstKeptEntryId, current.data,
  ]);
  const savedPortable = (current: NonNullable<ReturnType<typeof active>>, ctx: ExtensionContext): string | undefined => {
    if (!current.data) return;
    const fingerprint = portableHash(current);
    const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === PORTABLE
      && record(entry.data).checkpoint === current.entry.id && record(entry.data).fingerprint === fingerprint);
    const summary = entry?.type === "custom" ? record(entry.data).summary : undefined;
    return isPortableSummary(summary) ? summary : undefined;
  };
  const portableProjection = async (
    current: NonNullable<ReturnType<typeof active>>, ctx: ExtensionContext, operationSignal = ctx.signal,
  ) => {
    const data = current.data;
    if (!data) throw new Error("Remote checkpoint was edited or its metadata is invalid. Use /compact to rebuild it");
    let summary = savedPortable(current, ctx);
    if (!summary) {
      const version = generation, session = ctx.sessionManager.getSessionId(), source = sourceHash(ctx.sessionManager.getBranch());
      const sourceUnchanged = () => version === generation && session === ctx.sessionManager.getSessionId()
        && source === sourceHash(ctx.sessionManager.getBranch());
      const origin = data.model ?? current.origin;
      const model = origin && ctx.modelRegistry.find(origin.provider, origin.modelId);
      if (!model || !isRemoteModel(model)) throw new Error("Original checkpoint model is unavailable; restore its provider before retrying");
      const request = await requestBinding(ctx, model, accounts);
      if (bindingState(data, request, current.origin) !== "valid")
        throw new Error("Original checkpoint identity could not be verified; restore its authentication before retrying");
      if (!sourceUnchanged())
        throw new Error("Portable summary source changed; retry with the current session");
      const controller = new AbortController();
      pending?.abort(); pending = controller;
      const signal = AbortSignal.any([controller.signal, ...(operationSignal ? [operationSignal] : []), AbortSignal.timeout(TIMEOUT)]);
      try {
        const result = await request.provider.streamSimple(request.model, normalizeContext({
          systemPrompt: "Write a portable context checkpoint for another model to continue this conversation. "
            + "Summarize the supplied checkpoint, do not execute its tasks. Preserve the user's goal, constraints, "
            + "decisions, completed work, files, unresolved issues and next steps. Return only a concise, self-contained text summary.",
          messages: convertToLlm([
            { role: "compactionSummary", summary: current.entry.summary, tokensBefore: 0, timestamp: 0 },
            { role: "user", content: "Produce the portable context summary now.", timestamp: 0 },
          ]),
        }), {
          apiKey: request.auth.apiKey, headers: request.auth.headers, env: request.auth.env,
          signal, transport: "sse", maxRetries: 2, cacheRetention: "short",
          maxTokens: Math.min(8192, model.maxTokens), reasoning: "low", sessionId: session,
          onPayload: payload => replaceMarker(payload, data),
        }).result();
        if (signal.aborted || result.stopReason !== "stop")
          throw new Error(result.errorMessage ? safeError(result.errorMessage, [request.auth.apiKey!]) : "Portable summary did not complete");
        summary = result.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
        if (!isPortableSummary(summary))
          throw new Error("Portable summary is empty or invalid");
        const final = await requestBinding(ctx, model, accounts);
        if (signal.aborted || !sourceUnchanged() || request.identity !== final.identity || !sameProvider(request, final))
          throw new Error("Portable summary source changed; retry with the current session");
        pi.appendEntry(PORTABLE, { checkpoint: current.entry.id, fingerprint: portableHash(current), summary, usage: result.usage });
      } finally {
        if (pending === controller) pending = undefined;
      }
    }
    const branch = ctx.sessionManager.getBranch().map(entry => entry.id === current.entry.id && entry.type === "compaction"
      ? { ...entry, summary } : entry);
    return { summary, projection: buildSessionProjection(branch) };
  };

  // Keep opaque checkpoints on their original route. Other models use a durable
  // text summary of that same boundary, never the uncompressed source ledger.
  pi.on("context", async (_event, ctx) => {
    trackOAuth(ctx);
    preparedModel = ctx.model ? { ...ctx.model } : undefined;
    preparedSession = ctx.sessionManager.getSessionId();
    preparedGeneration = generation;
    preparedMarker = undefined;
    preparedPortable = undefined;
    requestCancelled = false;
    // Native history/boundaries/edits determine checkpoint recovery. Extension
    // journals and summary messages are projected by their own context hooks,
    // which may legitimately publish them while preparing this same request.
    preparedSource = sourceHash(ctx.sessionManager.getBranch());
    const current = active(ctx);
    if (!current) return;
    if (current.data && isRemoteModel(ctx.model)) {
      try {
        const state = bindingState(current.data, await requestBinding(ctx, ctx.model, accounts), current.origin);
        if (state === "valid") {
          preparedMarker = current.entry.summary;
          return;
        }
        if (state === "unverified" && !savedPortable(current, ctx)) {
          cancelRequest(ctx, "Remote checkpoint identity could not be verified. Check authentication and retry, "
            + "or use /compact to rebuild it. Checkpoint and history were preserved.");
          return { messages: [] };
        }
      } catch (error) {
        if (!savedPortable(current, ctx)) {
          cancelRequest(ctx, `Remote checkpoint verification unavailable: ${safeError(error)}. `
            + "Checkpoint and history were preserved; retry after authentication recovers.");
          return { messages: [] };
        }
      }
    }
    try {
      const portable = await portableProjection(current, ctx);
      preparedPortable = portable.summary;
      return { messages: portable.projection.messages.filter(m => m.role !== "system") };
    } catch (error) {
      cancelRequest(ctx, `Cannot prepare portable checkpoint: ${safeError(error)}. `
        + "Checkpoint and history were preserved; no history was expanded.");
      return { messages: [] };
    }
  });
  pi.on("context_with_system", (event, ctx) => {
    let messages = event.messages;
    const summary = preparedPortable;
    if (summary && !requestCancelled) {
      const current = active(ctx);
      const summaries = messages.filter(message => message.role === "compactionSummary");
      if (!current || summaries.length !== 1
        || summaries[0].summary !== summary && summaries[0].summary !== current.entry.summary) {
        cancelRequest(ctx, "Portable checkpoint summary changed during context projection; retry with the current context. History was preserved.");
      } else {
        if (summaries[0].summary !== summary)
          messages = messages.map(message => message.role === "compactionSummary" ? { ...message, summary } : message);
        const reason = contextBudget(messages, ctx, undefined, "Portable checkpoint context").error;
        if (reason) cancelRequest(ctx, `${reason}. Request cancelled; history was preserved. `
          + "Use /compact to rebuild, or /tree to resume before the oversized input.");
      }
    }
    if (requestCancelled) return { messages: messages.filter(message => message.role === "system") };
    if (messages !== event.messages) return { messages };
  });
  pi.on("before_provider_request", async (event, ctx) => {
    if (requestCancelled) { ctx.abort(); return emptyPayload(event.payload); }
    if (preparedPortable) {
      const current = active(ctx);
      if (preparedSession !== ctx.sessionManager.getSessionId() || preparedGeneration !== generation
        || hash(preparedModel) !== hash(ctx.model) || preparedSource !== sourceHash(ctx.sessionManager.getBranch())
        || !current || savedPortable(current, ctx) !== preparedPortable) {
        cancelRequest(ctx); return emptyPayload(event.payload);
      }
      return;
    }
    // Only an exact carrier prepared from a real checkpoint is ours. Ordinary
    // source code, user text and tool output can contain the same marker literal.
    if (!preparedMarker) return;
    const requestModel = preparedModel ?? ctx.model;
    if (!isRemoteModel(requestModel)
      || preparedSession !== ctx.sessionManager.getSessionId() || preparedGeneration !== generation
      || hash(requestModel) !== hash(ctx.model) || preparedSource !== sourceHash(ctx.sessionManager.getBranch())) {
      cancelRequest(ctx); return emptyPayload(event.payload);
    }
    const expected = summaryText(preparedMarker);
    const input = record(event.payload).input;
    if (!Array.isArray(input) || !input.some(item => matchesMarker(record(item), expected))) {
      cancelRequest(ctx, "Remote checkpoint carrier changed. Retry with the current context; history was preserved.");
      return emptyPayload(event.payload);
    }
    const source = sourceHash(ctx.sessionManager.getBranch());
    const current = active(ctx);
    try {
      if (!current?.data || preparedSession !== ctx.sessionManager.getSessionId() || hash(requestModel) !== hash(ctx.model)
        || bindingState(current.data, await requestBinding(ctx, requestModel, accounts), current.origin) !== "valid"
        || source !== sourceHash(ctx.sessionManager.getBranch())) throw new Error("Checkpoint binding changed");
      return replaceMarker(event.payload, current.data);
    } catch (error) {
      cancelRequest(ctx, `Request cancelled while verifying remote checkpoint: ${safeError(error)}. `
        + "Checkpoint and history were preserved. Retry with the current context.");
      return emptyPayload(event.payload);
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const remote = isRemoteModel(ctx.model);
    const diagnostic: Item = { reason: event.reason, provider: ctx.model?.provider, api: ctx.model?.api };
    const secrets: string[] = [];
    const sanitize = (value: unknown) => safeError(value, secrets);
    try {
      trackOAuth(ctx);
      const previous = active(ctx);
      if (!remote && !previous) return;
      const waits: Promise<void>[] = [];
      pi.events.emit(METIS_EVENTS.beforeRemoteCompact, { waits, signal: event.signal } satisfies BeforeRemoteCompactRequest);
      await Promise.all(waits);
      const version = generation, model = ctx.model;
      const modelHash = hash(model);
      const authority = () => hash([ctx.getSystemPrompt(), pi.getActiveTools(), pi.getAllTools()]);
      const authorized = authority();
      const branch = ctx.sessionManager.getBranch();
      const session = ctx.sessionManager.getSessionId(), source = sourceHash(branch);
      const request = remote && model ? await requestBinding(ctx, model, accounts) : undefined;
      if (request?.auth.apiKey) secrets.push(request.auth.apiKey);
      const identity = request?.identity;
      const hybrid = model?.provider === "openai" && model.api === "openai-responses"
        && ctx.modelRegistry.isUsingOAuth(model);
      const compactor = hybrid ? await codexRequest(ctx, model, accounts) : request;
      if (compactor?.auth.apiKey) secrets.push(compactor.auth.apiKey);
      diagnostic.compactorProvider = compactor?.model.provider;
      diagnostic.compactorApi = compactor?.model.api;
      const reusable = previous?.data && request && bindingState(previous.data, request, previous.origin) === "valid"
        && (!hybrid || previous.data.codexBinding === compactor?.identity);
      if (previous?.data && request && bindingState(previous.data, request, previous.origin) === "unverified"
        && !savedPortable(previous, ctx) && event.reason !== "manual")
        throw new Error("Remote checkpoint identity could not be verified; checkpoint was preserved. "
          + "Use /compact to rebuild it after checking authentication.");
      let projected: ReturnType<typeof buildSessionProjection>;
      let rebuilding = false;
      if (reusable || !previous) projected = buildSessionProjection(branch);
      else {
        try { projected = (await portableProjection(previous, ctx, event.signal)).projection; }
        catch (error) {
          const metadata = record(record(previous.entry.details)[KEY]);
          const origin = previous.origin ?? metadata.model;
          const scope = record(metadata.scope);
          const repairable = event.reason === "manual" && request && origin?.provider === model?.provider
            && origin?.modelId === model?.id && (!digest(scope.route) || scope.route === request.scope.route)
            && (!previous.data || bindingState(previous.data, request, previous.origin) !== "valid");
          if (event.signal.aborted || !repairable) throw error;
          rebuilding = true;
          projected = buildSessionProjection(rawBranch(branch));
        }
      }
      const cut = projected.entries.findIndex(e => e.sourceEntry.id === event.preparation.firstKeptEntryId);
      if (cut < 0) throw new Error("Compaction boundary is no longer visible");
      let prefix = projected.entries.slice(0, cut).flatMap(e => e.messages);
      // Every compaction path uses the same evidence projection as inference.
      // Reusing ciphertext must not resurrect raw tool results beside it.
      const goal: GoalProjectRequest = { messages: prefix };
      pi.events.emit(METIS_EVENTS.goalProject, goal);
      prefix = goal.messages as typeof prefix;
      const projection: CondenseProjectRequest = { sessionId: session, api: model?.api,
        messages: prefix, maintenance: true, includeSummaries: true };
      pi.events.emit(METIS_EVENTS.condenseProject, projection);
      if (projection.busy) throw new Error("Context projection is busy; retry compaction after it settles");
      prefix = projection.messages as typeof prefix;
      // This is a local visible-prefix estimate, not provider tokenization;
      // opaque checkpoint contents are unknown. Never count ciphertext bytes
      // as ordinary text or reserve ordinary generation's maxTokens remotely.
      const budget = contextBudget(prefix, ctx, remote ? 0 : undefined,
        rebuilding ? "Restored history" : previous && !reusable ? "Portable checkpoint context" : "Projected compaction input",
        Math.ceil((event.customInstructions?.length ?? 0) / 4));
      Object.assign(diagnostic, { projectedInputTokensEstimate: budget.inputTokensEstimate,
        inputWindow: budget.inputWindow, outputReserve: budget.outputReserve, hasOpaqueCheckpoint: Boolean(reusable) });
      if (budget.error) throw new Error(`${budget.error}. Use the original model with a sufficient context window and retry /compact, `
        + "or /tree to resume before the oversized input; the original branch remains available");
      const files = record(previous?.entry.details);
      for (const path of Array.isArray(files.readFiles) ? files.readFiles : [])
        if (typeof path === "string") event.preparation.fileOps.read.add(path);
      for (const path of Array.isArray(files.modifiedFiles) ? files.modifiedFiles : [])
        if (typeof path === "string") event.preparation.fileOps.edited.add(path);
      if (!remote) {
        // Pi's native summarizer receives the portable context rather than
        // the opaque marker from the Codex session.
        event.preparation.previousSummary = prefix.find(m => m.role === "compactionSummary")?.summary;
        event.preparation.messagesToSummarize = prefix.filter(m => m.role !== "system" && m.role !== "compactionSummary");
        event.preparation.turnPrefixMessages = [];
        event.preparation.isSplitTurn = false;
        event.preparation.tokensBefore = projected.messages.reduce((n, m) => n + estimateTokens(m), 0);
        return;
      }
      if (!isRemoteModel(model) || !request || !compactor || !identity) throw new Error("Unsupported Codex API");
      const responses = model.api === "openai-responses" && !hybrid;
      if (!prefix.some(m => m.role !== "system")) throw new Error("No discarded history to compact");
      pending?.abort(); const controller = new AbortController(); pending = controller;
      const signal = AbortSignal.any([event.signal, controller.signal, AbortSignal.timeout(TIMEOUT)]);
      const progress = { inputPrepared: false, completed: false, failed: false, checkpointCount: 0 };
      const items: Item[] = [];
      let compactedWindow: unknown;
      const fetcher: typeof fetch = async (input, init) => {
        diagnostic.attempts = (diagnostic.attempts ?? 0) + 1;
        const response = await globalThis.fetch(input, init);
        diagnostic.status = response.status;
        diagnostic.requestId = response.headers.get("x-request-id") ?? undefined;
        return response;
      };
      const messages = prefix.filter(m => m.role !== "system");
      const authored = projected.entries.slice(0, cut).flatMap(entry =>
        entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "user"
          ? entry.messages.filter(message => message.role === "user") : []);
      const retainedInput = responses ? [] : [
        ...(reusable && previous?.data ? previous.data.history.slice(0, -1) : []),
        ...await authoredUserInput(request, authored, signal),
      ];
      const system = getCurrentSystemMessage(projected.messages);
      const context = normalizeContext(hybrid ? { messages: convertToLlm(prefix) } : system
        ? { messages: convertToLlm([system, ...messages]) }
        : { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages),
          tools: pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)) });
      const thinking = pi.getThinkingLevel();
      const nativePayload = hybrid ? await capturePayload(request, context, signal, session, thinking === "off" ? undefined : thinking) : undefined;
      // Pin the resolved credential/route snapshot. A second broker resolution
      // could otherwise compact under account B but publish a binding for A.
      const result = await compactor.provider.streamSimple(compactor.model, context, {
        apiKey: compactor.auth.apiKey, env: compactor.auth.env,
        signal, transport: "sse", cacheRetention: hybrid ? "short" : "none", maxRetries: 2,
        sessionId: session,
        headers: responses ? compactor.auth.headers : { ...compactor.auth.headers, "x-codex-beta-features": "remote_compaction_v2" },
        fetch: responses ? responsesCompactionFetch(output => { compactedWindow = output; }, fetcher) : fetcher,
        onPayload(payload) {
          const encoded = nativePayload ?? payload;
          const body = reusable && previous?.data ? replaceMarker(encoded, previous.data) : record(encoded);
          if (!Array.isArray(body.input)) throw new Error("Codex provider did not expose native input");
          Object.assign(progress, { inputPrepared: true, completed: false, failed: false, checkpointCount: 0 });
          items.length = 0;
          delete diagnostic.message; delete diagnostic.code;
          const input = responses ? body.input : [...body.input];
          let instructions = body.instructions;
          if (hybrid) {
            instructions ??= "";
            if (event.customInstructions) input.push({ role: "developer", content: `Compaction focus: ${event.customInstructions}` });
          } else if (event.customInstructions) {
            instructions = `${instructions ?? ""}\n\nCompaction focus: ${event.customInstructions}`;
          }
          if (!responses) input.push({ type: "compaction_trigger" });
          return { ...body, instructions, input, store: false, stream: true };
        },
        onProviderStreamEvent(value) {
          const data = record(value);
          if (data.type === "response.output_item.done") {
            const item = record(data.item);
            // Like OMP, only compaction items become durable replacement history.
            // Auxiliary reasoning/message outputs are not additional checkpoints.
            if (item.type === "compaction") {
              progress.checkpointCount++;
              if (items.length === 0 && JSON.stringify(item).length <= MAX_BYTES) items.push(structuredClone(item));
              else progress.failed = true;
            }
          }
          if (data.type === "response.completed" || data.type === "response.done") {
            progress.completed = true;
            if (data.response?.status && data.response.status !== "completed") progress.failed = true;
          }
          if (["response.failed", "response.incomplete", "error"].includes(data.type)) progress.failed = true;
          const error = data.error ?? data.response?.error;
          if (error?.message || data.type === "error") diagnostic.message = sanitize(error?.message ?? data.message);
          if (error?.code) diagnostic.code = sanitize(error.code);
        },
      }).result();
      Object.assign(diagnostic, progress, { stopReason: result.stopReason });
      if (responses && Array.isArray(compactedWindow))
        diagnostic.checkpointCount = compactedWindow.filter(item => record(item).type === "compaction").length;
      if (result.errorMessage) diagnostic.message = sanitize(result.errorMessage);
      if (signal.aborted) diagnostic.abortReason = sanitize(signal.reason);
      if (pending === controller) pending = undefined;
      if (signal.aborted || result.stopReason === "error" || result.stopReason === "aborted"
        || progress.failed || !progress.completed || !progress.inputPrepared)
        throw new Error("Codex did not complete exactly one encrypted checkpoint");
      let history: Item[];
      if (responses) {
        if (!responsesHistory(compactedWindow)) throw new Error("Responses did not return a valid compacted window");
        history = compactedWindow;
      } else {
        if (items.length !== 1 || typeof items[0].encrypted_content !== "string" || !items[0].encrypted_content)
          throw new Error("Codex did not complete exactly one encrypted checkpoint");
        const { status: _status, ...compactionItem } = items[0];
        history = [...retainedUsers(retainedInput), compactionItem];
      }
      if (JSON.stringify(history).length > MAX_BYTES) throw new Error("Codex checkpoint too large");
      const finalRequest = await requestBinding(ctx, model, accounts);
      const finalCompactor = hybrid ? await codexRequest(ctx, model, accounts) : compactor;
      if (version !== generation || session !== ctx.sessionManager.getSessionId() || source !== sourceHash(ctx.sessionManager.getBranch())
        || modelHash !== hash(ctx.model) || authorized !== authority() || identity !== finalRequest.identity
        || !sameProvider(request, finalRequest)
        || compactor.identity !== finalCompactor.identity
        || !sameProvider(compactor, finalCompactor) || signal.aborted)
        throw new Error("Compaction source changed");
      const marker = `${MARKER}${randomUUID()}]`;
      const readFiles = [...event.preparation.fileOps.read];
      const modifiedFiles = [...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited])];
      return { compaction: { summary: marker, firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore, usage: result.usage,
        details: { readFiles, modifiedFiles, [KEY]: {
          version: 1, marker, binding: identity, scope: request.scope, history, ...(responses ? { protocol: "responses" as const } : {}),
          model: { provider: model.provider, modelId: model.id },
          ...(hybrid ? { codexBinding: compactor.identity } : {}),
        } satisfies Checkpoint } } };
    } catch (error) {
      pending?.abort(); pending = undefined;
      const reason = sanitize(error);
      diagnostic.failure = reason;
      diagnostic.message ??= reason;
      diagnostic.requestId = typeof diagnostic.requestId === "string" ? sanitize(diagnostic.requestId) : undefined;
      try { pi.appendEntry("metisCodexCompactionFailure", diagnostic); }
      catch { /* A journal write failure must still cancel compaction. */ }
      const service = ctx.model?.api === "openai-responses" ? "OpenAI Responses" : "Codex";
      if (!event.signal.aborted) try {
        const detail = [diagnostic.status && `HTTP ${diagnostic.status}`, diagnostic.requestId && `request ID ${diagnostic.requestId}`,
          diagnostic.message !== reason && diagnostic.message].filter(Boolean).join("; ");
        ctx.ui.notify(`${service} remote compaction cancelled: ${reason}${detail ? `; ${detail}` : ""}; history was preserved.`, "warning");
      } catch { /* UI teardown must not turn cancellation into native fallback. */ }
      // The runner swallows thrown handler errors; explicitly cancel so it never
      // falls through to a plaintext summary or aborts the entire agent turn.
      return { cancel: true };
    }
  });
}
