import { createHash, randomUUID } from "node:crypto";
import { getCurrentSystemMessage, normalizeContext, type Model, type Api } from "@earendil-works/pi-ai";
import {
  buildSessionProjection, convertToLlm, estimateTokens,
  type ExtensionAPI, type ExtensionContext, type SessionEntry, type CompactionEntry,
} from "@earendil-works/pi-coding-agent";

const KEY = "metisCodexRemoteCompaction";
const MARKER = "[Metis Codex remote checkpoint ";
const TIMEOUT = 300_000;
const MAX_BYTES = 8 * 1024 * 1024;
type Item = Record<string, any>;
interface Checkpoint { version: 1; marker: string; binding: string; history: Item[] }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Item => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const ours = (entry: SessionEntry): entry is CompactionEntry => entry.type === "compaction" && entry.summary.startsWith(MARKER);

function checkpoint(entry: CompactionEntry): Checkpoint | undefined {
  const data = record(record(entry.details)[KEY]);
  if (data.version !== 1 || data.marker !== entry.summary || typeof data.binding !== "string" || !Array.isArray(data.history)) return;
  if (JSON.stringify(data.history).length > MAX_BYTES) return;
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
function active(ctx: ExtensionContext) {
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
async function requestBinding(ctx: ExtensionContext, model: Model<Api>) {
  const provider = ctx.modelRegistry.getProvider(model.provider);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error("Codex authentication unavailable");
  let account: unknown = auth.apiKey;
  try { account = JSON.parse(Buffer.from(auth.apiKey.split(".")[1], "base64url").toString())["https://api.openai.com/auth"]?.chatgpt_account_id ?? account; } catch { /* Non-JWT credentials remain account-bound by digest. */ }
  if (!provider) throw new Error("Unsupported Codex API");
  const accountHeader = Object.entries({ ...model.headers, ...auth.headers }).findLast(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1];
  const snapshot = { ...auth, headers: auth.headers ? { ...auth.headers } : undefined, env: auth.env ? { ...auth.env } : undefined };
  return { identity: hash([model.provider, model.api, model.id, auth.baseUrl ?? model.baseUrl, account, accountHeader]),
    provider, model: { ...model, headers: model.headers ? { ...model.headers } : undefined, baseUrl: auth.baseUrl ?? model.baseUrl }, auth: snapshot };
}
const binding = async (ctx: ExtensionContext, model: Model<Api>) => (await requestBinding(ctx, model)).identity;

function summaryText(marker: string): string {
  const message = convertToLlm([{ role: "compactionSummary", summary: marker, tokensBefore: 0, timestamp: 0 }])[0];
  return typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
}
function replaceMarker(payload: unknown, data: Checkpoint): Item {
  const body = record(payload);
  if (!Array.isArray(body.input)) throw new Error("Codex payload has no input");
  const expected = summaryText(data.marker);
  let matches = 0;
  const input = body.input.flatMap((item: Item) => {
    const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
      ? item.content.map((part: Item) => part.type === "input_text" ? part.text : "").join("") : undefined;
    if (item.role !== "user" || text !== expected) return [item];
    matches++; return data.history;
  });
  if (matches !== 1) throw new Error("Codex checkpoint marker missing or ambiguous");
  return { ...body, input };
}

async function authoredUserInput(request: Awaited<ReturnType<typeof requestBinding>>, messages: Parameters<typeof convertToLlm>[0], signal: AbortSignal): Promise<Item[]> {
  if (!messages.length) return [];
  let input: Item[] | undefined;
  // Serialize real source-entry users using the public provider, stopping before
  // transport. Generated custom/summary messages must not become user authority.
  await request.provider.streamSimple(request.model, normalizeContext({ messages: convertToLlm(messages) }), {
    apiKey: request.auth.apiKey, headers: request.auth.headers, env: request.auth.env,
    signal, transport: "sse", maxRetries: 0,
    onPayload(payload) {
      const body = record(payload);
      if (Array.isArray(body.input)) input = structuredClone(body.input.filter((item: unknown) => record(item).role === "user"));
      throw new Error("Offline authored-user capture complete");
    },
  }).result();
  if (!input) throw new Error("Codex provider did not expose native input");
  return input;
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
  let generation = 0;
  let pending: AbortController | undefined;
  let preparedModel: Model<Api> | undefined;
  let preparedSession: string | undefined;
  let preparedGeneration = 0;
  let unsubscribeOwner: (() => void) | undefined;
  const subscribeOwner = () => {
    unsubscribeOwner?.();
    unsubscribeOwner = pi.events.on("metis:codex-compaction-owner", value => {
      const request = value as { ctx: ExtensionContext; owns: boolean };
      request.owns = request.ctx.model?.provider === "openai-codex" || Boolean(active(request.ctx));
    });
  };
  subscribeOwner();
  const invalidate = () => { generation++; pending?.abort(); };
  pi.on("session_start", () => { invalidate(); subscribeOwner(); });
  pi.on("session_tree", invalidate);
  pi.on("model_select", invalidate);
  pi.on("session_shutdown", () => { invalidate(); unsubscribeOwner?.(); });
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_before_fork", invalidate);

  // A checkpoint is model/account bound, not a portable textual summary. Restore
  // the original canonical history for other routes, damaged metadata or edits.
  pi.on("context", async (_event, ctx) => {
    preparedModel = ctx.model ? { ...ctx.model } : undefined;
    preparedSession = ctx.sessionManager.getSessionId();
    preparedGeneration = generation;
    const current = active(ctx);
    if (!current) return;
    if (current.data && ctx.model?.provider === "openai-codex") {
      try { if (current.data.binding === await binding(ctx, ctx.model)) return; } catch { /* Restore instead of sending an opaque marker. */ }
    }
    return { messages: buildSessionProjection(rawBranch(ctx.sessionManager.getBranch())).messages.filter(m => m.role !== "system") };
  });
  pi.on("before_provider_request", async (event, ctx) => {
    // Detect the already-built carrier BEFORE checking current route/data: edits
    // or model changes may have invalidated it during asynchronous preparation.
    if (!JSON.stringify(event.payload).includes(MARKER)) return;
    const requestModel = preparedModel ?? ctx.model;
    if (!requestModel || requestModel.api !== "openai-codex-responses" || requestModel.provider !== "openai-codex"
      || preparedSession !== ctx.sessionManager.getSessionId() || preparedGeneration !== generation)
      return { ...record(event.payload), input: [{ type: "metis_checkpoint_route_changed" }] };
    const source = hash(ctx.sessionManager.getBranch());
    const current = active(ctx);
    try {
      if (!current?.data || preparedSession !== ctx.sessionManager.getSessionId() || hash(requestModel) !== hash(ctx.model)
        || current.data.binding !== await binding(ctx, requestModel)
        || source !== hash(ctx.sessionManager.getBranch())) throw new Error("Checkpoint binding changed");
      return replaceMarker(event.payload, current.data);
    } catch {
      if (preparedSession !== ctx.sessionManager.getSessionId() || preparedGeneration !== generation)
        return { ...record(event.payload), input: [{ type: "metis_checkpoint_route_changed" }] };
      // Payload-handler exceptions are swallowed by Pi. Build native raw input
      // offline rather than accidentally transmitting the placeholder.
      let rebuilt: Item | undefined;
      try {
        await ctx.modelRegistry.streamSimple(requestModel, normalizeContext({ messages: convertToLlm(buildSessionProjection(rawBranch(ctx.sessionManager.getBranch())).messages) }), {
          maxRetries: 0, transport: "sse",
          onPayload(body) { rebuilt = record(body); throw new Error("Offline raw-history capture complete"); },
        }).result();
      } catch { /* Controlled invalid input below fails closed, never sends the marker. */ }
      return { ...record(event.payload), input: rebuilt?.input ?? [{ type: "metis_checkpoint_recovery_failed" }] };
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const codex = ctx.model?.provider === "openai-codex";
    try {
      const previous = active(ctx);
      if (!codex && !previous) return;
      const waits: Promise<void>[] = [];
      pi.events.emit("metis:before-remote-compact", { waits, signal: event.signal });
      await Promise.all(waits);
      const version = generation, model = ctx.model;
      const modelHash = hash(model);
      const authority = () => hash([ctx.getSystemPrompt(), pi.getActiveTools(), pi.getAllTools()]);
      const authorized = authority();
      const branch = ctx.sessionManager.getBranch();
      const session = ctx.sessionManager.getSessionId(), source = hash(branch);
      const request = codex && model ? await requestBinding(ctx, model) : undefined;
      const identity = request?.identity;
      const reusable = previous?.data && previous.data.binding === identity;
      const projected = buildSessionProjection(reusable || !previous ? branch : rawBranch(branch));
      const cut = projected.entries.findIndex(e => e.sourceEntry.id === event.preparation.firstKeptEntryId);
      if (cut < 0) throw new Error("Compaction boundary is no longer visible");
      const prefix = projected.entries.slice(0, cut).flatMap(e => e.messages);
      const files = record(previous?.entry.details);
      for (const path of Array.isArray(files.readFiles) ? files.readFiles : []) if (typeof path === "string") event.preparation.fileOps.read.add(path);
      for (const path of Array.isArray(files.modifiedFiles) ? files.modifiedFiles : []) if (typeof path === "string") event.preparation.fileOps.edited.add(path);
      if (!codex) {
        // Pi will run its unchanged native summarizer, but over recoverable raw
        // history, not the opaque fallback marker from the Codex session.
        event.preparation.previousSummary = prefix.find(m => m.role === "compactionSummary")?.summary;
        event.preparation.messagesToSummarize = prefix.filter(m => m.role !== "system" && m.role !== "compactionSummary");
        event.preparation.turnPrefixMessages = [];
        event.preparation.isSplitTurn = false;
        event.preparation.tokensBefore = projected.messages.reduce((n, m) => n + estimateTokens(m), 0);
        return;
      }
      if (!model || model.api !== "openai-codex-responses" || !request || !identity) throw new Error("Unsupported Codex API");
      if (!prefix.some(m => m.role !== "system")) throw new Error("No discarded history to compact");
      pending?.abort(); const controller = new AbortController(); pending = controller;
      const signal = AbortSignal.any([event.signal, controller.signal, AbortSignal.timeout(TIMEOUT)]);
      let input: Item[] | undefined, completed = false, failed = false;
      const items: Item[] = []; let outputItems = 0;
      const messages = prefix.filter(m => m.role !== "system");
      const authored = projected.entries.slice(0, cut).flatMap(entry =>
        entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "user"
          ? entry.messages.filter(message => message.role === "user") : []);
      const retainedInput = [
        ...(reusable && previous?.data ? previous.data.history.slice(0, -1) : []),
        ...await authoredUserInput(request, authored, signal),
      ];
      const system = getCurrentSystemMessage(projected.messages);
      const context = normalizeContext(system
        ? { messages: convertToLlm([system, ...messages]) }
        : { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages), tools: pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)) });
      // Pin the resolved credential/route snapshot. A second broker resolution
      // could otherwise compact under account B but publish a binding for A.
      const result = await request.provider.streamSimple(request.model, context, {
        apiKey: request.auth.apiKey, env: request.auth.env,
        signal, transport: "sse", cacheRetention: "none", maxRetries: 2,
        sessionId: session, headers: { ...request.auth.headers, "x-codex-beta-features": "remote_compaction_v2" },
        onPayload(payload) {
          const body = reusable && previous?.data ? replaceMarker(payload, previous.data) : record(payload);
          if (!Array.isArray(body.input)) throw new Error("Codex provider did not expose native input");
          input = structuredClone(body.input);
          items.length = 0; outputItems = 0; completed = false; failed = false;
          return { ...body, instructions: event.customInstructions ? `${body.instructions ?? ""}\n\nCompaction focus: ${event.customInstructions}` : body.instructions,
            input: [...body.input, { type: "compaction_trigger" }], store: false, stream: true };
        },
        onProviderStreamEvent(value) {
          const data = record(value);
          if (data.type === "response.output_item.done") {
            const item = record(data.item);
            // Like OMP, only compaction items become durable replacement history.
            // Auxiliary reasoning/message outputs are not additional checkpoints.
            if (item.type === "compaction") {
              outputItems++;
              if (items.length === 0 && JSON.stringify(item).length <= MAX_BYTES) items.push(structuredClone(item));
              else failed = true;
            }
          }
          if (data.type === "response.completed" || data.type === "response.done") {
            completed = true;
            if (data.response?.status && data.response.status !== "completed") failed = true;
          }
          if (["response.failed", "response.incomplete", "error"].includes(data.type)) failed = true;
        },
      }).result();
      if (pending === controller) pending = undefined;
      if (signal.aborted || result.stopReason === "error" || result.stopReason === "aborted" || failed || !completed || !input
        || outputItems !== 1 || items.length !== 1 || typeof items[0].encrypted_content !== "string" || !items[0].encrypted_content)
        throw new Error("Codex did not complete exactly one encrypted checkpoint");
      const { status: _status, ...compactionItem } = items[0];
      const history = [...retainedUsers(retainedInput), compactionItem];
      if (JSON.stringify(history).length > MAX_BYTES) throw new Error("Codex checkpoint too large");
      const finalBinding = await binding(ctx, model);
      if (version !== generation || session !== ctx.sessionManager.getSessionId() || source !== hash(ctx.sessionManager.getBranch())
        || modelHash !== hash(ctx.model) || authorized !== authority() || identity !== finalBinding
        || request.provider !== ctx.modelRegistry.getProvider(model.provider) || signal.aborted)
        throw new Error("Compaction source changed");
      const marker = `${MARKER}${randomUUID()}]`;
      const readFiles = [...event.preparation.fileOps.read];
      const modifiedFiles = [...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited])];
      return { compaction: { summary: marker, firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore, usage: result.usage,
        details: { readFiles, modifiedFiles, [KEY]: { version: 1, marker, binding: identity, history } satisfies Checkpoint } } };
    } catch (error) {
      pending?.abort(); pending = undefined;
      const safeReasons = ["Codex authentication unavailable", "Compaction boundary is no longer visible", "Unsupported Codex API", "No discarded history to compact", "Codex provider did not expose native input", "Codex did not complete exactly one encrypted checkpoint", "Codex checkpoint too large", "Compaction source changed"];
      const reason = error instanceof Error && safeReasons.includes(error.message) ? error.message : "provider request failed";
      if (!event.signal.aborted) try { ctx.ui.notify(`Codex remote compaction cancelled: ${reason}; history was preserved. Check authentication/permissions and retry.`, "warning"); } catch { /* UI teardown must not turn cancellation into native fallback. */ }
      // The runner swallows thrown handler errors; explicitly cancel so it never
      // falls through to a plaintext summary or aborts the entire agent turn.
      return { cancel: true };
    }
  });
}
