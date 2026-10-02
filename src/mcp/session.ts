import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { McpClient, StdioTransport, StreamableHttpTransport, McpSessionExpiredError, McpError, McpAuthRequiredError,
  type McpRequestOptions, type Tool, type McpTransport } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionContext, McpServerEntry } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { CatalogCache, emptyCatalog, type Catalog } from "./catalog.ts";
import { McpCredentials, createAuth } from "./auth.ts";
import { canonical, expandHome, resolveValues, serverCwd, type McpPolicy } from "./config.ts";

export class McpServerSession {
  catalog: Catalog = emptyCatalog();
  cached = false;
  closed = false;
  scope = "";
  state = "disconnected";
  error?: string;
  private key?: string;
  private client?: McpClient;
  private connecting?: McpClient;
  private opening?: Promise<McpClient>;
  private closing?: Promise<void>;
  private shutdownTask?: Promise<void>;
  private readonly closes = new WeakMap<McpClient, Promise<void>>();
  private readonly retiring = new Set<McpClient>();
  private readonly uses = new Map<McpClient, number>();
  private discovery = 0;
  private readonly lifetime = new AbortController();
  private active = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly credentials?: McpCredentials;
  private readonly auth?: ReturnType<typeof createAuth>;
  private lastFinished = Date.now();
  readonly entry: McpServerEntry;
  readonly cwd: string;
  private readonly policy: McpPolicy;
  private readonly cache: CatalogCache;
  private readonly context: () => ExtensionContext;
  private readonly changed: () => void;
  constructor(entry: McpServerEntry, cwd: string, agentDir: string,
    policy: McpPolicy, cache: CatalogCache,
    context: () => ExtensionContext, changed: () => void) {
    this.entry = entry; this.cwd = cwd; this.policy = policy; this.cache = cache;
    this.context = context; this.changed = changed;
    const config = entry.config;
    if ("url" in config && !config.auth && !Object.keys(config.headers ?? {}).some(key => key.toLowerCase() === "authorization")) {
      this.credentials = new McpCredentials(agentDir, entry);
      this.auth = createAuth(entry, this.credentials);
    }
  }
  private assertCurrent() {
    if (this.closed || this.lifetime.signal.aborted || this.context().cwd !== this.cwd ||
      (this.entry.scope === "project" && !this.context().isProjectTrusted())) throw new Error("MCP server is no longer active in this session");
  }
  private async identity(provider = true) {
    const config = this.entry.config;
    const authorization = this.credentials ? await this.credentials.load() :
      "url" in config && config.auth && provider ? await this.context().modelRegistry.getApiKeyForProvider(config.auth.provider) : undefined;
    let values: unknown;
    try { values = resolveValues("url" in config ? config.headers : config.env, false); }
    catch { values = "dynamic"; }
    const scope = createHash("sha256").update(canonical({ authorization, values, environment: process.env })).digest("hex");
    return { scope, key: this.cache.fingerprint(this.entry, this.cwd, this.context().isProjectTrusted(), authorization) };
  }
  async restore(): Promise<boolean> {
    const identity = await this.identity(false);
    this.assertCurrent();
    this.scope = identity.scope; this.key = identity.key;
    const catalog = this.cache.read(this.key);
    if (!catalog) return false;
    this.catalog = catalog; this.cached = true; this.changed();
    return true;
  }
  /** Before a model turn, remove directory data belonging to a previous OAuth login. */
  async authorizationChanged(): Promise<boolean> {
    if (!this.credentials) return false;
    const identity = await this.identity(false);
    this.assertCurrent();
    if (identity.scope === this.scope) return false;
    await this.suspend();
    this.catalog = emptyCatalog(); this.scope = identity.scope; this.key = identity.key;
    this.cached = false; this.changed();
    return true;
  }
  private scheduleIdle() {
    clearTimeout(this.timer);
    if (this.closed || this.active || !this.client || this.policy.keepAliveServers.includes(this.entry.name)) return;
    const remaining = this.policy.idleTimeoutSeconds * 1000 - (Date.now() - this.lastFinished);
    this.timer = setTimeout(() => {
      if (this.active || this.closed) return;
      if (!this.context().isIdle()) { this.lastFinished = Date.now(); this.scheduleIdle(); return; }
      void this.suspend().catch(() => {});
    }, Math.max(1, remaining));
    this.timer.unref();
  }
  private async lease<T>(signal: AbortSignal | undefined, fn: (options: McpRequestOptions) => Promise<T>): Promise<T> {
    this.assertCurrent(); signal?.throwIfAborted();
    this.active++; clearTimeout(this.timer);
    const ownedSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    try {
      const value = await fn({ signal: ownedSignal, timeoutMs: (this.entry.config.timeout ?? 60) * 1000 });
      this.assertCurrent(); ownedSignal.throwIfAborted(); return value;
    } finally { this.active--; this.lastFinished = Date.now(); this.scheduleIdle(); }
  }
  private async getClient(): Promise<McpClient> {
    this.assertCurrent();
    await this.closing;
    this.assertCurrent();
    if (this.opening) return this.opening;
    const identity = await this.identity();
    this.assertCurrent();
    if (this.client && identity.scope !== this.scope) await this.suspend();
    await this.closing;
    this.assertCurrent();
    if (this.opening) return this.opening;
    if (this.client?.connectionState === "connected") return this.client;
    const opening = this.open();
    this.opening = opening;
    try { return await opening; }
    finally { if (this.opening === opening) this.opening = undefined; }
  }
  private async open(): Promise<McpClient> {
    const config = this.entry.config;
    const client = new McpClient({ name: "pi", version: "1.0.0", requestTimeoutMs: (config.timeout ?? 60) * 1000,
      roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }] });
    this.connecting = client; this.state = "connecting";
    const abort = () => { void this.closeClient(client).catch(() => {}); };
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    let ready = false, directoryChanged = false, refreshing = false;
    const refresh = () => {
      directoryChanged = true;
      if (!ready || refreshing) return;
      refreshing = true;
      void (async () => {
        try {
          while (directoryChanged && !this.closed && this.client === client) {
            directoryChanged = false; await this.discover();
          }
        } catch { /* Discovery errors are reflected by the session; a later notification can retry. */ }
        finally { refreshing = false; }
      })();
    };
    client.onNotification("notifications/tools/list_changed", refresh);
    client.onNotification("notifications/resources/list_changed", refresh);
    client.onClose(() => {
      if (this.client !== client) return;
      this.client = undefined; this.cached = true; this.state = "disconnected"; this.changed();
    });
    let transport: McpTransport | undefined;
    try {
      transport = "url" in config ? new StreamableHttpTransport({ url: config.url, headers: resolveValues(config.headers),
        authProvider: this.auth ?? (config.auth ? { token: () => this.context().modelRegistry.getApiKeyForProvider(config.auth!.provider) } : undefined) }) :
        new StdioTransport({ command: expandHome(config.command), args: config.args?.map(expandHome),
          cwd: serverCwd(this.entry, this.cwd), env: resolveValues(config.env), stderr: "pipe" });
      await client.connect(transport);
      this.assertCurrent();
      this.client = client;
      directoryChanged = false; await this.updateCatalog(client);
      if (directoryChanged) { directoryChanged = false; await this.updateCatalog(client); }
      this.assertCurrent();
      ready = true;
      if (directoryChanged) refresh();
      this.state = "connected"; this.error = undefined;
      this.scheduleIdle();
      return client;
    } catch (error) {
      if (this.client === client) this.client = undefined;
      await this.closeClient(client).catch(() => {});
      this.state = this.closed ? "closed" : error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError ? "needs-auth" : "failed";
      this.error = this.state === "needs-auth" ? `Sign in with pi mcp login ${this.entry.name}` : `MCP ${this.entry.name}: ${(error as Error).message}`;
      this.changed(); throw new Error(this.error);
    } finally { if (this.connecting === client) this.connecting = undefined; this.lifetime.signal.removeEventListener("abort", abort); }
  }
  private async updateCatalog(client: McpClient) {
    const revision = ++this.discovery;
    const before = await this.identity();
    const observedAt = Date.now();
    const options = { signal: this.lifetime.signal };
    const hasResources = Boolean(client.serverCapabilities?.resources);
    const [tools, resources, resourceTemplates] = await Promise.all([
      client.serverCapabilities?.tools ? client.listTools(options) : [],
      hasResources ? client.listResources(options) : [],
      hasResources ? client.listResourceTemplates(options).catch(error => {
        if (error instanceof McpError && error.code === -32601) return []; throw error;
      }) : [],
    ]);
    const identity = await this.identity();
    this.assertCurrent();
    if (this.client !== client) throw new Error("MCP connection changed while discovering tools");
    if (revision !== this.discovery) return;
    if (before.scope !== identity.scope) throw new Error("MCP authorization or environment changed during discovery; refresh the directory");
    this.catalog = { tools, resources, resourceTemplates, hasResources, instructions: client.instructions };
    this.scope = identity.scope; this.key = identity.key; this.cached = false; this.changed();
    await this.cache.write(this.key, this.catalog, observedAt, () => !this.closed && this.client === client && this.scope === identity.scope && this.discovery === revision);
  }
  async discover(suspend = false): Promise<void> {
    await this.lease(undefined, async () => {
      const hadClient = Boolean(this.client);
      const client = await this.getClient();
      if (hadClient) await this.updateCatalog(client);
    });
    if (suspend && !this.active && !this.policy.keepAliveServers.includes(this.entry.name)) await this.suspend();
  }
  private async request<T>(options: McpRequestOptions, fn: (client: McpClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await waitFor(this.getClient(), options.signal!);
      options.signal?.throwIfAborted();
      this.uses.set(client, (this.uses.get(client) ?? 0) + 1);
      try { return await fn(client); }
      catch (error) {
        if (error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError) {
          await this.suspend(); this.catalog = emptyCatalog(); this.cached = false; this.state = "needs-auth";
          this.error = `Sign in with pi mcp login ${this.entry.name}`; this.changed(); throw new Error(this.error);
        }
        if (!(error instanceof McpSessionExpiredError) || attempt > 0) throw error;
        if (this.client === client) this.client = undefined;
        // Do not fail other requests sharing the expired session. Its owner closes it at shutdown.
        this.retiring.add(client);
      } finally {
        const remaining = (this.uses.get(client) ?? 1) - 1;
        if (remaining) this.uses.set(client, remaining);
        else {
          this.uses.delete(client);
          if (this.retiring.has(client)) void this.closeClient(client).catch(() => {}).finally(() => this.retiring.delete(client));
        }
      }
    }
  }
  async callTool(tool: Tool, scope: string, args: Record<string, unknown>, options: McpRequestOptions) {
    return this.lease(options.signal, owned => this.request(owned, async client => {
      const live = this.catalog.tools.find(candidate => candidate.name === tool.name);
      if (!live || scope !== this.scope || canonical(live.inputSchema) !== canonical(tool.inputSchema) ||
        canonical(live.annotations) !== canonical(tool.annotations)) throw new Error("MCP directory changed; use the updated tool definition and retry");
      const validated = validateToolArguments({ name: live.name, description: live.description ?? "", parameters: live.inputSchema as TSchema },
        { type: "toolCall", id: "mcp-validation", name: live.name, arguments: args as JsonObject });
      return client.callTool(live.name, validated, { ...owned, onProgress: options.onProgress });
    }));
  }
  async resource(method: "resources/list" | "resources/templates/list" | "resources/read", params: Record<string, unknown>, signal?: AbortSignal) {
    return this.lease(signal, options => this.request<unknown>(options, client => method === "resources/list" ? client.listResourcesPage(params.cursor as string | undefined, options) :
      method === "resources/templates/list" ? client.listResourceTemplatesPage(params.cursor as string | undefined, options).catch(error => {
        if (error instanceof McpError && error.code === -32601) return { resourceTemplates: [] }; throw error;
      }) : client.readResource(params.uri as string, options)));
  }
  async suspend(): Promise<void> {
    if (this.closing) return this.closing;
    clearTimeout(this.timer);
    const client = this.client; this.client = undefined;
    this.cached = true;
    if (!this.closed) this.state = "disconnected";
    this.changed();
    const close = client ? this.closeClient(client) : Promise.resolve();
    this.closing = close;
    try { await close; } finally { if (this.closing === close) this.closing = undefined; }
  }
  private closeClient(client: McpClient): Promise<void> {
    let close = this.closes.get(client);
    if (!close) { close = Promise.resolve().then(() => client.close()); this.closes.set(client, close); }
    return close;
  }
  shutdown(): Promise<void> {
    return this.shutdownTask ??= this.closeSession();
  }
  private async closeSession(): Promise<void> {
    this.closed = true; clearTimeout(this.timer); this.lifetime.abort();
    const pending = this.opening;
    await Promise.allSettled([this.suspend(), this.connecting && this.closeClient(this.connecting), ...[...this.retiring].map(client => this.closeClient(client)), this.auth?.settled(), pending]);
    this.retiring.clear(); this.state = "closed";
  }
}
async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
