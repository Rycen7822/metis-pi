import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerOcc } from "./occ.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { capImages, imageLimitFor } from "./image-cap.ts";
import { captureBatch, captureUnindexedBatchesFromSession, deriveLiveTurnIndex, groupBatchesByMode, projectBranchMessages } from "./batch-capture.ts";
import { ARGUMENT_HISTORY, argumentCandidates, projectArguments, type ArgumentHistory } from "./argument-history.ts";
import { prepareBatch } from "./packing.ts";
import { summarizeBatch, summarizeRange, summarizerInputBudget } from "./summarizer.ts";
import { FallbackController } from "./summarizer-fallback.ts";
import { ToolCallIndexer } from "./indexer.ts";
import { pruneMessages, toolResultStub } from "./pruner.ts";
import { isProtected } from "./protected.ts";
import { registerNestedCapture } from "./nested-capture.ts";
import { registerQueryTool } from "./query-tool.ts";
import { registerCommands, setPruneStatusWidget } from "./commands.ts";
import { formatSummaryToolCallRefs, makeSummaryDetails, normalizeSummaryToolCallRefs, substituteInlineRefs } from "./summary-refs.ts";
import type {
  ContextPruneConfig,
  CapturedBatch,
  PruneFrontier,
  FlushOptions,
  FlushResult,
  ContextMetricsSnapshot,
  FlushMetricsEntry,
  FlushTrigger,
  SingleChainCompressionEntry,
  SharedChainCompressionEntry,
} from "./types.ts";
import {
  DEFAULT_CONFIG,
  chainMembers, isSharedChain, CUSTOM_TYPE_CHAIN,
  CUSTOM_TYPE_SUMMARY,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_FRONTIER,
  CUSTOM_TYPE_FLUSH_METRICS,
  STATUS_WIDGET_ID,
} from "./types.ts";
import { computeContextMetrics } from "./context-metrics.ts";
import { StatsAccumulator, emitExternalCost } from "./stats.ts";
import { PruneFrontierTracker } from "./frontier.ts";
import { BlockRefIssuer } from "./block-refs.ts";
import { compressEligible, prepareSharedChain, selectEligible, findCompressibleRange, chainMatchesGrace, extractChainRecords } from "./chain-compressor.ts";
import { createSupersedeState, earliestChainStart, earliestResultTimestamp, lowerFloor } from "./supersede.ts";
import { detectChains, withClosingMessage } from "./chain-detector.ts";
import { inGraceRecoveryToolCallIds } from "./recovery-grace.ts";
import { shouldBudgetFlush, shouldDeltaFlush, shouldFrontierGapFlush, usageFraction } from "./budget.ts";
import { archiveBatches, archiveToolOutput, spillOversizedBatch } from "./spill.ts";
import { bareToolCallId, occKey } from "./occurrence-key.ts";
import { DiagnosticSink } from "./diagnostics.ts";
import { TokenEstimator, projectionFingerprint } from "./token-estimator.ts";
import { resolveRange, perBatchSummaryOverlapsDropped } from "./chain-range-prune.ts";

const EMPTY_METRICS_SNAPSHOT: ContextMetricsSnapshot = { openCycleThinkingTokens: 0, largestChainSharePct: 0, frontierGapTokens: 0 };

