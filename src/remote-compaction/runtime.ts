import { createHash, randomUUID } from "node:crypto";
import { branchEntryReferences, readHistoryEntries, reverseBranchEntryReferences } from "../session-history.ts";
import {
  cleanupSessionResources, getCurrentSystemMessage, normalizeContext,
  type Model, type Api, type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  buildSessionProjection, convertToLlm, estimateTokens,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  METIS_EVENTS, isCodexCompactionOwnerRequest,
  type CodexCompactionOwnerRequest, type BeforeRemoteCompactRequest, type CondenseProjectRequest,
  type GoalProjectRequest,
} from "../collaboration.ts";
import {
  KEY, MARKER, MAX_BYTES, record, digest, ours, checkpoint, rawBranch,
  summaryText, matchesMarker, replaceMarker, responsesHistory,
  type Item, type Checkpoint,
} from "./checkpoint.ts";

import {
  bindingState, codexRequest, matchesLegacyBinding, requestChange, resolveRequest, safeError, sameRoute, scopeState,
} from "./auth.ts";

const TIMEOUT = 300_000;
const PORTABLE = "metisCodexPortableSummary";
const MAX_SUMMARY_BYTES = 64 * 1024;
const isPortableSummary = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && !value.trimStart().startsWith(MARKER) && Buffer.byteLength(value) <= MAX_SUMMARY_BYTES;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Native entries are append-only: the last source entry identifies its ancestry, excluding extension journals.
const sourceVersion = ({ sessionManager }: ExtensionContext) => {
  for (const entry of reverseBranchEntryReferences(sessionManager)) {
    if (entry.type === "message" || entry.type === "context_edit" || entry.type === "compaction" || entry.type === "branch_summary")
      return entry.id;
  }
};
function isRemoteModel(model: ExtensionContext["model"]): model is Model<Api>;
function isRemoteModel(model: CodexCompactionOwnerRequest["model"]): boolean;
function isRemoteModel(model: CodexCompactionOwnerRequest["model"]): boolean {
  return (model?.api === "openai-codex-responses" || model?.api === "openai-responses")
    && (model.provider === "openai" || model.provider === "openai-codex");
}

