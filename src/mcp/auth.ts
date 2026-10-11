// Native credential keys/locking/refresh semantics: Pi 1.0.0, MIT. See NOTICE.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import { authorizeMcp, McpOAuthProvider, McpOAuthAuthorizationRequiredError, parseWwwAuthenticate,
  type McpOAuthState, type McpOAuthStateStore, type OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import type { McpServerEntry } from "@earendil-works/pi-coding-agent";
import { canonical, isRecord, mcpNamespace, resolveValue } from "./config.ts";

export class McpCredentials {
  readonly path: string;
  readonly key: string;
  private readonly url: string;
  readonly agentDir: string;
  constructor(agentDir: string, entry: McpServerEntry) {
    this.agentDir = agentDir;
    if (!("url" in entry.config)) throw new Error("OAuth requires HTTP");
    this.url = String(new URL(entry.config.url));
    this.key = `${mcpNamespace(entry.name)}|${this.url}`;
    this.path = join(agentDir, "mcp-auth.json");
  }
  private async locked<T>(fn: (states: Record<string, McpOAuthState>) => { value: T; write?: boolean }): Promise<T> {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    let compromised = false;
    const release = await lockfile.lock(this.path, { realpath: false, stale: 30_000,
      retries: { retries: 15, minTimeout: 10, maxTimeout: 2_000 }, onCompromised: () => { compromised = true; } });
    let temp: string | undefined;
    try {
      let raw: unknown = {};
      try {
        raw = JSON.parse(readFileSync(this.path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Cannot read mcp-auth.json; credentials were not changed");
      }
      if (!isRecord(raw)) throw new Error("Invalid mcp-auth.json; credentials were not changed");
      const { value, write } = fn(raw as Record<string, McpOAuthState>);
      if (compromised) throw new Error("MCP credential lock was lost");
      if (write) {
        temp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        writeFileSync(temp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
        renameSync(temp, this.path);
      }
      return value;
    } finally { if (temp) rmSync(temp, { force: true }); await release(); }
  }
  async load(): Promise<McpOAuthState | undefined> {
    return this.locked(states => {
      // Pi 1.0.0 itself claims URL-keyed state for the first named server.
      const take = !states[this.key] && Boolean(states[this.url]);
      if (take) { states[this.key] = states[this.url]; delete states[this.url]; }
      const value = states[this.key];
      if (value && (!isRecord(value) || value.serverUrl !== this.url)) throw new Error("Invalid MCP authorization state");
      return { value, write: take };
    });
  }
  async refresh<T>(fn: (store: McpOAuthStateStore, state: McpOAuthState | undefined) => Promise<T>): Promise<T> {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update(this.key).digest("hex").slice(0, 16);
    let compromised = false;
    const release = await lockfile.lock(join(this.agentDir, `mcp-auth-refresh-${hash}`), { realpath: false,
      stale: 20_000, retries: { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: () => { compromised = true; } });
    try {
      const state = await this.load();
      let expected = canonical(state);
      const store: McpOAuthStateStore = {
        load: () => this.load(),
        save: async next => {
          await this.locked(states => {
            if (compromised || canonical(states[this.key]) !== expected)
              throw new Error("MCP authorization changed while refreshing; retry with the current login");
            states[this.key] = next;
            expected = canonical(next);
            return { value: undefined, write: true };
          });
        },
      };
      return await fn(store, state);
    } finally { await release(); }
  }
}

export function createAuth(entry: McpServerEntry, credentials: McpCredentials) {
  if (!("url" in entry.config)) throw new Error("OAuth requires HTTP");
  const config = entry.config;
  let refreshing: Promise<void> | undefined;
  const refresh = (staleToken: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) => {
    refreshing ??= credentials.refresh(async (store, state) => {
      if (state?.tokens?.access_token !== staleToken) return;
      if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
      const settings = config.oauth;
      const client = state.clientInformation;
      const registered = client && "redirect_uris" in client ? client.redirect_uris?.[0] : undefined;
      const provider = new McpOAuthProvider({ serverUrl: config.url,
        redirectUrl: settings?.callbackUrl ?? registered ?? "http://127.0.0.1/callback",
        clientMetadata: { client_name: settings?.clientName ?? "pi" }, clientId: settings?.clientId,
        clientSecret: settings?.clientSecret === undefined ? undefined : resolveValue(settings.clientSecret, "oauth.clientSecret"),
        store, onRedirect: () => {} });
      const result = await authorizeMcp(provider, { serverUrl: config.url,
        resourceMetadataUrl: challenge?.resourceMetadataUrl,
        authorizationServerMetadataUrl: settings?.authServerMetadataUrl ? new URL(settings.authServerMetadataUrl) : undefined,
        scope: challenge?.scope,
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) });
      if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  };
  return {
    async token() {
      await refreshing?.catch(() => {});
      const state = await credentials.load();
      if (state?.tokensExpireAt !== undefined && state.tokensExpireAt - 30_000 <= Date.now() && state.tokens?.refresh_token) {
        await refresh(state.tokens.access_token).catch(() => {});
        return (await credentials.load())?.tokens?.access_token;
      }
      return state?.tokens?.access_token;
    },
    async onUnauthorized(context) {
      const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
      if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
      await refresh(context.token, context.fetch, challenge);
    },
    async settled() { await refreshing?.catch(() => {}); },
  } satisfies AuthProvider & { settled(): Promise<void> };
}