export function createCondenseRuntime(pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /pruner commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { ...DEFAULT_CONFIG },
  };

  const effectiveProtection = () => currentConfig.value.opportunisticCompaction
    ? { ...currentConfig.value, protectedTools: [...currentConfig.value.protectedTools, "context_tree_query"] }
    : currentConfig.value;
  const protectionPredicate = (name: string, args: unknown) => isProtected(name, args, effectiveProtection());

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();
  const resetNested = registerNestedCapture(pi, indexer, protectionPredicate);
  let argumentHistory: ArgumentHistory[] = [];
  const restoreArguments = (ctx: ExtensionContext) => {
    argumentHistory = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === ARGUMENT_HISTORY)
      .map(entry => (entry as any).data as ArgumentHistory)
      .filter(group => group?.version === 1 && Array.isArray(group.sourceIds) && Array.isArray(group.fingerprints) && Array.isArray(group.keys) && typeof group.text === "string");
  };

  // Shared stats accumulator — tracks cumulative token/cost stats for summarizer calls
  const statsAccum = new StatsAccumulator();

  // Session-scoped summarizer outage-fallback controller (in-memory; reset on session_start).
  let fallbackController = new FallbackController();

  // Shared prune frontier — tracks the last completed prune attempt boundary
  const frontier = new PruneFrontierTracker();

  // Shared block-ref issuer — issues monotonic b<N> IDs for compressed chains;
  // rebuilt from session on session_start / session_tree
  const blockRefs = new BlockRefIssuer();

  // Session-scoped diagnostic sink — tracks recovery-path anomaly counters
  // (dedup'd across the session's lifetime, not per-render).
  const diagnostics = new DiagnosticSink((type, data) => pi.appendEntry(type, data));

  // Newest-protected-read-wins state (spec 2026-09-07). In-memory only: on
  // session_start / session_tree the cold floor re-activates everything.
  const supersede = createSupersedeState();

  // Pending batches — accumulated until the prune trigger fires
  const pendingBatches: CapturedBatch[] = [];
  let lifecycle = 0;
  const tokenEstimator = new TokenEstimator();
  const sharedApprovals = new Map<string, string>();
  let maintenanceAbort: AbortController | undefined;
  let maintenanceTask: Promise<void> | undefined;
  let maintenanceNext: { ctx: ExtensionContext; version: number } | undefined;
  let lastMaintenanceSource: string | undefined;
  const stagedChains = new Map<number, { entry: SingleChainCompressionEntry; source: string; config: string }>();
  let deferredFinal: number | undefined;
  const assertCurrent = (version: number) => {
    if (version !== lifecycle) throw new Error("This extension ctx is stale: condense lifecycle changed");
  };
  let isFlushing = false;
  let isArchiving = false;
  let isCompactingChains = false;
  let maintenanceHandoffs = 0;
  const stopMaintenance = async () => {
    maintenanceHandoffs++;
    maintenanceNext = undefined; maintenanceAbort?.abort();
    try { await maintenanceTask; } finally { maintenanceHandoffs--; }
  };
  // Native/OCC preparation must wait for the current archive write before it owns I/O.
  pi.on("session_before_compact", async () => {
    tokenEstimator.clear(); sharedApprovals.clear();
    await stopMaintenance();
  });
  const occ = registerOcc(pi, indexer, currentConfig);
  let activeFlushAbort: AbortController | undefined;
  let previousFraction: number | null = null;
  // Set on session_start/session_tree when the branch rescan finds recoverable
  // work but pendingBatches was just zeroed (reload/tree-switch). Lets the
  // turn_end budget gate fire without a freshly pushed batch. Boolean only —
  // no queue reconstruction; flushPending's own rescan is the data path.
  // Cleared on every non-concurrent flushPending invocation.
  let rearmedPending = false;

  const computeMetricsSnapshot = (ctx: any): ContextMetricsSnapshot | undefined => {
    try {
      // Includes persisted custom_message entries (e.g. this extension's own
      // summary messages) alongside plain "message" entries: both are retained
      // LLM context, so both belong in the largest-chain-share denominator.
      // Shared projection (src/batch-capture.ts projectBranchMessages) so this
      // matches the chain-detection feed sites exactly.
      const branch = projectBranchMessages(ctx.sessionManager.getBranch());
      return computeContextMetrics(
        branch,
        frontier.get(),
        (k: string) => indexer.isSummarized(k),
        protectionPredicate,
      );
    } catch (err) {
      console.error("pi-condense: context metrics computation failed", err);
      return undefined;
    }
  };

  type SessionAppender = {
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
  };

  const isStaleContextError = (err: unknown) =>
    err instanceof Error && err.message.includes("This extension ctx is stale");

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const safeNotify = (ctx: any, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui.notify(message, type);
    } catch (err) {
      if (!isStaleContextError(err)) throw err;
    }
  };

  const assistantMessageHasToolCalls = (message: any) =>
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((block: any) => block?.type === "toolCall");

  const isFinalAssistantMessage = (message: any) => message?.role === "assistant"
    && message.stopReason !== "error" && message.stopReason !== "aborted" && !assistantMessageHasToolCalls(message);

  const trimBatchToPendingRange = (batch: CapturedBatch): CapturedBatch | null => {
    const currentFrontier = frontier.get();
    let toolCalls = batch.toolCalls;

    // The indexer tells us what was successfully summarized earlier.
    toolCalls = toolCalls.filter((tc) => !indexer.isSummarized(occKey(tc.toolCallId, tc.resultTimestamp)));
    if (toolCalls.length === 0) return null;

    // The frontier tells us the last attempted boundary even when the attempt did
    // not persist index entries (e.g. skipped-oversized). When the LLM prunes in
    // the middle of a long tool chain, keep later tool calls from the same turn
    // instead of dropping the whole batch on the floor.
    if (!currentFrontier) return { ...batch, toolCalls };
    if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return null;
    if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex) return { ...batch, toolCalls };

    const originalIndex = toolCalls.findIndex((tc) => tc.toolCallId === currentFrontier.lastAttemptedToolCallId
      && (currentFrontier.lastAttemptedResultTimestamp === undefined || tc.resultTimestamp === currentFrontier.lastAttemptedResultTimestamp));
    if (originalIndex < 0) return { ...batch, toolCalls };

    const remaining = toolCalls.slice(originalIndex + 1);
    if (remaining.length === 0) return null;
    return { ...batch, toolCalls: remaining };
  };

  const restoreBatches = (batches: CapturedBatch[]) => {
    pendingBatches.unshift(...batches);
  };

  // ── Helper: capture + trim + group pending batches (no LLM work) ──────────
  // Exposed to commands.ts via registerCommands so /pruner now can preview the
  // queue before opening the multi-row progress overlay.
  // `rethrow` is for the reload rearm probe only (session_start/session_tree):
  // it needs to observe a rescan failure so it can console.error and leave
  // rearmedPending false, per spec. Every other caller (turn_end capture path,
  // flushPending, /pruner commands) keeps the existing swallow-and-fall-back
  // behavior so a transient getBranch failure there never blocks the turn.
  const queuedSummaryKeys = new Set<string>();
  const capturePendingBatches = (ctx: any, opts?: { rethrow?: boolean }): CapturedBatch[] => {
    let batches: CapturedBatch[] = [];
    try {
      indexer.syncSummaryEntries(ctx);
      const rawBranch = ctx.sessionManager.getBranch();
      const sourceTurns = new Map<string, number>();
      let turnIndex = 0;
      for (const entry of rawBranch) if (entry.type === "message" && entry.message.role === "assistant") sourceTurns.set(entry.id, turnIndex++);
      const branch = occ.enabled() ? ctx.sessionManager.buildSessionProjection().entries.flatMap((entry: any) =>
        entry.messages.map((message: any) => ({ ...entry.sourceEntry, type: "message", message }))) : rawBranch;
      batches = captureUnindexedBatchesFromSession(branch, { isSummarized: key => queuedSummaryKeys.has(key) || indexer.isSummarized(key) }, protectionPredicate, sourceTurns);
    } catch (err) {
      if (opts?.rethrow) throw err;
      batches = pendingBatches.slice();
    }
    batches = batches
      .map((batch) => trimBatchToPendingRange(batch))
      .filter((batch): batch is CapturedBatch => batch !== null);
    return groupBatchesByMode(batches, currentConfig.value.batchingMode, summarizerInputBudget(currentConfig.value, ctx));
  };

  // Summarizes + indexes all pending batches.
  // Each budget-bounded chunk is requested and committed before the next one.
  // Runtime delivery is used while the agent/tool loop is active so Pi can place
  // steer messages at protocol-safe boundaries. Session delivery is used only for
  // agent-message's final-message flush, where print-mode Pi may invalidate pi.*
  // while the summarizer LLM call is in flight.
  // Range-summary fuser injected into compressEligible (B). Returns undefined
  // when fuseRangeSummary is off so the compressor keeps the per-batch concat.
  // Each successful fusion folds its usage + bumps the rangesSummarized counter.
  const makeFuseRange = (ctx: any, signal?: AbortSignal, automatic = false): ((text: string) => Promise<string | null>) | undefined => {
    if (!currentConfig.value.chainCompression.fuseRangeSummary || (automatic && occ.enabled())) return undefined;
    const version = lifecycle;
    return async (text: string) => {
      const r = await summarizeRange(text, currentConfig.value, ctx, { controller: fallbackController, signal });
      assertCurrent(version);
      if (r) {
        statsAccum.add(r.usage);
        statsAccum.addRangesSummarized(1);
      }
      return r?.summaryText ?? null;
    };
  };

  const compressChains = async (ctx: any, rollingWindow: number,
    appendEntry: (type: string, data: unknown) => void, closingMessage?: any, signal?: AbortSignal, automatic = false, zeroCall = false) => {
    const version = lifecycle;
    const beforeRewrite = occ.measure(ctx);
    const messages = withClosingMessage(ctx.sessionManager.buildSessionProjection().messages, closingMessage);
    const chains = detectChains(messages, protectionPredicate).filter(chain => findCompressibleRange(chain, messages));
    const inGrace = inGraceRecoveryToolCallIds(messages, currentConfig.value.recoveryGraceTurns);
    if (automatic && selectEligible(chains, rollingWindow,
      new Set(indexer.getChainEntries().flatMap(chainMembers).map(entry => entry.startUserTimestamp)), inGrace).length >= 2) {
      return { compressedEntries: [], skipped: [] }; // The stable maintenance hook prepares one shared group.
    }
    const append = (type: string, data: unknown) => {
      assertCurrent(version); signal?.throwIfAborted(); appendEntry(type, data);
      if (!ctx.sessionManager.getBranch().some((item: any) => item.type === "custom" && item.customType === type
        && JSON.stringify(item.data) === JSON.stringify(data))) throw new Error("Chain evidence was not persisted on the current branch");
      if (type === CUSTOM_TYPE_CHAIN) lowerFloor(supersede, (data as SingleChainCompressionEntry).startUserTimestamp);
    };
    const backfill = { spillThreshold: currentConfig.value.spillThreshold,
      spillPreviewBytes: currentConfig.value.spillPreviewBytes,
      sessionDir: ctx.sessionManager.getSessionDir(), sessionId: ctx.sessionManager.getSessionId(),
      assertValid: () => { assertCurrent(version); signal?.throwIfAborted(); } };
    for (const chain of selectEligible(chains, rollingWindow,
      new Set(indexer.getChainEntries().flatMap(chainMembers).map(entry => entry.startUserTimestamp)), inGrace)) {
      const fresh = extractChainRecords(messages, { ...chain, protectedToolCallIds: [] }, key => indexer.getIndex().has(key));
      if (fresh.length) await indexer.backfillChainRecords(fresh, { ...backfill, appendEntry: append });
    }
    const result = await compressEligible(chains, rollingWindow, {
      indexer, blockRefs, appendEntry: append, now: () => Date.now(), fuseRange: zeroCall ? undefined : makeFuseRange(ctx, signal, automatic),
      messages, diagnostics, validate: async entry => {
        const keys = entry.droppedOccurrenceKeys ?? entry.droppedToolCallIds;
        if (indexer.getOwnedSummaryText(keys) === null || !singleSummaryCurrent(entry, ctx)) return false;
        if (keys.some(key => { const record = indexer.getIndex().get(key);
          return !record || record.metadataUnavailable || record.archiveComplete === false; })) return false;
        if (automatic && !zeroCall) {
          const range = resolveRange(entry, messages);
          if (range) stagedChains.set(entry.startUserTimestamp, { entry,
            source: projectionFingerprint(messages.slice(range.startIndex, range.endIndex + 1)),
            config: JSON.stringify(currentConfig.value) });
          return false; // Validate/publish only after the final is durable, in background.
        }
        const raw = ctx.sessionManager.buildSessionProjection().messages;
        if (!resolveRange(entry, raw)) return false; // A preview final is not a persistence receipt.
        const source = projectionFingerprint(raw);
        const config = JSON.stringify(currentConfig.value);
        const before = projectContext(raw, ctx.model?.api, ctx, undefined, true).messages;
        const views = currentChainViews(raw, ctx).concat(entry);
        const after = projectContext(raw, ctx.model?.api, ctx, views, true, entry.startUserTimestamp).messages;
        const counts = await tokenEstimator.compare(before, after, signal);
        assertCurrent(version); signal?.throwIfAborted();
        if (!counts && automatic) lastMaintenanceSource = undefined;
        return !!counts && counts.piBefore > counts.piAfter && counts.proxyDelta > 0
          && source === projectionFingerprint(ctx.sessionManager.buildSessionProjection().messages)
          && config === JSON.stringify(currentConfig.value);
      },
      backfill,
    }, inGrace);
    assertCurrent(version);
    if (result.compressedEntries.length > 0) {
      statsAccum.addChainsCompressed(result.compressedEntries.length);
      occ.rewrite(ctx, beforeRewrite);
    }
    return result;
  };

  const flushPending = async (ctx: any, options: FlushOptions = {}): Promise<FlushResult> => {
    if (isFlushing || isArchiving || isCompactingChains) return { ok: false, reason: "already-flushing" };
    const trigger: FlushTrigger = options.trigger ?? "manual";
    if (trigger !== "manual" && occ.deferLocal(ctx)) return { ok: false, reason: "deferred-occ" };
    const version = lifecycle;
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    const beforeRewrite = occ.measure(ctx);

    // Clear on every non-concurrent invocation, regardless of outcome — the
    // rearm is a one-shot nudge for the very next eligible gate check.
    rearmedPending = false;

    // Pre-flush pressure snapshot — recorded once at flush entry so the
    // observability entry reflects what triggered this attempt, not what's
    // left after it ran.
    const entryMetrics: ContextMetricsSnapshot = computeMetricsSnapshot(ctx) ?? EMPTY_METRICS_SNAPSHOT;
    const delivery = options.delivery ?? "runtime";

    // One-entry-per-attempt tracking, emitted once from the outer `finally`
    // below. `appendEntry` is assigned only once `sessionManager` is captured
    // (session delivery); until then (empty/aborted/pre-capture-failure exits)
    // the emitter falls back to pi.appendEntry.
    let capturedBatches = 0;
    let processedCount = 0;
    let stubCount = 0;
    let publishedAliasesOrArchives = false;
    let publishedCharsSaved = 0;
    let argumentCharsSaved = 0;
    let firstChangedMessage: number | undefined;
    let modelAttempted = false;
    let outcome: FlushMetricsEntry["outcome"] = "empty";
    let failureReason: string | undefined, failureMessage: string | undefined;
    let appendEntry: ((customType: string, data?: unknown) => void) | undefined;

    // Non-fatal by construction: observability must never affect the flush outcome.
    const emitFlushMetricsOnce = () => {
      const entry: FlushMetricsEntry = {
        ts: Date.now(),
        trigger,
        capturedBatches,
        processedBatches: processedCount,
        stubCount,
        publishedCharsSaved, argumentCharsSaved, firstChangedMessage,
        outcome,
        ...(failureReason ? { reason: failureReason } : {}),
        ...((outcome === "error" || outcome === "partial") && failureMessage ? { error: failureMessage } : {}),
        metrics: entryMetrics,
      };
      try {
        assertCurrent(version);
        (appendEntry ?? pi.appendEntry)(CUSTOM_TYPE_FLUSH_METRICS, entry);
      } catch {
        // non-fatal: observability must never fail the flush
      }
    };

    type ResultSlot =
      | {
          summaryText: string;
          usage?: import("./types.ts").SummarizeResult["usage"];
          deterministic?: boolean;
        }
      | null
      | "trivial"
      | "deduped";
    let batches: CapturedBatch[] = [];
    let sessionManager: SessionAppender | undefined;
    try {
      isFlushing = true;
      activeFlushAbort = abort;
      await stopMaintenance();
      assertCurrent(version); signal.throwIfAborted();
      // Bind the session appender as soon as delivery is known, BEFORE the
      // empty-capture/aborted exits below — so emitFlushMetricsOnce's finally
      // emit routes through sessionManager for those exits too, instead of
      // falling back to the (possibly stale, print-mode) pi.appendEntry.
      if (delivery === "session") {
        try {
          sessionManager = ctx.sessionManager as unknown as SessionAppender;
          appendEntry = (customType: string, data?: unknown) => { assertCurrent(version); sessionManager!.appendCustomEntry(customType, data); };
        } catch (err) {
          outcome = "error";
          failureReason = isStaleContextError(err) ? "stale-context" : "failed";
          failureMessage = errorMessage(err);
          return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
        }
      } else appendEntry = (type, data) => { assertCurrent(version); pi.appendEntry(type, data); };

      // Use pre-captured batches if provided (avoids double-capture when the
      // caller previewed the queue before opening the progress overlay).
      batches = options.previewedBatches ?? capturePendingBatches(ctx);
      if (trigger === "message-end") {
        const base = ctx.sessionManager.buildSessionProjection();
        const before = projectContext(base.messages, ctx.model?.api, ctx).messages;
        const argumentProtection = effectiveProtection();
        const candidates = argumentCandidates(base.entries, argumentProtection, argumentHistory)
          .filter(({ group }) => !group.keys.some(key => indexer.getRecord(key)?.metadataUnavailable)
            && projectArguments(before, [group], effectiveProtection()) !== before);
        const after = projectArguments(before, candidates.map(candidate => candidate.group), effectiveProtection());
        if (after !== before && JSON.stringify(after).length < JSON.stringify(before).length) {
          await archiveBatches(candidates.map(({ batch }) => batch), { indexer,
            spillThreshold: currentConfig.value.spillThreshold,
            spillPreviewBytes: currentConfig.value.spillPreviewBytes, sessionDir: ctx.sessionManager.getSessionDir(),
            sessionId: ctx.sessionManager.getSessionId(), appendEntry: appendEntry! });
          const current = projectContext(ctx.sessionManager.buildSessionProjection().messages, ctx.model?.api, ctx).messages;
          if (currentConfig.value.enabled && JSON.stringify(effectiveProtection()) === JSON.stringify(argumentProtection)
            && JSON.stringify(current) === JSON.stringify(before)) {
            for (const { group } of candidates) { appendEntry!(ARGUMENT_HISTORY, group); argumentHistory.push(group); }
            const keys = new Set(candidates.flatMap(candidate => candidate.group.keys));
            batches = batches.map(batch => ({ ...batch, toolCalls: batch.toolCalls.filter(call => !keys.has(occKey(call.toolCallId, call.resultTimestamp))) })).filter(batch => batch.toolCalls.length);
            publishedAliasesOrArchives = true;
            argumentCharsSaved += JSON.stringify(before).length - JSON.stringify(after).length;
            firstChangedMessage = before.findIndex((message: any, index: number) => JSON.stringify(message) !== JSON.stringify(after[index]));
          }
        }
      }
      capturedBatches = batches.length;

      if (batches.length === 0) {
        outcome = "empty";
        return { ok: false, reason: "empty" };
      }

      // Bail out before we drain pendingBatches so they don't need restoring.
      if (options.signal?.aborted) {
        outcome = "error";
        failureReason = "aborted";
        return { ok: false, reason: "aborted" };
      }

      // Draining the queue since we've captured the state via session or slice.
      // We drain BEFORE the await so concurrent calls (though guarded by isFlushing)
      // or rapid turn-ends don't result in double-summarization.
      pendingBatches.length = 0;

      // Routes alias persistence through whichever delivery is active so the
      // dedup pre-flush pass writes CUSTOM_TYPE_DEDUP_ALIAS entries via the
      // same path the rest of the flush uses.

      // Reload/rescan can reach the final boundary without a turn_end callback.
      // Recover fused evidence before any summary can replace its visible tail.
      for (const batch of batches) {
        const toolCalls = batch.toolCalls.filter(call => call.outputArchive?.source);
        if (toolCalls.length === 0) continue;
        const handled = await spillOversizedBatch({ batch: { ...batch, toolCalls }, indexer,
          config: { spillThreshold: Infinity, spillPreviewBytes: currentConfig.value.spillPreviewBytes, dedupByContentHash: false },
          sessionDir: ctx.sessionManager.getSessionDir(), sessionId: ctx.sessionManager.getSessionId(), appendEntry: appendEntry! });
        publishedAliasesOrArchives ||= handled.size > 0;
      }
      batches = batches.map(batch => ({ ...batch, toolCalls: batch.toolCalls.filter(call => !indexer.isSummarized(occKey(call.toolCallId, call.resultTimestamp))) }))
        .filter(batch => batch.toolCalls.length > 0);
      if (batches.length === 0) {
        outcome = "empty";
        return { ok: false, reason: "empty" };
      }

      // ── Pre-flush content-hash dedup pass ────────────────────────────
      // A content-hash hit means an identical (toolName, exact resultText)
      // pair was summarized in an earlier flush: register the duplicate as
      // an alias of the original (pruneMessages then stub-replaces its
      // ToolResultMessage) and drop it from the batch BEFORE the summarizer /
      // trivial classifier runs, still counting it toward the flush totals.
      const pendingAliases: Array<[string, string, import("./types.ts").ToolCallRecord]> = [];
      const dedupEnabled = currentConfig.value.dedupByContentHash;
      const minChars = currentConfig.value.minBatchChars;
      // Keep dedup separate from preparation so failed lookups restore the
      // same pending batches as a flush that has not begun preparing them.
      const dedupRecords = batches.map((batch, index) => ({
        index,
        batch,
        lastToolCall: batch.toolCalls.at(-1)!,
        deduped: [] as import("./types.ts").CapturedToolCall[],
        dedupedRawChars: 0,
      }));
      if (dedupEnabled) {
        for (const record of dedupRecords) {
          const batch = record.batch;
          const remaining: typeof batch.toolCalls = [];
          for (const tc of batch.toolCalls) {
            const originalId = tc.spillPath || tc.archiveSource ? undefined : indexer.lookupByContent(tc.toolName, tc.resultText);
            const key = occKey(tc.toolCallId, tc.resultTimestamp);
            if (originalId && originalId !== key) {
              pendingAliases.push([key, originalId, { ...tc, turnIndex: batch.turnIndex, timestamp: batch.timestamp }]);
              record.deduped.push(tc);
              record.dedupedRawChars += tc.resultText.length;
            } else {
              remaining.push(tc);
            }
          }
          // Shallow-clone the batch so we don't mutate the captured array
          // (pendingBatches consumers retain the original shape on retry).
          record.batch = { ...batch, toolCalls: remaining };
          batches[record.index] = record.batch;
        }
      }
      // Requests may complete out of order; only the commit loop publishes them.
      const records = dedupRecords.map((record) => ({
        ...record,
        prepared: prepareBatch(record.batch),
        rawChars: record.batch.toolCalls.reduce((s, tc) => s + tc.resultText.length, 0),
        result: null as ResultSlot,
        job: undefined as Promise<void> | undefined,
        abort: new AbortController(),
        error: undefined as unknown,
        failureReason: undefined as string | undefined,
        failureMessage: undefined as string | undefined,
      }));
      type BatchRecord = (typeof records)[number];

      // Batches below minBatchChars are trivial: the summarizer is skipped
      // entirely, the frontier still advances, and the original tool-result
      // messages stay verbatim in context. minBatchChars === 0 disables the
      // guard. A fully-deduped batch has empty toolCalls, so it can never take
      // the trivial path (different outcome + notification).
      const isFullyDeduped = (record: BatchRecord) => record.deduped.length > 0 && record.batch.toolCalls.length === 0;
      const isTrivial = (record: BatchRecord) =>
        minChars > 0 && record.prepared.candidateChars < minChars && record.batch.toolCalls.length > 0;
      const packedResult = (record: BatchRecord): ResultSlot =>
        record.prepared.packedBatch.toolCalls.length ? { summaryText: record.prepared.packedText, deterministic: true } : "trivial";
      for (const [key, originalId, occurrence] of pendingAliases) {
        indexer.registerDuplicate(key, originalId, appendEntry!, occurrence);
        publishedAliasesOrArchives = true;
      }

      // Process results in order; stop at first null (individual call failure).
      // Batches before the first failure are persisted; remaining are restored to
      // pendingBatches so they are retried on the next flush.
      const processedBatches: BatchRecord[] = [];
      let totalRawCharCount = 0;
      let totalSummaryCharCount = 0;
      let totalToolCallCount = 0;
      let totalDedupedCount = 0;
      const oversizedBatches: BatchRecord[] = [];
      const trivialBatches: BatchRecord[] = [];
      const dedupedBatches: BatchRecord[] = [];
      let firstFailureIndex = -1;
      let deliveryPending = false;

      const processedOutcome = (count = processedBatches.length): PruneFrontier["outcome"] =>
        count > trivialBatches.length + oversizedBatches.length + dedupedBatches.length ? "summarized"
          : oversizedBatches.length ? "skipped-oversized" : dedupedBatches.length ? "skipped-deduped" : "skipped-trivial";
      const completeRecord = (record: BatchRecord) => {
        const last = record.lastToolCall;
        const snapshot: PruneFrontier = {
          lastAttemptedToolCallId: last.toolCallId, lastAttemptedToolName: last.toolName,
          lastAttemptedResultTimestamp: last.resultTimestamp,
          lastAttemptedTurnIndex: last.sourceTurn?.turnIndex ?? record.batch.turnIndex,
          lastAttemptedTimestamp: last.sourceTurn?.timestamp ?? record.batch.timestamp,
          attemptedBatchCount: processedBatches.length + 1, attemptedToolCallCount: totalToolCallCount,
          rawCharCount: totalRawCharCount, summaryCharCount: totalSummaryCharCount,
          outcome: processedOutcome(processedBatches.length + 1),
        };
        appendEntry!(CUSTOM_TYPE_FRONTIER, snapshot);
        frontier.advance(snapshot);
        processedBatches.push(record);
        processedCount = processedBatches.length;
        options.onProgress?.(record.index, records.length, record.batch,
          record.result === "trivial" || record.result === "deduped" ? "skipped" : "done");
      };

      // Every tool call phase 1 will stub on the next render is a floor
      // source for supersession: dedup aliases regardless of batch outcome,
      // plus the batch's own calls when the batch was actually indexed.
      const floorSources = records.flatMap((record) => record.deduped);
      let expectedSource = JSON.stringify(ctx.sessionManager.buildSessionProjection().messages);
      let nextRequest = 0, failedRequest = Infinity;
      const controller = fallbackController;
      const config = currentConfig.value;
      const checkSource = () => {
        assertCurrent(version);
        if (signal.aborted) throw new Error("summarize: aborted");
        if (JSON.stringify(ctx.sessionManager.buildSessionProjection().messages) !== expectedSource) {
          throw new Error("This extension ctx is stale: summary source changed");
        }
      };
      const schedule = (index: number) => {
        // Keep at most three uncommitted records in flight, even if later calls
        // finish first. No further work starts after an observed failure.
        while (nextRequest < Math.min(index + 3, records.length, failedRequest)) {
          const i = nextRequest++, record = records[i]!;
          if (isFullyDeduped(record) || isTrivial(record)) {
            record.result = isFullyDeduped(record) ? "deduped" : packedResult(record);
            continue;
          }
          options.onProgress?.(i, records.length, record.batch, "start");
          const requestSignal = AbortSignal.any([signal, record.abort.signal]);
          record.job = summarizeBatch(record.prepared.candidate, config, ctx, {
            signal: requestSignal, controller,
            onModelAttempt: () => { modelAttempted = true; },
            onFailure: (message, reason) => { record.failureMessage = message; record.failureReason = reason ?? "summarizer-failed"; },
            onTextProgress: chars => options.onBatchTextProgress?.(i, records.length, record.batch, chars),
          }).then(result => {
            // Count completed provider work even if an earlier chunk later
            // prevents this result from being committed.
            if (result?.usage && !signal.aborted) statsAccum.add(result.usage);
            if ((!result || result.summaryText.length >= record.prepared.candidateChars) && record.prepared.packedBatch.toolCalls.length) {
              record.result = packedResult(record);
            } else record.result = result;
          }).catch(error => { record.error = error; }).then(() => {
            if (record.result !== null || requestSignal.aborted) return;
            failedRequest = Math.min(failedRequest, i);
            for (const later of records.slice(failedRequest + 1, nextRequest)) later.abort.abort();
          });
        }
      };

      for (const [i, record] of records.entries()) {
        checkSource();
        schedule(i);
        if (record.job) setPruneStatusWidget(ctx, currentConfig.value, `prune: summarizing ${i + 1}/${records.length} (up to 3 concurrent)`);
        await record.job;
        checkSource();
        if (record.error) throw record.error;
        const result = record.result;
        if (result === null) {
          failureMessage = record.failureMessage;
          failureReason = record.failureReason;
          if (failureReason === "input-budget") safeNotify(ctx, `pruner: ${failureMessage}; raw results retained`, "warning");
          options.onProgress?.(i, records.length, record.batch, "skipped");
          firstFailureIndex = i;
          break;
        }
        failureReason = failureMessage = undefined;

        const batch = record.batch;
        const dedupCount = record.deduped.length;
        const dedupRawChars = record.dedupedRawChars;

        // Fully-deduped batches: every tool call matched an existing
        // indexed record. The alias entries are already persisted; we just
        // need to advance the frontier past this turn and count the
        // dedup'd raw chars toward the flush totals so the user sees the
        // savings.
        if (result === "deduped") {
          totalRawCharCount += dedupRawChars;
          totalToolCallCount += dedupCount;
          totalDedupedCount += dedupCount;
          stubCount += dedupCount;
          dedupedBatches.push(record);
          completeRecord(record);
          continue;
        }

        // Trivial batches: no summary text, no index entry, no stats usage —
        // just bookkeeping so the frontier can advance past this range and
        // the next flush does not reconsider these tool calls.
        if (result === "trivial") {
          // Count dedup'd tool calls (if any) on a partial-dedup batch even
          // though the rest of the batch was below minBatchChars.
          totalRawCharCount += record.rawChars + dedupRawChars;
          totalToolCallCount += batch.toolCalls.length + dedupCount;
          totalDedupedCount += dedupCount;
          stubCount += dedupCount;
          trivialBatches.push(record);
          completeRecord(record);
          continue;
        }

        const archivedBatch = result.deterministic ? record.prepared.packedBatch : batch;
        const beforeArchive = JSON.stringify(ctx.sessionManager.buildSessionProjection().messages);
        const summaryRefs = await archiveBatches([archivedBatch], { indexer, appendEntry: appendEntry!,
          spillThreshold: currentConfig.value.spillThreshold, spillPreviewBytes: currentConfig.value.spillPreviewBytes,
          sessionDir: ctx.sessionManager.getSessionDir(), sessionId: ctx.sessionManager.getSessionId() });
        assertCurrent(version);
        if (JSON.stringify(ctx.sessionManager.buildSessionProjection().messages) !== beforeArchive) {
          throw new Error("This extension ctx is stale: summary source changed during archive");
        }
        const toolNames = archivedBatch.toolCalls.map((tc) => tc.toolName);
        const decorated = substituteInlineRefs(result.summaryText, summaryRefs, toolNames);
        const summaryText = decorated + formatSummaryToolCallRefs(summaryRefs);
        const batchDetails = { ...makeSummaryDetails(archivedBatch, summaryRefs), representation: result.deterministic ? "packed" : "summary" };
        const visible = projectContext(ctx.sessionManager.buildSessionProjection().messages, ctx.model?.api, ctx).messages;
        const replacements = new Map(archivedBatch.toolCalls.map((call, i) => [occKey(call.toolCallId, call.resultTimestamp), { call, ref: summaryRefs[i]!.shortId }]));
        let replaced = 0;
        const proposed = visible.map((message: any) => {
          if (message.role !== "toolResult") return message;
          const candidate = replacements.get(occKey(message.toolCallId, message.timestamp));
          if (!candidate || candidate.call.nestedProtected || protectionPredicate(candidate.call.toolName, candidate.call.args)) return message;
          replaced++;
          return toolResultStub(message, { ...candidate.call, turnIndex: archivedBatch.turnIndex, timestamp: archivedBatch.timestamp }, candidate.ref);
        });
        proposed.push({ role: "custom", customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: false, details: batchDetails, timestamp: Date.now() });
        const charsSaved = JSON.stringify(visible).length - JSON.stringify(proposed).length;
        const shouldSkipOversized = replaced !== archivedBatch.toolCalls.length || charsSaved <= 0;

        totalRawCharCount += record.rawChars + dedupRawChars;
        totalSummaryCharCount += summaryText.length;
        totalToolCallCount += batch.toolCalls.length + dedupCount;
        totalDedupedCount += dedupCount;

        try {
          if (!shouldSkipOversized) {
            // Write one hidden summary message per turn and index its tool calls.
            // `display: false` keeps the summary in future LLM context (convertToLlm
            // ignores `display`) while suppressing the full markdown block from Pi's
            // main window; rebuild keys on customType, not display.
            const batchOccurrenceKeys = archivedBatch.toolCalls.map((tc) => occKey(tc.toolCallId, tc.resultTimestamp));
            if (delivery === "runtime") {
              pi.sendMessage(
                { customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: false, details: batchDetails },
                { deliverAs: "steer" }
              );

            } else {
              sessionManager!.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, summaryText, false, batchDetails);

            }
            // A runtime send can queue or fail asynchronously. Only a summary
            // actually persisted in this branch authorizes hiding its raw records.
            indexer.syncSummaryEntries(ctx);
            if (!batchOccurrenceKeys.every(key => indexer.isSummarized(key))) {
              if (ctx.isIdle()) throw new Error("Summary message was not persisted");
              batchOccurrenceKeys.forEach(key => queuedSummaryKeys.add(key));
              deliveryPending = true;
              firstFailureIndex = i;
              break;
            }
            publishedCharsSaved += charsSaved;
            const first = visible.findIndex((message: any, index: number) => JSON.stringify(message) !== JSON.stringify(proposed[index]));
            firstChangedMessage = firstChangedMessage === undefined ? first : Math.min(firstChangedMessage, first);
            stubCount += archivedBatch.toolCalls.length + dedupCount;
            floorSources.push(...archivedBatch.toolCalls);
          } else {
            stubCount += dedupCount;
            oversizedBatches.push(record);
          }
        } catch (err) {
          // Persistence error mid-loop: stop here, restore this and remaining batches.
          if (isStaleContextError(err)) {
            firstFailureIndex = i;
            failureReason = "stale-context";
            failureMessage = errorMessage(err);
            break;
          }
          throw err;
        }

        completeRecord(record);
        expectedSource = JSON.stringify(ctx.sessionManager.buildSessionProjection().messages);
      }

      lowerFloor(supersede, earliestResultTimestamp(floorSources));

      // Restore unprocessed batches (those at and after the first failure)
      if (firstFailureIndex >= 0) {
        restoreBatches(batches.slice(firstFailureIndex));
      }

      if (processedBatches.length === 0) {
        // Nothing was persisted (all calls failed or first call failed)
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
        outcome = deliveryPending ? "delivery-pending" : "error";
        failureReason = deliveryPending ? "delivery-pending" : failureReason ?? "summarizer-failed";
        return { ok: false, reason: deliveryPending ? "delivery-pending" : failureReason === "input-budget" ? "input-budget" : "summarizer-failed", error: failureMessage };
      }

      const flushOutcome = processedOutcome();
      if (currentConfig.value.enabled && currentConfig.value.chainCompression.enabled
        && firstFailureIndex < 0 && !signal.aborted) {
        try {
          const result = await compressChains(ctx, currentConfig.value.chainCompression.rollingWindow, appendEntry!, options.closingMessage, signal, trigger !== "manual");
          publishedAliasesOrArchives ||= result.compressedEntries.length > 0;
        } catch (err) {
          if (!signal.aborted && !isStaleContextError(err)) safeNotify(ctx, `pruner: chain compression failed: ${errorMessage(err)}`, "warning");
        }
      }
      try { appendEntry!(CUSTOM_TYPE_STATS, statsAccum.getStats()); }
      catch (err) { if (delivery === "runtime") throw err; }

      setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
      emitExternalCost(pi, statsAccum);

      // Notify about any batches that were skipped — either oversized or
      // trivial. Neither is an error: the pruner correctly chose not to grow
      // context (oversized) or to skip the LLM call entirely (trivial). Both
      // are silenced by `quietOversizedSkips`, which acts as a single
      // "quiet all non-error skips" toggle.
      if (!currentConfig.value.quietOversizedSkips) {
        const notify = (message: string) => safeNotify(ctx, message, "info");
        for (const record of oversizedBatches) {
          const batch = record.batch;
          const slot = record.result;
          const batchSummaryLen = slot && slot !== "trivial" && slot !== "deduped" ? slot.summaryText.length : 0;
          notify(
            `pruner: skipped pruning turn ${batch.turnIndex} (${batch.toolCalls.length} tool call${batch.toolCalls.length === 1 ? "" : "s"}) — summary was ${batchSummaryLen} chars vs ${record.rawChars} raw chars; frontier advanced past this range`
          );
        }
        for (const record of trivialBatches) {
          const batch = record.batch;
          notify(
            `pruner: skipped pruning turn ${batch.turnIndex} (${batch.toolCalls.length} tool call${batch.toolCalls.length === 1 ? "" : "s"}) — only ${record.rawChars} raw chars (< minBatchChars=${minChars}); no LLM call made; frontier advanced past this range`
          );
        }
        for (const record of dedupedBatches) {
          const batch = record.batch;
          const n = record.deduped.length;
          notify(
            `pruner: deduplicated ${n} tool call${n === 1 ? "" : "s"} (turn ${batch.turnIndex}, ${record.dedupedRawChars} raw chars) against earlier prunes; no LLM call made; frontier advanced past this range`
          );
        }
        if (totalDedupedCount > 0 && dedupedBatches.length === 0) {
          // Partial-dedup case: some tool calls were dedup'd but the rest
          // of the batch went through the summarizer. Surface a single
          // aggregate notification so users see the savings.
          notify(
            `pruner: deduplicated ${totalDedupedCount} tool call${totalDedupedCount === 1 ? "" : "s"} against earlier prunes (no LLM call for those); remaining tool calls were summarized normally.`
          );
        }
      }

      // Very end of the try block, deliberately after (and outside) the
      // chain-compression block's own try/catch above: a compression failure
      // must not eat this entry — the summarization phase already succeeded.
      processedCount = processedBatches.length;
      outcome = firstFailureIndex >= 0 ? "partial" : flushOutcome;
      if (firstFailureIndex >= 0) {
        failureReason = deliveryPending ? "delivery-pending" : failureReason ?? "summarizer-failed";
        setPruneStatusWidget(ctx, currentConfig.value, `prune: ${processedCount}/${records.length} complete; remaining pending`);
      }

      return {
        ok: true,
        reason: firstFailureIndex >= 0 ? "partial" : flushOutcome === "summarized" ? "flushed" : flushOutcome,
        batchCount: processedBatches.length,
        toolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
        dedupedCount: totalDedupedCount,
        ...(firstFailureIndex >= 0 && failureMessage ? { error: failureMessage } : {}),
      };
    } catch (err) {
      failureReason = options.signal?.aborted ? "aborted" : isStaleContextError(err) ? "stale-context" : "failed";
      failureMessage = errorMessage(err);
      if (version !== lifecycle) {
        if (projectionContext) rebuildBranchIndex(projectionContext);
        return { ok: false, reason: "stale-context", error: errorMessage(err) };
      }
      restoreBatches(batches.slice(processedCount));
      outcome = processedCount > 0 ? "partial" : "error";
      // When the abort signal fired, summarizeBatch rethrows rather than
      // swallowing the error.  Don't show a UI error — the user intended this.
      if (options.signal?.aborted) {
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
        return { ok: false, reason: "aborted", batchCount: processedCount };
      }
      if (isStaleContextError(err)) {
        return { ok: false, reason: "stale-context", error: errorMessage(err), batchCount: processedCount };
      }
      safeNotify(ctx, `pruner: summarization failed: ${errorMessage(err)}`, "error");
      return { ok: false, reason: "failed", error: errorMessage(err), batchCount: processedCount };
    } finally {
      abort.abort();
      if (activeFlushAbort === abort) activeFlushAbort = undefined;
      isFlushing = false;
      if (version === lifecycle && (stubCount > 0 || publishedAliasesOrArchives || modelAttempted)) occ.rewrite(ctx, beforeRewrite);
      emitFlushMetricsOnce();
    }
  };

  // ── session_start: restore config + index + stats ────────────────────────────────
  /** Rebuild the branch-scoped index, chain-id counter and stats accumulator. */
  const rebuildBranchIndex = (ctx: ExtensionContext): void => {
    indexer.reconstructFromSession(ctx);
    blockRefs.rebuildFrom(indexer.getChainEntries().map((e) => e.blockId));
    statsAccum.reconstructFromSession(ctx);
  };

  /** Reset branch-scoped diagnostics/frontier state, drop the old branch's queued
   * batches, then re-probe for recoverable pending work and refresh the footer. */
  const restoreBranchPending = (ctx: ExtensionContext): void => {
    queuedSummaryKeys.clear();
    diagnostics.reset();
    supersede.activated.clear();
    supersede.floor = 0;

    // Rebuild prune frontier from persisted session entries
    frontier.reconstructFromSession(ctx);

    // Clear any batches queued before the branch/session change
    pendingBatches.length = 0;
    previousFraction = null;
    rearmedPending = false;
    if (currentConfig.value.enabled) {
      try {
        rearmedPending = capturePendingBatches(ctx, { rethrow: true }).length > 0;
      } catch (err) {
        console.error("pi-condense: reload rearm probe failed", err);
      }
    }

    // Update footer status
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
  };

  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  const clearBoot = () => {
    if (!bootTimer) return;
    clearTimeout(bootTimer);
    bootTimer = undefined;
    try { projectionContext?.ui.setWidget("pruner-boot", undefined); } catch { /* Previous UI may be gone. */ }
  };
  const restore = (ctx: ExtensionContext) => {
    resetNested();
    occ.restore(ctx);
    restoreArguments(ctx);
  };
  const start = async (ctx: ExtensionContext) => {
    const version = ++lifecycle;
    maintenanceAbort?.abort(); tokenEstimator.clear(); sharedApprovals.clear(); stagedChains.clear(); deferredFinal = undefined; lastMaintenanceSource = undefined; maintenanceNext = undefined;
    activeFlushAbort?.abort();
    clearBoot();
    restore(ctx);
    const config = await loadConfig();
    if (version !== lifecycle) return;
    currentConfig.value = config;
    rebuildBranchIndex(ctx);
    fallbackController = new FallbackController();
    restoreBranchPending(ctx);
    activeSessionId = ctx.sessionManager.getSessionId();
    projectionContext = ctx;
    if (currentConfig.value.showPruneStatusLine) {
      ctx.ui.setWidget("pruner-boot", [
        `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      ], { placement: "belowEditor" });
      bootTimer = setTimeout(clearBoot, 10000);
      bootTimer.unref?.();
    }
    if (indexer.getChainEntries().some(isSharedChain)) await maintainChains(ctx);
  };
  const tree = async (ctx: ExtensionContext) => {
    lifecycle++;
    maintenanceAbort?.abort(); tokenEstimator.clear(); sharedApprovals.clear(); stagedChains.clear(); deferredFinal = undefined; lastMaintenanceSource = undefined; maintenanceNext = undefined;
    activeFlushAbort?.abort();
    restore(ctx);
    rebuildBranchIndex(ctx);
    restoreBranchPending(ctx);
    activeSessionId = ctx.sessionManager.getSessionId();
    projectionContext = ctx;
    if (indexer.getChainEntries().some(isSharedChain)) await maintainChains(ctx);
  };

  // Cache is a per-model prefix; these three moments are cold regardless, so
  // activating every pending supersession here costs no extra cache miss.
  pi.on("model_select", async (_event, ctx) => {
    previousFraction = null;
    maintenanceAbort?.abort(); tokenEstimator.clear(); sharedApprovals.clear(); stagedChains.clear(); lastMaintenanceSource = undefined;
    supersede.floor = 0;
    void maintainChains(ctx);
  });
  pi.on("session_compact", async () => {
    supersede.floor = 0;
  });
  pi.on("thinking_level_select", async () => {
    supersede.floor = 0;
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    const version = lifecycle;
    const appendArchive = (type: string, data?: unknown) => {
      assertCurrent(version);
      (ctx.sessionManager as unknown as SessionAppender).appendCustomEntry(type, data);
    };
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    // Text-only final turns are handled by message_end in agent-message mode.
    // In print mode, turn_end can fire after session shutdown, so do not start
    // deferred LLM work from this late lifecycle event — UNLESS a reload probe
    // (session_start/session_tree) found recoverable pending work: that flag
    // must still reach the budget/delta gate below without a freshly captured
    // batch on this turn.
    if (!hasToolResults && !rearmedPending) return;

    let pushedBatch = false;
    if (hasToolResults) {
      // Live batches must be numbered in the frontier's session-wide domain, not
      // Pi's run-local event.turnIndex (which resets on agent_start, #16). The
      // branch at turn_end already holds the just-ended assistant message (pi
      // persists it at message_end, a strictly earlier event), so the derived
      // index is the rescan index of this turn.
      let liveTurnIndex = event.turnIndex;
      let branch: SessionEntry[] | undefined;
      try {
        branch = ctx.sessionManager.getBranch();
      } catch {
        // Transient getBranch failure must never block the turn; fall back to
        // the run-local index (pre-#16 behavior). The flush-time rescan still
        // recovers the batch.
      }
      if (branch) liveTurnIndex = deriveLiveTurnIndex(branch);
      const capturedBatch = captureBatch(
        event.message,
        event.toolResults,
        liveTurnIndex,
        Date.now()
      );
      // Drop user-protected tool/path results so they stay verbatim in context.
      // Filtering at capture time keeps the
      // underlying assistant `toolCall` block AND its `ToolResultMessage`
      // untouched in Pi's session/event stream — only the in-memory
      // CapturedBatch is pruned, which is exactly what we want.
      const filtered = {
        ...capturedBatch,
        toolCalls: capturedBatch.toolCalls.filter((tc) => !tc.nestedProtected && !protectionPredicate(tc.toolName, tc.args)),
      };

      // Eager spill: offload oversized single results to sidecar files before they
      // ever reach a request. addBatch inside marks them isSummarized, so
      // trimBatchToPendingRange drops them from the pending set below. Best-effort:
      // a spill failure leaves the result inline for the normal flush pipeline.
      if (!isFlushing && !isArchiving && !isCompactingChains) {
        isArchiving = true;
        try {
          await stopMaintenance();
          assertCurrent(version);
          if (!currentConfig.value.enabled) return;
          const beforeRewrite = occ.measure(ctx);
          const deferred = occ.deferLocal(ctx);
          if (occ.isCapacityWaiting()) {
            for (const call of capturedBatch.toolCalls) {
              if (!call.outputArchive || indexer.getRecord(occKey(call.toolCallId, call.resultTimestamp))) continue;
              const archive = { indexer, sessionDir: ctx.sessionManager.getSessionDir(), sessionId: ctx.sessionManager.getSessionId(),
                appendEntry: appendArchive };
              await archiveToolOutput(call, capturedBatch, archive);
              indexer.addBatch({ ...capturedBatch, toolCalls: [call] }, archive.appendEntry, true);
            }
          }
          const handled = deferred ? new Set<string>() : await spillOversizedBatch({
            batch: filtered,
            indexer,
            config: {
              spillThreshold: currentConfig.value.spillThreshold,
              spillPreviewBytes: currentConfig.value.spillPreviewBytes,
              dedupByContentHash: currentConfig.value.dedupByContentHash,
            },
            sessionDir: ctx.sessionManager.getSessionDir(),
            sessionId: ctx.sessionManager.getSessionId(),
            appendEntry: appendArchive,
          });
          assertCurrent(version);
          if (handled.size) occ.rewrite(ctx, beforeRewrite);
        } catch {
          // best-effort; never block the turn
        } finally {
          isArchiving = false;
        }
      }
      if (version !== lifecycle) return;
      const batch = trimBatchToPendingRange(filtered);
      if (batch) {
        pushedBatch = true;
        pendingBatches.push(batch);

        // Let the user know a batch is queued
        const n = pendingBatches.length;
        const trigger = currentConfig.value.pruneOn === "agent-message"
          ? "agent's next text response"
          : "/pruner now";
        if (currentConfig.value.showPruneStatusLine) {
          setPruneStatusWidget(ctx, currentConfig.value, `prune: ${n} pending`);
          safeNotify(
            ctx,
            `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
            "info"
          );
        }
      }
    }

    // Mirrors main's `if (!batch) return;`: no freshly pushed batch this turn
    // means no gate evaluation, regardless of leftover pendingBatches from an
    // earlier turn — UNLESS a reload probe armed rearmedPending, in which case
    // the gate below must still run.
    if (!pushedBatch && !rearmedPending) return;

    // Final-reply mode defers pressure hints to that same boundary. Pi's native
    // capacity compaction remains the emergency guard during a long tool loop.
    if (currentConfig.value.pruneOn === "agent-message") return;

    // Token-budget auto-flush: an additional, mode-independent trigger. When context
    // usage crosses autoBudgetThreshold, compact the queued batches now instead of
    // waiting for this mode's flush boundary. The pendingBatches.length-or-rearmed
    // guard makes an already-drained, non-rearmed queue a no-op.
    const usage = ctx.getContextUsage?.();
    const budgetHit = shouldBudgetFlush(usage, currentConfig.value.autoBudgetThreshold);
    const deltaHit = shouldDeltaFlush(usage, previousFraction, currentConfig.value.budgetTurnDelta);
    // Frontier-gap auto-flush (opt-in): absolute un-pruned tail size, for huge
    // windows where fractional thresholds never trip. Threshold null (default)
    // skips the metrics snapshot entirely; a failed snapshot fails closed.
    const gapThreshold = currentConfig.value.frontierGapThresholdTokens;
    const gapHit = gapThreshold != null && shouldFrontierGapFlush(computeMetricsSnapshot(ctx), gapThreshold);
    // Update the per-turn baseline; leave it unchanged when tokens is null (e.g.
    // right after a compaction) so the next real reading compares to the last known.
    const f = usageFraction(usage);
    if (f != null) previousFraction = f;

    const n = pendingBatches.length;
    if ((n > 0 || rearmedPending) && !isFlushing && (budgetHit || deltaHit || gapHit)) {
      const reason = budgetHit ? "context budget reached" : deltaHit ? "context jumped this turn" : "un-pruned tail exceeded frontier gap threshold";
      // Always surface this flush (even when the routine status line is off): it's a
      // significant, infrequent event — context crossed a threshold, jumped sharply
      // this turn, or the un-pruned tail grew past the gap threshold — and it
      // self-throttles because pendingBatches is drained right after.
      safeNotify(
        ctx,
        n > 0
          ? `pruner: ${reason} — compacting ${n} pending turn${n === 1 ? "" : "s"}`
          : `pruner: ${reason} — compacting work recovered after reload`,
        "info",
      );
      await flushPending(ctx, {
        delivery: "session",
        trigger: n === 0 ? "rearmed" : budgetHit ? "budget" : deltaHit ? "delta" : "frontier-gap",
      });
    }
  });

  // ── message_end: flush after the final assistant response in agent-message mode ──
  // A final assistant message is the earliest reliable boundary where the agent has
  // finished using the raw tool results. flushPending captures the SessionManager
  // before awaiting summarization so print-mode shutdown cannot invalidate the
  // persistence path while the summarizer model is running.
  pi.on("message_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "agent-message") return;
    if (!isFinalAssistantMessage(event.message)) return;
    const result = await flushPending(ctx, { delivery: "session", closingMessage: event.message, trigger: "message-end" });
    deferredFinal = (!result.ok && result.reason !== "empty") || (result.ok && result.reason === "partial")
      ? event.message.timestamp : undefined;
  });

  // ── agent_end: last-chance cleanup only ─────────────────────────────────────
  // agent-message normally flushes on message_end. By agent_end, print-mode Pi may
  // already be disposing the session, so avoid starting a best-effort LLM call here.
  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (pendingBatches.length === 0 && !rearmedPending) return;
    setPruneStatusWidget(
      ctx,
      currentConfig.value,
      pendingBatches.length > 0 ? `prune: ${pendingBatches.length} pending` : "prune: recovered pending (reload)",
    );
  });

  pi.on("agent_settled", async (_event, ctx) => {
    indexer.syncSummaryEntries(ctx);
    queuedSummaryKeys.clear();
  });

  // ── context: prune summarized tool results from next LLM call ─────────────
  const projectContext = (input: any[], api?: string, ctx?: ExtensionContext,
    chainViews?: SingleChainCompressionEntry[], probe = false, chainFloor?: number) => {
    let messages = input;
    let changed = false;

    // Request-validity guard, independent of `enabled`: a transcript past the
    // provider's per-request image limit fails every request until trimmed.
    const imageCap = imageLimitFor(currentConfig.value.maxImagesPerRequest, api);
    if (imageCap !== null) {
      const capped = capImages(messages, imageCap);
      if (capped) {
        messages = capped;
        changed = true;
      }
    }

    if (!currentConfig.value.enabled) return { messages, changed };

    // A context edit changes effective evidence, not the immutable archive. Keep
    // edited sources visible and remove stale summaries of the same source group.
    const editedToolIds = new Set<string>();
    if (ctx) {
      const projection = ctx.sessionManager.buildSessionProjection();
      const editedSummaries = new Set<string>();
      const summaryIdentity = (message: any) => JSON.stringify([message.timestamp, message.content, message.details]);
      for (const entry of projection.entries) {
        if (entry.sourceEntry.type === "custom_message" && entry.sourceEntry.customType === CUSTOM_TYPE_SUMMARY) {
          const original = entry.sourceEntry;
          const effective = entry.messages[0];
          if (entry.messages.length === 1 && effective?.role === "custom"
            && JSON.stringify([effective.content, effective.details]) === JSON.stringify([original.content, original.details])) continue;
          for (const ref of normalizeSummaryToolCallRefs(original.details)) editedToolIds.add(bareToolCallId(ref.toolCallId));
          for (const message of entry.messages) editedSummaries.add(summaryIdentity(message));
          continue;
        }
        if (entry.sourceEntry.type !== "message") continue;
        const original = entry.sourceEntry.message;
        if (original.role !== "toolResult" && original.role !== "assistant") continue;
        const effective = entry.messages[0];
        if (entry.messages.length === 1 && effective && "content" in effective && JSON.stringify(effective.content) === JSON.stringify(original.content)) continue;
        if (original.role === "toolResult") editedToolIds.add(original.toolCallId);
        if (original.role === "assistant" && Array.isArray(original.content)) {
          for (const block of original.content) if (block.type === "toolCall") editedToolIds.add(block.id);
        }
      }
      const summaryIds = (message: any): string[] => message.customType === CUSTOM_TYPE_SUMMARY
        ? normalizeSummaryToolCallRefs(message.details).map(ref => bareToolCallId(ref.toolCallId)) : [];
      // One summary may cover multiple occurrences; preserve the whole group.
      let previousSize = -1;
      while (previousSize !== editedToolIds.size) {
        previousSize = editedToolIds.size;
        for (const message of projection.messages) {
          const ids = summaryIds(message);
          if (ids.some(id => editedToolIds.has(id))) ids.forEach(id => editedToolIds.add(id));
        }
      }
      const filtered = messages.filter(message => editedSummaries.has(summaryIdentity(message)) || !summaryIds(message).some(id => editedToolIds.has(id)));
      if (filtered.length !== messages.length) { messages = filtered; changed = true; }
    }

    // pruneMessages is the single source of truth for "is there work to do".
    // It returns the original array reference (pruned: false) only when none of
    // the five phases changed anything; index/registry emptiness alone does not
    // imply a no-op, since error-purge (phase 2) prunes independently of them.
    // Calling it unconditionally is safe and avoids a split gate here.
    const beforeArguments = messages;
    messages = projectArguments(messages, argumentHistory, effectiveProtection());
    const argumentsChanged = messages !== beforeArguments;
    changed ||= argumentsChanged;
    const supersedeState = probe ? { floor: supersede.floor, activated: new Set(supersede.activated) } : supersede;
    if (chainFloor !== undefined) lowerFloor(supersedeState, chainFloor);
    const result = pruneMessages(
      messages,
      indexer,
      currentConfig.value.chainCompression,
      occ.enabled() ? { ...currentConfig.value.purgeErrors, enabled: false } : currentConfig.value.purgeErrors,
      effectiveProtection(),
      currentConfig.value.recoveryGraceTurns,
      probe ? undefined : diagnostics,
      occ.enabled() ? undefined : { state: supersedeState, isProtected: protectionPredicate },
      editedToolIds,
      chainViews ?? currentChainViews(input, ctx),
    );
    if (result.pruned) {
      messages = result.messages;
      changed = true;

    }

    return { messages, changed, beforeChars: argumentsChanged ? JSON.stringify(input).length : result.beforeChars,
      afterChars: argumentsChanged ? JSON.stringify(messages).length : result.afterChars };
  };

  function anchorId(ctx: ExtensionContext, role: "start" | "final", timestamp: number,
    entries = ctx.sessionManager.buildSessionProjection().entries): string | undefined {
    const matches = entries.filter(entry => entry.messages.some(message =>
      message.timestamp === timestamp && (role === "final" ? message.role === "assistant" : message.role === "user" || message.role === "custom")));
    return matches.length === 1 ? matches[0]!.sourceEntry.id : undefined;
  }

  function sharedCandidates(entry: SharedChainCompressionEntry, raw: any[], ctx: ExtensionContext): SingleChainCompressionEntry[] {
    const grace = inGraceRecoveryToolCallIds(raw, currentConfig.value.recoveryGraceTurns);
    const chains = detectChains(raw, protectionPredicate);
    const edited = changedSourceToolIds(ctx);
    const anchors = ctx.sessionManager.buildSessionProjection().entries;
    return chainMembers(entry).filter((view, i) => {
      const member = entry.members[i]!;
      const range = resolveRange(view, raw);
      const chain = chains.find(chain => chain.startUserTimestamp === view.startUserTimestamp);
      if (!range || !chain || view.droppedToolCallIds.some(id => edited.has(id))
        || chainMatchesGrace(chain, grace)) return false;
      if (member.startEntryId !== anchorId(ctx, "start", member.startUserTimestamp, anchors)
        || member.finalEntryId !== anchorId(ctx, "final", member.finalAssistantTimestamp!, anchors)) return false;
      if (member.sourceFingerprint !== projectionFingerprint(raw.slice(range.startIndex, range.endIndex + 1))) return false;
      view.protectedToolCallIds = chain.protectedToolCallIds;
      const owned = indexer.getOwnedSummaryText(view.droppedOccurrenceKeys ?? []);
      return owned !== null && (!owned || view.rangeSummaryText?.includes(owned) === true);
    });
  }

  function changedSourceToolIds(ctx: ExtensionContext): Set<string> {
    const changed = new Set<string>();
    for (const entry of ctx.sessionManager.buildSessionProjection().entries) {
      const source = entry.sourceEntry;
      const original: any = source.type === "message" ? source.message : source.type === "custom_message" ? source : undefined;
      if (!original || (entry.messages.length === 1
        && JSON.stringify([(entry.messages[0] as any).content, (entry.messages[0] as any).details]) === JSON.stringify([original.content, original.details]))) continue;
      if (original.role === "toolResult") changed.add(original.toolCallId);
      if (original.role === "assistant") for (const block of original.content ?? []) if (block.type === "toolCall") changed.add(block.id);
      if (source.type === "custom_message" && source.customType === CUSTOM_TYPE_SUMMARY)
        for (const ref of normalizeSummaryToolCallRefs(source.details)) changed.add(bareToolCallId(ref.toolCallId));
    }
    return changed;
  }

  function sharedShape(before: any[], views: SingleChainCompressionEntry[]): string {
    const middle = views.flatMap(view => {
      const range = resolveRange(view, before);
      return range ? before.slice(range.startIndex, range.endIndex + 1) : [];
    });
    const keys = new Set(views.flatMap(view => view.droppedOccurrenceKeys ?? []));
    const summaries = before.filter(message => message.customType === CUSTOM_TYPE_SUMMARY
      && perBatchSummaryOverlapsDropped(message, keys, new Set()));
    return projectionFingerprint([views, middle, summaries, currentConfig.value.chainCompression]);
  }

  function singleSummaryCurrent(entry: SingleChainCompressionEntry, ctx?: ExtensionContext): boolean {
    const keys = entry.droppedOccurrenceKeys ?? entry.droppedToolCallIds;
    const summaries = indexer.getPerBatchSummariesForToolCallIds(keys);
    if (entry.summaryFingerprint !== undefined) return entry.summaryFingerprint === projectionFingerprint([summaries]);
    if (!entry.rangeSummaryText) return true; // Legacy concatenation reads current semantic bodies.
    if (entry.bodySource === "deterministic") return summaries.length === 0;
    const branch = ctx?.sessionManager.getBranch() ?? [];
    const published = branch.findIndex(item => item.type === "custom" && item.customType === CUSTOM_TYPE_CHAIN
      && (item.data as SingleChainCompressionEntry)?.blockId === entry.blockId);
    const own = new Set(keys);
    return published < 0 || !branch.slice(published + 1).some(item => item.type === "custom_message"
      && item.customType === CUSTOM_TYPE_SUMMARY && normalizeSummaryToolCallRefs(item.details)
        .some(ref => own.has(occKey(ref.toolCallId, ref.resultTimestamp))));
  }

  function currentChainViews(messages: any[], ctx?: ExtensionContext): SingleChainCompressionEntry[] {
    const entries = indexer.getChainEntries();
    const raw = ctx?.sessionManager.buildSessionProjection().messages ?? messages;
    const chains = detectChains(raw, protectionPredicate);
    const grace = inGraceRecoveryToolCallIds(raw, currentConfig.value.recoveryGraceTurns);
    const singles: SingleChainCompressionEntry[] = entries.filter(entry => !isSharedChain(entry)).flatMap(chainMembers).flatMap(entry => {
      const chain = chains.find(chain => chain.startUserTimestamp === entry.startUserTimestamp
        && chain.finalAssistantTimestamp === entry.finalAssistantTimestamp);
      if (!chain || chainMatchesGrace(chain, grace) || !singleSummaryCurrent(entry, ctx)) return [];
      return [{ ...entry, protectedToolCallIds: chain.protectedToolCallIds }];
    });
    const shared = entries.filter(isSharedChain);
    if (!ctx || shared.length === 0) return singles;
    const before = projectContext(messages, ctx.model?.api, ctx, singles, true).messages;
    return singles.concat(shared.flatMap(entry => {
      const views = sharedCandidates(entry, raw, ctx);
      return views.length && sharedApprovals.get(entry.blockId) === sharedShape(before, views) ? views : [];
    }));
  }

  const maintainChains = (ctx: ExtensionContext): Promise<void> => {
    if (!currentConfig.value.enabled || !currentConfig.value.chainCompression.enabled) {
      maintenanceAbort?.abort(); tokenEstimator.clear(); sharedApprovals.clear();
      stagedChains.clear(); lastMaintenanceSource = undefined; maintenanceNext = undefined;
      return Promise.resolve();
    }
    if (maintenanceTask) { maintenanceNext = { ctx, version: lifecycle }; return maintenanceTask; }
    if (maintenanceHandoffs || isFlushing || isArchiving || isCompactingChains || occ.isRunning() || occ.isCapacityWaiting()) return Promise.resolve();
    const version = lifecycle;
    const controller = new AbortController(); maintenanceAbort = controller;
    const signal = controller.signal;
    const manager = ctx.sessionManager;
    const config = JSON.stringify(currentConfig.value);
    const assertValid = () => { assertCurrent(version); signal.throwIfAborted();
      if (maintenanceHandoffs || isFlushing || isArchiving || isCompactingChains || occ.isRunning() || occ.isCapacityWaiting() || config !== JSON.stringify(currentConfig.value)) throw new Error("Chain maintenance invalidated"); };
    maintenanceTask = (async () => {
      indexer.syncSummaryEntries(ctx);
      let raw = manager.buildSessionProjection().messages;
      // Revalidate published shapes after edits, recovery or reload, without rewriting their records.
      const singles = indexer.getChainEntries().filter(entry => !isSharedChain(entry)).flatMap(chainMembers);
      for (const entry of indexer.getChainEntries().filter(isSharedChain)) {
        assertValid();
        const views = sharedCandidates(entry, raw, ctx);
        const before = projectContext(raw, ctx.model?.api, ctx, singles, true).messages;
        const shape = sharedShape(before, views);
        if (sharedApprovals.get(entry.blockId) === shape) continue;
        sharedApprovals.delete(entry.blockId);
        if (!views.length) continue;
        const source = projectionFingerprint(raw);
        const after = projectContext(raw, ctx.model?.api, ctx, singles.concat(views), true).messages;
        const counts = await tokenEstimator.compare(before, after, signal);
        assertValid();
        if (source !== projectionFingerprint(manager.buildSessionProjection().messages)) return;
        if (counts && counts.piBefore > counts.piAfter && counts.proxyDelta > 0) sharedApprovals.set(entry.blockId, shape);
      }
      raw = manager.buildSessionProjection().messages;
      const source = projectionFingerprint(raw);
      const chains = detectChains(raw, protectionPredicate);
      const window = currentConfig.value.chainCompression.rollingWindow;
      const grace = inGraceRecoveryToolCallIds(raw, currentConfig.value.recoveryGraceTurns);
      const known = new Set(indexer.getChainEntries().flatMap(chainMembers).map(member => member.startUserTimestamp));
      const edited = changedSourceToolIds(ctx);
      const eligible = selectEligible(chains, window, known, grace).filter(chain => chain.finalAssistantTimestamp !== deferredFinal
        && !chain.middleToolCallIds.some(id => edited.has(id)));
      const attempt = source + config + [...known].join(",");
      if (attempt === lastMaintenanceSource || eligible.length === 0) return;
      lastMaintenanceSource = attempt;
      const appendEntry = (type: string, data: unknown) => {
        assertValid(); pi.appendEntry(type, data);
        if (!manager.getBranch().some(item => item.type === "custom" && item.customType === type
          && JSON.stringify(item.data) === JSON.stringify(data))) throw new Error("Chain archive was not persisted on the current branch");
      };
      if (eligible.length === 1) {
        const stage = stagedChains.get(eligible[0]!.startUserTimestamp);
        const range = stage && resolveRange(stage.entry, raw);
        if (stage && range && stage.config === config && singleSummaryCurrent(stage.entry, ctx)
          && stage.source === projectionFingerprint(raw.slice(range.startIndex, range.endIndex + 1))) {
          const before = projectContext(raw, ctx.model?.api, ctx, undefined, true).messages;
          const after = projectContext(raw, ctx.model?.api, ctx, currentChainViews(raw, ctx).concat(stage.entry), true, stage.entry.startUserTimestamp).messages;
          const counts = await tokenEstimator.compare(before, after, signal);
          assertValid();
          if (!counts) { lastMaintenanceSource = undefined; return; }
          if (counts && counts.piBefore > counts.piAfter && counts.proxyDelta > 0
            && source === projectionFingerprint(manager.buildSessionProjection().messages)) {
            appendEntry(CUSTOM_TYPE_CHAIN, stage.entry); indexer.registerChain(stage.entry);
            lowerFloor(supersede, stage.entry.startUserTimestamp); statsAccum.addChainsCompressed(1);
            occ.rewrite(ctx, counts.piBefore);
          }
          stagedChains.delete(stage.entry.startUserTimestamp);
          return;
        }
        await compressChains(ctx, window, appendEntry, undefined, signal, true, true);
        return;
      }
      const before = projectContext(raw, ctx.model?.api, ctx, undefined, true).messages;
      const backlogChars = eligible.reduce((sum, chain) => {
        const range = resolveRange(chain, before);
        return sum + (range ? JSON.stringify(before.slice(range.startIndex + 1, range.endIndex)).length : 0);
      }, 0);
      if (backlogChars < currentConfig.value.minBatchChars) return;
      const anchors = manager.buildSessionProjection().entries;
      const entry = await prepareSharedChain(eligible, 0, { indexer, blockRefs, messages: raw,
        now: Date.now, appendEntry, diagnostics,
        backfill: { spillThreshold: currentConfig.value.spillThreshold, spillPreviewBytes: currentConfig.value.spillPreviewBytes,
          sessionDir: manager.getSessionDir(), sessionId: manager.getSessionId(), assertValid } },
        (role, timestamp) => anchorId(ctx, role, timestamp, anchors), grace, signal);
      assertValid();
      if (!entry || source !== projectionFingerprint(manager.buildSessionProjection().messages)) return;
      const views = chainMembers(entry);
      const current = currentChainViews(raw, ctx);
      const floor = earliestChainStart(views);
      const after = projectContext(raw, ctx.model?.api, ctx, current.concat(views), true, floor).messages;
      const counts = await tokenEstimator.compare(before, after, signal);
      assertValid();
      if (!counts) { lastMaintenanceSource = undefined; return; }
      if (!counts || counts.piBefore <= counts.piAfter || counts.proxyDelta <= 0
        || source !== projectionFingerprint(manager.buildSessionProjection().messages)) return;
      if (indexer.getChainEntries().flatMap(chainMembers).some(member => views.some(view => view.startUserTimestamp === member.startUserTimestamp))) return;
      appendEntry(CUSTOM_TYPE_CHAIN, entry);
      if (!manager.getBranch().some(item => item.type === "custom" && item.customType === CUSTOM_TYPE_CHAIN
        && JSON.stringify(item.data) === JSON.stringify(entry))) return;
      indexer.registerChain(entry);
      const plain = projectContext(raw, ctx.model?.api, ctx, singles, true, floor).messages;
      sharedApprovals.set(entry.blockId, sharedShape(plain, views));
      lowerFloor(supersede, floor);
      statsAccum.addChainsCompressed(views.length);
      occ.rewrite(ctx, counts.piBefore);
    })().catch(error => {
      lastMaintenanceSource = undefined;
      if (!signal.aborted && version === lifecycle) diagnostics.report("backfill-empty", "shared-maintenance", String(error));
    }).finally(() => {
      if (maintenanceAbort === controller) maintenanceAbort = undefined;
      maintenanceTask = undefined;
      const next = maintenanceNext; maintenanceNext = undefined;
      if (next?.version === lifecycle) void maintainChains(next.ctx);
    });
    return maintenanceTask;
  };

  pi.on("turn_end", (_event, ctx) => { void maintainChains(ctx); });
  pi.on("agent_settled", (_event, ctx) => { void maintainChains(ctx); });
  const unsubscribeMaintenance = pi.events.on("metis:condense-maintenance", (data: any) => { data.pending = maintenanceTask; });

  let activeSessionId: string | undefined;
  let projectionContext: ExtensionContext | undefined;
  const unsubscribeProjection = pi.events.on("metis:condense-project", (data: unknown) => {
    if (!data || typeof data !== "object" || !("messages" in data) || !Array.isArray(data.messages)) return;
    const request = data as { sessionId: string; messages: any[]; api?: string; busy?: boolean; maintenance?: boolean };
    if (request.sessionId !== activeSessionId) return;
    if (isFlushing || (occ.isRunning() && !request.maintenance)) { request.busy = true; return; }
    if (projectionContext) indexer.syncSummaryEntries(projectionContext);
    request.messages = projectContext(request.messages, request.api, projectionContext).messages;
  });
  pi.on("context", async (event, ctx) => {
    indexer.syncSummaryEntries(ctx);
    const result = projectContext(event.messages, ctx.model?.api, ctx);
    occ.observeRequest(result.messages);
    if (result.beforeChars !== undefined) statsAccum.setLiveReclaim(result.beforeChars, result.afterChars!);
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
    return result.changed ? { messages: result.messages } : undefined;
  });

  // ── Register context_tree_query tool ──────────────────────────────────────
  registerQueryTool(pi, indexer);

  // ── Register /pruner command + summary message renderer ────────────
  const compactChains = async (ctx: any) => {
    if (isFlushing || isArchiving || isCompactingChains || occ.isRunning()) throw new Error("Another context rewrite is running; retry after it settles");
    const version = lifecycle;
    const abort = new AbortController();
    activeFlushAbort = abort;
    isCompactingChains = true;
    try {
      await stopMaintenance();
      assertCurrent(version); abort.signal.throwIfAborted();
      const result = await compressChains(ctx, 0,
        (type, data) => { assertCurrent(version); pi.appendEntry(type, data); }, undefined, abort.signal);
      assertCurrent(version);
      if (result.compressedEntries.length > 0) {
        statsAccum.persist(pi);
        emitExternalCost(pi, statsAccum);
      }
      return { compressedEntries: result.compressedEntries, skipped: result.skipped.filter((s) => s.reason === "no-summary").length };
    } finally {
      isCompactingChains = false;
      if (activeFlushAbort === abort) activeFlushAbort = undefined;
    }
  };

  registerCommands(
    pi,
    currentConfig,
    flushPending,
    capturePendingBatches,
    () => statsAccum.getStats(),
    () => statsAccum.getLiveReclaim(),
    indexer,
    compactChains,
    () => diagnostics.counts(),
    (ctx: any) => computeMetricsSnapshot(ctx) ?? EMPTY_METRICS_SNAPSHOT,
    () => rearmedPending,
    (config) => {
      // Commands and the settings overlay share this persistence boundary.
      maintenanceNext = undefined; maintenanceAbort?.abort(); tokenEstimator.clear();
      sharedApprovals.clear(); stagedChains.clear(); lastMaintenanceSource = undefined;
      activeFlushAbort?.abort();
      return saveConfig(config);
    },
    (ctx) => occ.refreshStatus(ctx),
  );
  return {
    start, tree,
    shutdown(ctx: ExtensionContext) {
      lifecycle++;
      maintenanceNext = undefined; maintenanceAbort?.abort(); tokenEstimator.clear(); sharedApprovals.clear(); stagedChains.clear();
      activeFlushAbort?.abort();
      clearBoot();
      resetNested();
      occ.shutdown(ctx);
      activeSessionId = undefined;
      projectionContext = undefined;
      pendingBatches.length = 0;
      queuedSummaryKeys.clear();
      unsubscribeProjection();
      unsubscribeMaintenance();
      try { ctx.ui.setStatus(STATUS_WIDGET_ID, undefined); } catch { /* UI may already be gone. */ }
    },
  };
}
