import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { isModelType, type Credential, type Model, type ModelsStoreEntry, type OAuthCredential,
  type Provider } from "@earendil-works/pi-ai";
import { buildAccountModels, catalogRecord, isStoredModel, readManifest, type ResponsesApi } from "./catalog.ts";

type AccountCatalog = { scope: string; models: Model<ResponsesApi>[]; checkedAt: number };
type CatalogStore = ModelsStoreEntry & { metisAccountCatalog?: AccountCatalog };
const REFRESH_INTERVAL_MS = 60_000;
const exec = promisify(execFile);

async function runCodex(command: "version" | "models", signal: AbortSignal): Promise<string | undefined> {
  // All arguments are literals, including when invoking a Windows npm shim.
  const args = command === "version" ? ["--version"] : ["debug", "models"];
  const executable = process.platform === "win32" ? "cmd.exe" : "codex";
  const argv = process.platform === "win32" ? ["/d", "/c", "codex", ...args] : args;
  try {
    const { stdout } = await exec(executable, argv, {
      cwd: homedir(), signal, timeout: 5_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    return stdout;
  } catch {
    // Missing binary, timeout or unsupported debug subcommand leaves the row unresolved.
    return undefined;
  }
}

async function localManifest(signal: AbortSignal) {
  const output = await runCodex("models", signal);
  if (!output) return;
  try { return readManifest(JSON.parse(output)); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

const digest = (parts: readonly unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function scopeOf(credential: Credential | undefined): string | undefined {
  if (credential?.type !== "oauth") return;
  // Mirror the SDK's OAuth binding: reject stale login metadata, and derive the
  // legacy ID that Pi preserves on the first managed token refresh.
  const binding = digest([credential.access, credential.refresh]);
  const session = catalogRecord(credential.authSession), id = session?.id;
  const verified = typeof id === "string" && id.length > 0 && id.length <= 256 && session?.credentialBinding === binding;
  return "login:" + digest([verified ? id : "legacy:" + binding, credential.accountId]);
}

function accountHeaders(credential: OAuthCredential, legacy: boolean): Headers | undefined {
  const headers = new Headers({ authorization: `Bearer ${credential.access}`, accept: "application/json" });
  if (!legacy) return headers;
  const accountId = credential.accountId;
  if (typeof accountId !== "string" || !accountId) return;
  headers.set("ChatGPT-Account-ID", accountId);
  return headers;
}

export function withAccountCatalog(base: Provider, api: ResponsesApi): Provider {
  const baseUrl = base.baseUrl;
  if (!baseUrl) return base;

  const route = { api, provider: base.id, baseUrl };
  const legacy = api === "openai-codex-responses";
  const fallback = () => base.getAllModels?.() ?? base.getModels();
  let codexVersion: string | undefined;
  let account: AccountCatalog | undefined;
  const hasDifferentScope = (credential: Credential | undefined) => account && scopeOf(credential) !== account.scope;

  return {
    ...base,
    refreshModelsAuth: "credential",
    getModels: () => account?.models ?? base.getModels(),
    getAllModels: () => account ? [...account.models, ...fallback().filter(model => !isModelType(model, "chat"))] : fallback(),
    filterModels: (models, credential) => {
      const list = hasDifferentScope(credential) ? base.getModels() : models;
      return base.filterModels?.(list, credential) ?? list;
    },
    filterAllModels: (models, credential) => {
      const list = hasDifferentScope(credential) ? fallback() : models;
      return base.filterAllModels?.(list, credential) ?? list;
    },
    async refreshModels(context) {
      const { signal } = context;
      const stockRoute = context.baseUrl?.replace(/\/$/, "") === baseUrl;
      const credential = stockRoute && context.credential?.type === "oauth" ? context.credential : undefined;
      const scope = scopeOf(credential);
      const cached = catalogRecord(catalogRecord(context.stored)?.metisAccountCatalog);
      let restored = account?.scope === scope ? account : undefined;
      // Older records still require the original token and account.
      if (credential && scope && cached
          && (cached.scope === scope || cached.scope === digest([credential.access, credential.accountId]))
          && typeof cached.checkedAt === "number"
          && (!restored || cached.checkedAt > restored.checkedAt)
          && Array.isArray(cached.models) && cached.models.every(model => isStoredModel(model, route))) {
        restored = { scope, checkedAt: cached.checkedAt, models: cached.models };
      }
      if (restored !== account && !(await context.publish({ update: () => { account = restored; } }))) return;
      if (!context.allowNetwork || !scope || !credential) {
        await base.refreshModels?.(context);
        return;
      }
      if (!context.force && account && Date.now() - account.checkedAt < REFRESH_INTERVAL_MS) return;

      const headers = accountHeaders(credential, legacy);
      if (!headers) return;
      const url = new URL(legacy ? `${baseUrl}/codex/models` : `${baseUrl}/models`);
      if (legacy) {
        codexVersion ??= (await runCodex("version", signal))?.match(/\bcodex-cli (\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1];
        if (!codexVersion) return;
        url.searchParams.set("client_version", codexVersion);
      }
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      const response = await fetch(url, { headers, signal: deadline, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`OpenAI account catalog returned HTTP ${response.status}`);
      }
      const manifest = readManifest(await response.json());
      if (!manifest) throw new Error("Invalid OpenAI account catalog");
      const known = base.getModels().filter((model): model is Model<ResponsesApi> => model.api === api);
      const models = await buildAccountModels(manifest, known, route, () => localManifest(signal));
      if (!models.length && manifest.some(row => row.visibility === "list")) return;

      // Keep Pi's public catalog in its usual field so stock Pi and API-key
      // sessions can still restore it. The OAuth inventory has its own scope.
      const next = { scope, models, checkedAt: Date.now() };
      const persist: CatalogStore = { ...context.stored, models: context.stored?.models ?? [], metisAccountCatalog: next };
      await context.publish({ persist, update: () => { account = next; } });
    },
  };
}
