import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cleanupSessionResources, getCurrentSystemMessage, normalizeContext,
  type Model, type Api, type OAuthAuth, type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  buildSessionProjection, convertToLlm, estimateTokens,
  type ExtensionAPI, type ExtensionContext, type SessionEntry, type CompactionEntry,
} from "@earendil-works/pi-coding-agent";
import { METIS_EVENTS, isCodexCompactionOwnerRequest, type CodexCompactionOwnerRequest, type BeforeRemoteCompactRequest } from "./collaboration.ts";

const KEY = "metisCodexRemoteCompaction";
const MARKER = "[Metis Codex remote checkpoint ";
const TIMEOUT = 300_000;
const MAX_BYTES = 8 * 1024 * 1024;
const OAUTH_IDENTITY = "metisCodexCheckpointIdentity";
type Item = Record<string, any>;
interface Checkpoint { version: 1; marker: string; binding: string; history: Item[]; protocol?: "responses"; codexBinding?: string }
type RequestAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceHash = (branch: SessionEntry[]) => hash(branch.filter(entry =>
  entry.type === "message" || entry.type === "context_edit" || entry.type === "compaction" || entry.type === "branch_summary"));
const record = (value: unknown): Item => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const ours = (entry: SessionEntry): entry is CompactionEntry => entry.type === "compaction"
  && (entry.fromHook === true || Object.hasOwn(record(entry.details), KEY))
  && entry.summary.startsWith(MARKER) && /^[\da-f-]{36}\]$/.test(entry.summary.slice(MARKER.length));

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
  if (data.version !== 1 || data.marker !== entry.summary || typeof data.binding !== "string" || !Array.isArray(data.history)) return;
  if (JSON.stringify(data.history).length > MAX_BYTES) return;
  if (data.protocol === "responses") return responsesHistory(data.history) ? data as Checkpoint : undefined;
  if (data.protocol !== undefined) return;
  const last = record(data.history.at(-1));
  if (last.type !== "compaction" || typeof last.encrypted_content !== "string" || !last.encrypted_content) return;
  if (!data.history.slice(0, -1).every((item: unknown) => record(item).role === "user" && (!record(item).type || record(item).type === "message"))) return;
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
  const entry = projection.entries.find(e => e.sourceEntry.type === "compaction" && e.messages.length)?.sourceEntry;
  if (!entry || !ours(entry)) return;
  const data = checkpoint(entry);
  // A context edit of the summary invalidates its opaque history.
  const message = projection.entries.find(e => e.sourceEntry.id === entry.id)?.messages.find(m => m.role === "compactionSummary");
  const branch = ctx.sessionManager.getBranch();
  const covered = new Set(branch.slice(0, branch.findIndex(e => e.id === entry.firstKeptEntryId)).map(e => e.id));
  const edited = branch.slice(branch.findIndex(e => e.id === entry.id) + 1).some(e => e.type === "context_edit" && covered.has(e.targetId));
  return { entry, data: !edited && message?.role === "compactionSummary" && message.summary === entry.summary ? data : undefined };
}
async function requestBinding(ctx: ExtensionContext, model: Model<Api>, accounts: Map<string, string>, resolvedAuth?: RequestAuth) {
  const provider = ctx.modelRegistry.getProvider(model.provider);
  const auth = resolvedAuth ?? await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error("Codex authentication unavailable");
  let account: unknown;
  try {
    account = JSON.parse(Buffer.from(auth.apiKey.split(".")[1], "base64url").toString())["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch { /* Non-JWT credentials remain account-bound by digest. */ }
  if (!provider) throw new Error("Unsupported Codex API");
  const accountHeader = Object.entries({ ...model.headers, ...auth.headers }).findLast(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1];
  const route = [model.provider, model.api, model.id, auth.baseUrl ?? model.baseUrl];
  const snapshot = { ...auth, headers: auth.headers ? { ...auth.headers } : undefined, env: auth.env ? { ...auth.env } : undefined };
  return { identity: hash([...route, account ?? accounts.get(hash(auth.apiKey)) ?? auth.apiKey, accountHeader]),
    legacyIdentity: hash([...route, account ?? auth.apiKey, accountHeader]),
    provider, model: { ...model, headers: model.headers ? { ...model.headers } : undefined, baseUrl: auth.baseUrl ?? model.baseUrl }, auth: snapshot };
}
const matchesBinding = (data: Checkpoint, request: Awaited<ReturnType<typeof requestBinding>>) =>
  data.binding === request.identity || data.binding === request.legacyIdentity;

async function codexRequest(ctx: ExtensionContext, model: Model<Api>, accounts: Map<string, string>) {
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
  const accounts = new Map<string, string>();
  const trackedOAuth = new Map<OAuthAuth, () => void>();
  const trackOAuth = (ctx: ExtensionContext) => {
    for (const id of ["openai", "openai-codex"]) {
      const oauth = ctx.modelRegistry.getProvider(id)?.auth.oauth;
      if (!oauth || trackedOAuth.has(oauth)) continue;
      const refresh = oauth.refresh, toAuth = oauth.toAuth;
      const identity = (credential: Record<string, unknown>) =>
        typeof credential[OAUTH_IDENTITY] === "string" && /^[a-f0-9]{64}$/.test(credential[OAUTH_IDENTITY])
          ? credential[OAUTH_IDENTITY] : hash(credential.access);
      // Only a successful refresh proves continuity of an opaque workspace grant.
      // Store its non-secret identity with Pi's credential so reloads retain it.
      const trackedRefresh: typeof refresh = async (credential, signal) => {
        const next = await refresh.call(oauth, credential, signal);
        return { ...next, [OAUTH_IDENTITY]: identity(credential) };
      };
      const trackedToAuth: typeof toAuth = async credential => {
        const resolved = await toAuth.call(oauth, credential);
        if (resolved.apiKey) {
          accounts.set(hash(resolved.apiKey), identity(credential));
          if (accounts.size > 16) accounts.delete(accounts.keys().next().value!);
        }
        return resolved;
      };
      // Observe this runtime's OAuth object, shared by its configured overlays.
      // Re-registering the provider would erase other extensions' configuration.
      oauth.refresh = trackedRefresh; oauth.toAuth = trackedToAuth;
      trackedOAuth.set(oauth, () => {
        if (oauth.refresh === trackedRefresh) oauth.refresh = refresh;
        if (oauth.toAuth === trackedToAuth) oauth.toAuth = toAuth;
      });
    }
  };
  const restorationError = (messages: Parameters<typeof convertToLlm>[0], ctx: ExtensionContext) => {
    const system = getCurrentSystemMessage(messages);
    const overhead = system ? 0 : Math.ceil((ctx.getSystemPrompt().length
      + JSON.stringify(pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name))).length) / 4);
    const tokens = messages.reduce((n, m) => n + estimateTokens(m), overhead) + (ctx.model?.maxTokens ?? 0);
    const window = ctx.model?.contextWindow;
    return window && tokens > window
      ? `Restored history needs approximately ${tokens} tokens including output reserve; context window is ${window}`
      : undefined;
  };
  let generation = 0;
  let pending: AbortController | undefined;
  let preparedModel: Model<Api> | undefined;
  let preparedSession: string | undefined;
  let preparedGeneration = 0;
  let preparedMarker: string | undefined;
  let preparedSource: string | undefined;
  let invalidatedMarker: string | undefined;
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
  pi.on("session_shutdown", () => {
    invalidate(); unsubscribeOwner?.();
    for (const release of trackedOAuth.values()) release();
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
    // A fresh request will recover raw history in the context phase and run
    // every domain/host projection; never rebuild only input at this stage.
    invalidatedMarker = preparedMarker;
    ctx.abort();
    if (preparedModel?.api === "openai-codex-responses" && preparedSession)
      cleanupSessionResources(preparedSession);
    pi.events.emit(METIS_EVENTS.checkpointRequestCancelled, {});
    try {
      ctx.ui.notify(reason, "warning");
    } catch { /* UI teardown cannot undo request cancellation. */ }
  };

  // A checkpoint is model/account bound, not a portable textual summary. Restore
  // the original canonical history for other routes, damaged metadata or edits.
  pi.on("context", async (_event, ctx) => {
    trackOAuth(ctx);
    preparedModel = ctx.model ? { ...ctx.model } : undefined;
    preparedSession = ctx.sessionManager.getSessionId();
    preparedGeneration = generation;
    preparedMarker = undefined;
    // Native history/boundaries/edits determine checkpoint recovery. Extension
    // journals and summary messages are projected by their own context hooks,
    // which may legitimately publish them while preparing this same request.
    preparedSource = sourceHash(ctx.sessionManager.getBranch());
    const current = active(ctx);
    if (!current) return;
    if (current.data && current.entry.summary !== invalidatedMarker && isRemoteModel(ctx.model)) {
      try {
        if (matchesBinding(current.data, await requestBinding(ctx, ctx.model, accounts))) {
          preparedMarker = current.entry.summary;
          return;
        }
      } catch { /* Restore instead of sending an opaque marker. */ }
    }
    const messages = buildSessionProjection(rawBranch(ctx.sessionManager.getBranch())).messages;
    const reason = restorationError(messages, ctx);
    if (reason) { cancelRequest(ctx, `${reason}. Request cancelled; history was preserved.`); return { messages: [] }; }
    return { messages: messages.filter(m => m.role !== "system") };
  });
  pi.on("before_provider_request", async (event, ctx) => {
    // Only an exact carrier prepared from a real checkpoint is ours. Ordinary
    // source code, user text and tool output can contain the same marker literal.
    if (!preparedMarker) return;
    const expected = summaryText(preparedMarker);
    const input = record(event.payload).input;
    if (!Array.isArray(input) || !input.some(item => matchesMarker(record(item), expected))) return;
    const requestModel = preparedModel ?? ctx.model;
    if (!isRemoteModel(requestModel)
      || preparedSession !== ctx.sessionManager.getSessionId() || preparedGeneration !== generation
      || preparedSource !== sourceHash(ctx.sessionManager.getBranch()))
      return cancelRequest(ctx);
    const source = sourceHash(ctx.sessionManager.getBranch());
    const current = active(ctx);
    try {
      if (!current?.data || preparedSession !== ctx.sessionManager.getSessionId() || hash(requestModel) !== hash(ctx.model)
        || !matchesBinding(current.data, await requestBinding(ctx, requestModel, accounts))
        || source !== sourceHash(ctx.sessionManager.getBranch())) throw new Error("Checkpoint binding changed");
      return replaceMarker(event.payload, current.data);
    } catch {
      return cancelRequest(ctx);
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const remote = isRemoteModel(ctx.model);
    const diagnostic: Item = { reason: event.reason, provider: ctx.model?.provider, api: ctx.model?.api };
    const secrets: string[] = [];
    const sanitize = (value: unknown) => {
      let text = typeof value === "string" ? value : value instanceof Error ? value.message : "provider request failed";
      for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
      return text.replace(/Bearer\s+[^\s";,]+/gi, "Bearer [redacted]")
        .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\b/g, "[redacted]")
        .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1500);
    };
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
      const session = ctx.sessionManager.getSessionId(), source = hash(branch);
      const request = remote && model ? await requestBinding(ctx, model, accounts) : undefined;
      if (request?.auth.apiKey) secrets.push(request.auth.apiKey);
      const identity = request?.identity;
      const hybrid = model?.provider === "openai" && model.api === "openai-responses"
        && ctx.modelRegistry.isUsingOAuth(model);
      const compactor = hybrid ? await codexRequest(ctx, model, accounts) : request;
      if (compactor?.auth.apiKey) secrets.push(compactor.auth.apiKey);
      diagnostic.compactorProvider = compactor?.model.provider;
      diagnostic.compactorApi = compactor?.model.api;
      const reusable = previous?.data && request && matchesBinding(previous.data, request)
        && (!hybrid || previous.data.codexBinding === compactor?.identity);
      const projected = buildSessionProjection(reusable || !previous ? branch : rawBranch(branch));
      const cut = projected.entries.findIndex(e => e.sourceEntry.id === event.preparation.firstKeptEntryId);
      if (cut < 0) throw new Error("Compaction boundary is no longer visible");
      const prefix = projected.entries.slice(0, cut).flatMap(e => e.messages);
      if (previous && !reusable) {
        const reason = restorationError(prefix, ctx);
        if (reason) throw new Error(reason);
      }
      const files = record(previous?.entry.details);
      for (const path of Array.isArray(files.readFiles) ? files.readFiles : []) if (typeof path === "string") event.preparation.fileOps.read.add(path);
      for (const path of Array.isArray(files.modifiedFiles) ? files.modifiedFiles : []) if (typeof path === "string") event.preparation.fileOps.edited.add(path);
      if (!remote) {
        // Pi will run its unchanged native summarizer, but over recoverable raw
        // history, not the opaque fallback marker from the Codex session.
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
        : { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages), tools: pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)) });
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
      const finalBinding = (await requestBinding(ctx, model, accounts)).identity;
      const finalCompactor = hybrid ? await codexRequest(ctx, model, accounts) : compactor;
      if (version !== generation || session !== ctx.sessionManager.getSessionId() || source !== hash(ctx.sessionManager.getBranch())
        || modelHash !== hash(ctx.model) || authorized !== authority() || identity !== finalBinding
        || request.provider !== ctx.modelRegistry.getProvider(model.provider)
        || compactor.identity !== finalCompactor.identity
        || compactor.provider !== ctx.modelRegistry.getProvider(compactor.model.provider) || signal.aborted)
        throw new Error("Compaction source changed");
      const marker = `${MARKER}${randomUUID()}]`;
      const readFiles = [...event.preparation.fileOps.read];
      const modifiedFiles = [...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited])];
      return { compaction: { summary: marker, firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore, usage: result.usage,
        details: { readFiles, modifiedFiles, [KEY]: {
          version: 1, marker, binding: identity, history, ...(responses ? { protocol: "responses" as const } : {}),
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