function active(ctx: { sessionManager: CodexCompactionOwnerRequest["sessionManager"] }) {
  const projection = ctx.sessionManager.buildSessionProjection();
  const wrapper = projection.entries.find(e => e.sourceEntry.type === "compaction" && e.messages.length);
  const entry = wrapper?.sourceEntry;
  if (!entry || !ours(entry)) return;
  const data = checkpoint(entry);
  // A context edit of the summary invalidates its opaque history.
  const message = wrapper.messages.find(m => m.role === "compactionSummary");
  const branch = branchEntryReferences(ctx.sessionManager);
  const covered = new Set(branch.slice(0, branch.findIndex(e => e.id === entry.firstKeptEntryId)).map(e => e.id));
  const entryIndex = branch.findIndex(e => e.id === entry.id);
  const edited = branch.slice(entryIndex + 1).some(e => e.type === "context_edit" && covered.has(e.targetId));
  const origin = branch.slice(0, entryIndex).findLast(e => e.type === "model_change");
  return { entry, origin: origin?.type === "model_change" ? origin : undefined,
    data: !edited && message?.role === "compactionSummary" && message.summary === entry.summary ? data : undefined };
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

async function capturePayload(request: Awaited<ReturnType<typeof resolveRequest>>, context: ReturnType<typeof normalizeContext>,
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

async function authoredUserInput(request: Awaited<ReturnType<typeof resolveRequest>>,
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
  // maxTokens is an output ceiling, not a mandatory reservation. Pi/provider
  // owns per-request output clamping and overflow recovery; we guard visible input.
  const inputBudget = (messages: Parameters<typeof convertToLlm>[0], ctx: ExtensionContext,
    subject: string, additionalInputTokens = 0) => {
    const system = getCurrentSystemMessage(messages);
    const overhead = system ? 0 : Math.ceil((ctx.getSystemPrompt().length
      + JSON.stringify(pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name))).length) / 4);
    const inputTokensEstimate = messages.reduce((n, m) => n + estimateTokens(m), overhead) + additionalInputTokens;
    const window = ctx.model?.contextWindow;
    return { inputTokensEstimate, inputWindow: window,
      error: window && inputTokensEstimate > window
        ? `${subject} needs approximately ${inputTokensEstimate} input tokens; context window is ${window}`
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
  pi.on("session_start", () => { invalidate(); subscribeOwner(); });
  pi.on("session_tree", invalidate);
  pi.on("model_select", invalidate);
  pi.on("session_shutdown", () => { invalidate(); unsubscribeOwner?.(); });
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
    const entries = [...readHistoryEntries(ctx.sessionManager, "branch", entry => entry.type === "custom" && entry.customType === PORTABLE)];
    const entry = entries.findLast(entry => entry.type === "custom"
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
      const version = generation, session = ctx.sessionManager.getSessionId(), source = sourceVersion(ctx);
      const sourceUnchanged = () => version === generation && session === ctx.sessionManager.getSessionId()
        && source === sourceVersion(ctx);
      const origin = data.model ?? current.origin;
      const model = origin && ctx.modelRegistry.find(origin.provider, origin.modelId);
      if (!model || !isRemoteModel(model)) throw new Error("Original checkpoint model is unavailable; restore its provider before retrying");
      const request = await resolveRequest(ctx, model);
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
        const final = await resolveRequest(ctx, model);
        if (signal.aborted || !sourceUnchanged())
          throw new Error("Portable summary source changed; retry with the current session");
        const change = requestChange(request, final);
        if (change) throw new Error(`Portable summary authentication changed: ${change}`);
        pi.appendEntry(PORTABLE, { checkpoint: current.entry.id, fingerprint: portableHash(current), summary, usage: result.usage });
      } finally {
        if (pending === controller) pending = undefined;
      }
    }
    const branch = (await ctx.sessionManager.getBranchAsync(undefined, { signal: operationSignal })).map(entry =>
      entry.id === current.entry.id && entry.type === "compaction"
      ? { ...entry, summary } : entry);
    return { summary, projection: buildSessionProjection(branch) };
  };

  // Keep opaque checkpoints on their original route. Other models use a durable
  // text summary of that same boundary, never the uncompressed source ledger.
  pi.on("context", async (_event, ctx) => {
    preparedModel = ctx.model ? { ...ctx.model } : undefined;
    preparedSession = ctx.sessionManager.getSessionId();
    preparedGeneration = generation;
    preparedMarker = undefined;
    preparedPortable = undefined;
    requestCancelled = false;
    preparedSource = undefined;
    const current = active(ctx);
    if (!current) return;
    // Only owned checkpoints need raw-source verification. Native history,
    // boundaries and edits determine recovery; extension journals and summary
    // messages may legitimately be published by this request's context hooks.
    preparedSource = sourceVersion(ctx);
    if (current.data && isRemoteModel(ctx.model)) {
      try {
        const state = bindingState(current.data, await resolveRequest(ctx, ctx.model), current.origin);
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
        const reason = inputBudget(messages, ctx, "Portable checkpoint context").error;
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
        || preparedSource !== sourceVersion(ctx)
        || !current || savedPortable(current, ctx) !== preparedPortable) {
        cancelRequest(ctx); return emptyPayload(event.payload);
      }
      return;
    }
    // Only an exact carrier prepared from a real checkpoint is ours. Ordinary
    // source code, user text and tool output can contain the same marker literal.
    if (!preparedMarker) return;
    const requestModel = preparedModel ?? ctx.model;
    const session = preparedSession, version = preparedGeneration;
    const source = sourceVersion(ctx);
    if (!isRemoteModel(requestModel)
      || session !== ctx.sessionManager.getSessionId() || version !== generation
      || !sameRoute(requestModel, ctx.model) || preparedSource !== source) {
      cancelRequest(ctx); return emptyPayload(event.payload);
    }
    const expected = summaryText(preparedMarker);
    const input = record(event.payload).input;
    if (!Array.isArray(input) || !input.some(item => matchesMarker(record(item), expected))) {
      cancelRequest(ctx, "Remote checkpoint carrier changed. Retry with the current context; history was preserved.");
      return emptyPayload(event.payload);
    }
    const current = active(ctx);
    if (!current?.data) { cancelRequest(ctx); return emptyPayload(event.payload); }
    try {
      const request = await resolveRequest(ctx, requestModel);
      // Authentication may yield to history edits, appends or session/model
      // switches. Revalidate the native source version and use the same ordinary
      // cancellation path as before await, rather than an authentication error.
      if (session !== ctx.sessionManager.getSessionId() || version !== generation || !sameRoute(requestModel, ctx.model)
        || bindingState(current.data, request, current.origin) !== "valid"
        || source !== sourceVersion(ctx)) {
        cancelRequest(ctx); return emptyPayload(event.payload);
      }
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
      const previous = active(ctx);
      if (!remote && !previous) return;
      const waits: Promise<void>[] = [];
      pi.events.emit(METIS_EVENTS.beforeRemoteCompact, { waits, signal: event.signal } satisfies BeforeRemoteCompactRequest);
      await Promise.all(waits);
      const version = generation, model = ctx.model;
      const session = ctx.sessionManager.getSessionId(), source = sourceVersion(ctx);
      const request = remote && model ? await resolveRequest(ctx, model) : undefined;
      if (request?.auth.apiKey) secrets.push(request.auth.apiKey);
      const hybrid = model?.provider === "openai" && model.api === "openai-responses"
        && request?.scope.credential === "oauth";
      const compactor = hybrid ? await codexRequest(ctx, model) : request;
      if (compactor?.auth.apiKey) secrets.push(compactor.auth.apiKey);
      diagnostic.compactorProvider = compactor?.model.provider;
      diagnostic.compactorApi = compactor?.model.api;
      const reusable = previous?.data && request && bindingState(previous.data, request, previous.origin) === "valid"
        && (!hybrid || compactor && (previous.data.codexScope
          ? scopeState(previous.data.codexScope, compactor.scope) === "valid"
          : matchesLegacyBinding(previous.data.codexBinding, compactor)));
      if (previous?.data && request && bindingState(previous.data, request, previous.origin) === "unverified"
        && !savedPortable(previous, ctx) && event.reason !== "manual")
        throw new Error("Remote checkpoint identity could not be verified; checkpoint was preserved. "
          + "Use /compact to rebuild it after checking authentication.");
      let projected: ReturnType<typeof buildSessionProjection>;
      let rebuilding = false;
      if (reusable || !previous) projected = await ctx.sessionManager.buildSessionProjectionAsync({ signal: event.signal });
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
          const restored = await ctx.sessionManager.getBranchAsync(undefined, { signal: event.signal });
          projected = buildSessionProjection(rawBranch(restored));
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
      // This is a local visible-prefix estimate, not provider tokenization.
      // Opaque checkpoint contents are unknown; never count ciphertext as text.
      const budget = inputBudget(prefix, ctx,
        rebuilding ? "Restored history" : previous && !reusable ? "Portable checkpoint context" : "Projected compaction input",
        Math.ceil((event.customInstructions?.length ?? 0) / 4));
      Object.assign(diagnostic, { projectedInputTokensEstimate: budget.inputTokensEstimate,
        inputWindow: budget.inputWindow, outputReserve: 0, hasOpaqueCheckpoint: Boolean(reusable) });
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
      if (!isRemoteModel(model) || !request || !compactor) throw new Error("Unsupported Codex API");
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
      const finalRequest = await resolveRequest(ctx, model);
      const finalCompactor = hybrid ? await codexRequest(ctx, model) : compactor;
      if (signal.aborted) throw new Error("Compaction was cancelled");
      if (version !== generation) throw new Error("Compaction lifecycle changed");
      if (session !== ctx.sessionManager.getSessionId()) throw new Error("Compaction session changed");
      if (source !== sourceVersion(ctx)) throw new Error("Compaction history changed");
      const change = requestChange(request, finalRequest);
      if (change) throw new Error(`Compaction authentication changed: ${change}`);
      const producerChange = requestChange(compactor, finalCompactor);
      if (producerChange) throw new Error(`Compaction producer changed: ${producerChange}`);
      const marker = `${MARKER}${randomUUID()}]`;
      const readFiles = [...event.preparation.fileOps.read];
      const modifiedFiles = [...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited])];
      return { compaction: { summary: marker, firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore, usage: result.usage,
        details: { readFiles, modifiedFiles, [KEY]: {
          version: 2, marker, scope: request.scope, history, ...(responses ? { protocol: "responses" as const } : {}),
          model: { provider: model.provider, modelId: model.id },
          ...(hybrid ? { codexScope: compactor.scope } : {}),
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
