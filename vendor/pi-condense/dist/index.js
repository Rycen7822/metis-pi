/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save <agent-dir>/settings.json `contextPrune` namespace (honors PI_CODING_AGENT_DIR)
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<occurrenceKey, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /pruner command + message renderer
 *
 * Usage:  pi -e .
 */
import { registerOcc } from "./src/occ.js";
import { loadConfig } from "./src/config.js";
import { capImages, imageLimitFor } from "./src/image-cap.js";
import { captureBatch, captureUnindexedBatchesFromSession, deriveLiveTurnIndex, groupBatchesByMode, projectBranchMessages } from "./src/batch-capture.js";
import { ARGUMENT_HISTORY, argumentCandidates, projectArguments } from "./src/argument-history.js";
import { prepareBatch } from "./src/packing.js";
import { summarizeBatch, summarizeBatches, summarizeRange } from "./src/summarizer.js";
import { FallbackController } from "./src/summarizer-fallback.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { pruneMessages, toolResultStub } from "./src/pruner.js";
import { isProtected } from "./src/protected.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, setPruneStatusWidget } from "./src/commands.js";
import { formatSummaryToolCallRefs, makeSummaryDetails, normalizeSummaryToolCallRefs, substituteInlineRefs } from "./src/summary-refs.js";
import { DEFAULT_CONFIG, CUSTOM_TYPE_SUMMARY, CUSTOM_TYPE_STATS, CUSTOM_TYPE_FRONTIER, CUSTOM_TYPE_FLUSH_METRICS, } from "./src/types.js";
import { computeContextMetrics } from "./src/context-metrics.js";
import { StatsAccumulator, emitExternalCost } from "./src/stats.js";
import { PruneFrontierTracker } from "./src/frontier.js";
import { BlockRefIssuer } from "./src/block-refs.js";
import { compressEligible } from "./src/chain-compressor.js";
import { createSupersedeState, earliestChainStart, earliestResultTimestamp, lowerFloor } from "./src/supersede.js";
import { detectChains } from "./src/chain-detector.js";
import { inGraceRecoveryToolCallIds } from "./src/recovery-grace.js";
import { shouldBudgetFlush, shouldDeltaFlush, shouldFrontierGapFlush, usageFraction } from "./src/budget.js";
import { archiveBatches, archiveToolOutput, spillOversizedBatch } from "./src/spill.js";
import { bareToolCallId, occKey } from "./src/occurrence-key.js";
import { DiagnosticSink } from "./src/diagnostics.js";
const EMPTY_METRICS_SNAPSHOT = { openCycleThinkingTokens: 0, largestChainSharePct: 0, frontierGapTokens: 0 };
export default function (pi) {
    // Shared mutable config reference — updated by /pruner commands
    const currentConfig = {
        value: { ...DEFAULT_CONFIG },
    };
    const effectiveProtection = () => currentConfig.value.opportunisticCompaction
        ? { ...currentConfig.value, protectedTools: [...currentConfig.value.protectedTools, "context_tree_query"] }
        : currentConfig.value;
    const protectionPredicate = (name, args) => isProtected(name, args, effectiveProtection());
    // Shared indexer — rebuilt from session on every session_start / session_tree
    const indexer = new ToolCallIndexer();
    const occ = registerOcc(pi, indexer, currentConfig);
    let argumentHistory = [];
    const restoreArguments = (ctx) => {
        argumentHistory = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === ARGUMENT_HISTORY)
            .map(entry => entry.data)
            .filter(group => group?.version === 1 && Array.isArray(group.sourceIds) && Array.isArray(group.fingerprints) && Array.isArray(group.keys) && typeof group.text === "string");
    };
    pi.on("session_start", (_event, ctx) => restoreArguments(ctx));
    pi.on("session_tree", (_event, ctx) => restoreArguments(ctx));
    // Shared stats accumulator — tracks cumulative token/cost stats for summarizer calls
    const statsAccum = new StatsAccumulator();
    // Session-scoped summarizer outage-fallback controller (in-memory; reset on session_start).
    const fallbackController = new FallbackController();
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
    const pendingBatches = [];
    let isFlushing = false;
    let previousFraction = null;
    // Set on session_start/session_tree when the branch rescan finds recoverable
    // work but pendingBatches was just zeroed (reload/tree-switch). Lets the
    // turn_end budget gate fire without a freshly pushed batch. Boolean only —
    // no queue reconstruction; flushPending's own rescan is the data path.
    // Cleared on every non-concurrent flushPending invocation.
    let rearmedPending = false;
    const computeMetricsSnapshot = (ctx) => {
        try {
            // Includes persisted custom_message entries (e.g. this extension's own
            // summary messages) alongside plain "message" entries: both are retained
            // LLM context, so both belong in the largest-chain-share denominator.
            // Shared projection (src/batch-capture.ts projectBranchMessages) so this
            // matches the chain-detection feed sites exactly.
            const branch = projectBranchMessages(ctx.sessionManager.getBranch());
            return computeContextMetrics(branch, frontier.get(), (k) => indexer.isSummarized(k), protectionPredicate);
        }
        catch (err) {
            console.error("pi-condense: context metrics computation failed", err);
            return undefined;
        }
    };
    const isStaleContextError = (err) => err instanceof Error && err.message.includes("This extension ctx is stale");
    const errorMessage = (err) => (err instanceof Error ? err.message : String(err));
    const safeNotify = (ctx, message, type = "info") => {
        try {
            ctx.ui.notify(message, type);
        }
        catch (err) {
            if (!isStaleContextError(err))
                throw err;
        }
    };
    const assistantMessageHasToolCalls = (message) => message?.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((block) => block?.type === "toolCall");
    const isFinalAssistantMessage = (message) => message?.role === "assistant"
        && message.stopReason !== "error" && message.stopReason !== "aborted" && !assistantMessageHasToolCalls(message);
    const trimBatchToPendingRange = (batch) => {
        const currentFrontier = frontier.get();
        let toolCalls = batch.toolCalls;
        // The indexer tells us what was successfully summarized earlier.
        toolCalls = toolCalls.filter((tc) => !indexer.isSummarized(occKey(tc.toolCallId, tc.resultTimestamp)));
        if (toolCalls.length === 0)
            return null;
        // The frontier tells us the last attempted boundary even when the attempt did
        // not persist index entries (e.g. skipped-oversized). When the LLM prunes in
        // the middle of a long tool chain, keep later tool calls from the same turn
        // instead of dropping the whole batch on the floor.
        if (!currentFrontier)
            return { ...batch, toolCalls };
        if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex)
            return null;
        if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex)
            return { ...batch, toolCalls };
        const originalIndex = toolCalls.findIndex((tc) => tc.toolCallId === currentFrontier.lastAttemptedToolCallId);
        if (originalIndex < 0)
            return { ...batch, toolCalls };
        const remaining = toolCalls.slice(originalIndex + 1);
        if (remaining.length === 0)
            return null;
        return { ...batch, toolCalls: remaining };
    };
    const restoreBatches = (batches) => {
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
    const capturePendingBatches = (ctx, opts) => {
        let batches = [];
        try {
            const rawBranch = ctx.sessionManager.getBranch();
            const sourceTurns = new Map();
            let turnIndex = 0;
            for (const entry of rawBranch)
                if (entry.type === "message" && entry.message.role === "assistant")
                    sourceTurns.set(entry.id, turnIndex++);
            const branch = occ.enabled() ? ctx.sessionManager.buildSessionProjection().entries.flatMap((entry) => entry.messages.map((message) => ({ ...entry.sourceEntry, type: "message", message }))) : rawBranch;
            batches = captureUnindexedBatchesFromSession(branch, indexer, protectionPredicate, sourceTurns);
        }
        catch (err) {
            if (opts?.rethrow)
                throw err;
            batches = pendingBatches.slice();
        }
        batches = batches
            .map((batch) => trimBatchToPendingRange(batch))
            .filter((batch) => batch !== null);
        return groupBatchesByMode(batches, currentConfig.value.batchingMode);
    };
    // Summarizes + indexes all pending batches.
    // When options.onProgress is provided batches are processed sequentially
    // (one LLM call each) so the caller can update per-row UI. Otherwise all
    // batches are summarized in parallel (one summarizeBatches call).
    // Runtime delivery is used while the agent/tool loop is active so Pi can place
    // steer messages at protocol-safe boundaries. Session delivery is used only for
    // agent-message's final-message flush, where print-mode Pi may invalidate pi.*
    // while the summarizer LLM call is in flight.
    // Range-summary fuser injected into compressEligible (B). Returns undefined
    // when fuseRangeSummary is off so the compressor keeps the per-batch concat.
    // Each successful fusion folds its usage + bumps the rangesSummarized counter.
    const makeFuseRange = (ctx) => {
        if (!currentConfig.value.chainCompression.fuseRangeSummary)
            return undefined;
        return async (text) => {
            const r = await summarizeRange(text, currentConfig.value, ctx, { controller: fallbackController });
            if (r) {
                statsAccum.add(r.usage);
                statsAccum.addRangesSummarized(1);
            }
            return r?.summaryText ?? null;
        };
    };
    const flushPending = async (ctx, options = {}) => {
        if (isFlushing)
            return { ok: false, reason: "already-flushing" };
        if (options.trigger !== "manual" && occ.deferLocal(ctx))
            return { ok: false, reason: "empty" };
        const beforeRewrite = occ.measure(ctx);
        // Clear on every non-concurrent invocation, regardless of outcome — the
        // rearm is a one-shot nudge for the very next eligible gate check.
        rearmedPending = false;
        // Pre-flush pressure snapshot — recorded once at flush entry so the
        // observability entry reflects what triggered this attempt, not what's
        // left after it ran.
        const entryMetrics = computeMetricsSnapshot(ctx) ?? EMPTY_METRICS_SNAPSHOT;
        const trigger = options.trigger ?? "manual";
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
        let firstChangedMessage;
        let modelAttempted = false;
        let outcome = "empty";
        let appendEntry;
        // Non-fatal by construction: observability must never affect the flush outcome.
        const emitFlushMetricsOnce = () => {
            const entry = {
                ts: Date.now(),
                trigger,
                capturedBatches,
                processedBatches: processedCount,
                stubCount,
                publishedCharsSaved, argumentCharsSaved, firstChangedMessage,
                outcome,
                metrics: entryMetrics,
            };
            const appender = appendEntry
                ? delivery === "runtime" ? (type, data) => pi.appendEntry(type, data) : appendEntry
                : (type, data) => pi.appendEntry(type, data);
            try {
                appender(CUSTOM_TYPE_FLUSH_METRICS, entry);
            }
            catch {
                // non-fatal: observability must never fail the flush
            }
        };
        let batches = [];
        let sessionManager;
        const persistArgumentEntry = (type, data) => appendEntry ? appendEntry(type, data) : pi.appendEntry(type, data);
        try {
            // Bind the session appender as soon as delivery is known, BEFORE the
            // empty-capture/aborted exits below — so emitFlushMetricsOnce's finally
            // emit routes through sessionManager for those exits too, instead of
            // falling back to the (possibly stale, print-mode) pi.appendEntry.
            if (delivery === "session") {
                try {
                    sessionManager = ctx.sessionManager;
                    appendEntry = (customType, data) => sessionManager.appendCustomEntry(customType, data);
                }
                catch (err) {
                    outcome = "error";
                    return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
                }
            }
            // Use pre-captured batches if provided (avoids double-capture when the
            // caller previewed the queue before opening the progress overlay).
            batches = options.previewedBatches ?? capturePendingBatches(ctx);
            if (trigger === "message-end" && batches.length > 1) {
                batches = [{ ...batches[batches.length - 1],
                        assistantText: batches.map((batch) => batch.assistantText).filter(Boolean).join("\n"),
                        toolCalls: batches.flatMap((batch) => batch.toolCalls), }];
            }
            isFlushing = true;
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
                        sessionId: ctx.sessionManager.getSessionId(), appendEntry: persistArgumentEntry });
                    const current = projectContext(ctx.sessionManager.buildSessionProjection().messages, ctx.model?.api, ctx).messages;
                    if (currentConfig.value.enabled && JSON.stringify(effectiveProtection()) === JSON.stringify(argumentProtection)
                        && JSON.stringify(current) === JSON.stringify(before)) {
                        for (const { group } of candidates) {
                            persistArgumentEntry(ARGUMENT_HISTORY, group);
                            argumentHistory.push(group);
                        }
                        const keys = new Set(candidates.flatMap(candidate => candidate.group.keys));
                        batches = batches.map(batch => ({ ...batch, toolCalls: batch.toolCalls.filter(call => !keys.has(occKey(call.toolCallId, call.resultTimestamp))) })).filter(batch => batch.toolCalls.length);
                        publishedAliasesOrArchives = true;
                        argumentCharsSaved += JSON.stringify(before).length - JSON.stringify(after).length;
                        firstChangedMessage = before.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(after[index]));
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
                return { ok: false, reason: "aborted" };
            }
            // Draining the queue since we've captured the state via session or slice.
            // We drain BEFORE the await so concurrent calls (though guarded by isFlushing)
            // or rapid turn-ends don't result in double-summarization.
            pendingBatches.length = 0;
            const appendSummaryMessage = (content, details) => sessionManager.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, content, false, details);
            // Routes alias persistence through whichever delivery is active so the
            // dedup pre-flush pass writes CUSTOM_TYPE_DEDUP_ALIAS entries via the
            // same path the rest of the flush uses.
            const persistAlias = delivery === "runtime"
                ? (type, data) => pi.appendEntry(type, data)
                : appendEntry;
            // Reload/rescan can reach the final boundary without a turn_end callback.
            // Recover fused evidence before any summary can replace its visible tail.
            for (const batch of batches) {
                const toolCalls = batch.toolCalls.filter(call => call.outputArchive?.source);
                if (toolCalls.length === 0)
                    continue;
                const handled = await spillOversizedBatch({ batch: { ...batch, toolCalls }, indexer,
                    config: { spillThreshold: Infinity, spillPreviewBytes: currentConfig.value.spillPreviewBytes, dedupByContentHash: false },
                    sessionDir: ctx.sessionManager.getSessionDir(), sessionId: ctx.sessionManager.getSessionId(), appendEntry: persistAlias });
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
            const pendingAliases = [];
            const dedupEnabled = currentConfig.value.dedupByContentHash;
            const minChars = currentConfig.value.minBatchChars;
            // Keep dedup separate from preparation so failed lookups restore the
            // same pending batches as a flush that has not begun preparing them.
            const dedupRecords = batches.map((batch, index) => ({
                index,
                batch,
                deduped: [],
                dedupedRawChars: 0,
            }));
            if (dedupEnabled) {
                for (const record of dedupRecords) {
                    const batch = record.batch;
                    const remaining = [];
                    for (const tc of batch.toolCalls) {
                        const originalId = tc.spillPath || tc.archiveSource ? undefined : indexer.lookupByContent(tc.toolName, tc.resultText);
                        const key = occKey(tc.toolCallId, tc.resultTimestamp);
                        if (originalId && originalId !== key) {
                            pendingAliases.push([key, originalId, { ...tc, turnIndex: batch.turnIndex, timestamp: batch.timestamp }]);
                            record.deduped.push(tc);
                            record.dedupedRawChars += tc.resultText.length;
                        }
                        else {
                            remaining.push(tc);
                        }
                    }
                    // Shallow-clone the batch so we don't mutate the captured array
                    // (pendingBatches consumers retain the original shape on retry).
                    record.batch = { ...batch, toolCalls: remaining };
                    batches[record.index] = record.batch;
                }
            }
            // Scheduling and commit share complete records; no parallel result or
            // prepared arrays need to be kept aligned with the batch indexes.
            const records = dedupRecords.map((record) => ({
                ...record,
                prepared: prepareBatch(record.batch),
                rawChars: record.batch.toolCalls.reduce((s, tc) => s + tc.resultText.length, 0),
                result: null,
            }));
            // Batches below minBatchChars are trivial: the summarizer is skipped
            // entirely, the frontier still advances, and the original tool-result
            // messages stay verbatim in context. minBatchChars === 0 disables the
            // guard. A fully-deduped batch has empty toolCalls, so it can never take
            // the trivial path (different outcome + notification).
            const isFullyDeduped = (record) => record.deduped.length > 0 && record.batch.toolCalls.length === 0;
            const isTrivial = (record) => minChars > 0 && record.prepared.candidateChars < minChars && record.batch.toolCalls.length > 0;
            const packedResult = (record) => record.prepared.packedBatch.toolCalls.length ? { summaryText: record.prepared.packedText, deterministic: true } : "trivial";
            const summarizable = records.filter((record) => !isFullyDeduped(record) && !isTrivial(record));
            // Only show "summarizing…" if at least one batch will actually be sent
            // to the LLM. An all-trivial flush is purely bookkeeping.
            if (summarizable.length > 0) {
                setPruneStatusWidget(ctx, currentConfig.value, "prune: summarizing…");
            }
            // Summarize the non-trivial subset. When onProgress is provided
            // (/pruner now overlay) we process sequentially so each row can be
            // checked off as its LLM call completes. Trivial and fully-deduped
            // batches emit a "skipped" progress event immediately, with no
            // spinner / no LLM call, and commit record.result directly.
            if (options.onProgress) {
                for (const record of records) {
                    if (isFullyDeduped(record) || isTrivial(record)) {
                        options.onProgress(record.index, records.length, record.batch, "skipped");
                        record.result = isFullyDeduped(record) ? "deduped" : packedResult(record);
                        continue;
                    }
                    options.onProgress(record.index, records.length, record.batch, "start");
                    modelAttempted = true;
                    const r = await summarizeBatch(record.prepared.candidate, currentConfig.value, ctx, {
                        signal: options.signal,
                        controller: fallbackController,
                        onTextProgress: (receivedChars) => options.onBatchTextProgress?.(record.index, records.length, record.batch, receivedChars),
                    });
                    record.result = r;
                    options.onProgress(record.index, records.length, record.batch, r ? "done" : "skipped");
                }
            }
            else {
                // Mark all trivial + fully-deduped slots up front, then call
                // summarizeBatches with only the remaining batches (parallel — one
                // LLM call each).
                for (const record of records) {
                    if (isFullyDeduped(record))
                        record.result = "deduped";
                    else if (isTrivial(record))
                        record.result = packedResult(record);
                }
                if (summarizable.length > 0) {
                    modelAttempted = true;
                    const ntResults = await summarizeBatches(summarizable.map((record) => record.prepared.candidate), currentConfig.value, ctx, {
                        onBatchTextProgress: (ntIndex, _ntTotal, batch, receivedChars) => {
                            const record = summarizable[ntIndex];
                            options.onBatchTextProgress?.(record.index, records.length, batch, receivedChars);
                        },
                        signal: options.signal,
                        controller: fallbackController,
                    });
                    for (let k = 0; k < summarizable.length; k++)
                        summarizable[k].result = ntResults[k];
                }
            }
            // A rejected/oversized model result must not discard a useful local pack.
            // These decisions and alias publication happen after every awaited model call.
            for (const record of records) {
                const result = record.result;
                if ((!result || (typeof result === "object" && !result.deterministic
                    && result.summaryText.length >= record.prepared.candidateChars))
                    && record.prepared.packedBatch.toolCalls.length) {
                    if (result && typeof result === "object" && result.usage)
                        statsAccum.add(result.usage);
                    record.result = packedResult(record);
                }
            }
            for (const [key, originalId, occurrence] of pendingAliases) {
                indexer.registerDuplicate(key, originalId, persistAlias, occurrence);
                publishedAliasesOrArchives = true;
            }
            // Process results in order; stop at first null (individual call failure).
            // Batches before the first failure are persisted; remaining are restored to
            // pendingBatches so they are retried on the next flush.
            const processedBatches = [];
            let totalRawCharCount = 0;
            let totalSummaryCharCount = 0;
            let totalToolCallCount = 0;
            let totalDedupedCount = 0;
            const oversizedBatches = [];
            const trivialBatches = [];
            const dedupedBatches = [];
            let firstFailureIndex = -1;
            // Every tool call phase 1 will stub on the next render is a floor
            // source for supersession: dedup aliases regardless of batch outcome,
            // plus the batch's own calls when the batch was actually indexed.
            const floorSources = records.flatMap((record) => record.deduped);
            for (const [i, record] of records.entries()) {
                const result = record.result;
                if (result === null) {
                    firstFailureIndex = i;
                    break;
                }
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
                    processedBatches.push(record);
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
                    processedBatches.push(record);
                    continue;
                }
                const archivedBatch = result.deterministic ? record.prepared.packedBatch : batch;
                const summaryRefs = indexer.allocateSummaryRefs(archivedBatch);
                const toolNames = archivedBatch.toolCalls.map((tc) => tc.toolName);
                const decorated = substituteInlineRefs(result.summaryText, summaryRefs, toolNames);
                const summaryText = decorated + formatSummaryToolCallRefs(summaryRefs);
                const batchDetails = { ...makeSummaryDetails(archivedBatch, summaryRefs), representation: result.deterministic ? "packed" : "summary" };
                const visible = projectContext(ctx.sessionManager.buildSessionProjection().messages, ctx.model?.api, ctx).messages;
                const replacements = new Map(archivedBatch.toolCalls.map((call, i) => [occKey(call.toolCallId, call.resultTimestamp), { call, ref: summaryRefs[i].shortId }]));
                let replaced = 0;
                const proposed = visible.map((message) => {
                    if (message.role !== "toolResult")
                        return message;
                    const candidate = replacements.get(occKey(message.toolCallId, message.timestamp));
                    if (!candidate || protectionPredicate(candidate.call.toolName, candidate.call.args))
                        return message;
                    replaced++;
                    return toolResultStub(message, { ...candidate.call, turnIndex: archivedBatch.turnIndex, timestamp: archivedBatch.timestamp }, candidate.ref);
                });
                proposed.push({ role: "custom", customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: false, details: batchDetails, timestamp: Date.now() });
                const charsSaved = JSON.stringify(visible).length - JSON.stringify(proposed).length;
                const shouldSkipOversized = replaced !== archivedBatch.toolCalls.length || charsSaved <= 0;
                if (result.usage)
                    statsAccum.add(result.usage);
                totalRawCharCount += record.rawChars + dedupRawChars;
                totalSummaryCharCount += summaryText.length;
                totalToolCallCount += batch.toolCalls.length + dedupCount;
                totalDedupedCount += dedupCount;
                try {
                    if (!shouldSkipOversized) {
                        publishedCharsSaved += charsSaved;
                        const first = visible.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(proposed[index]));
                        firstChangedMessage = firstChangedMessage === undefined ? first : Math.min(firstChangedMessage, first);
                        // Write one hidden summary message per turn and index its tool calls.
                        // `display: false` keeps the summary in future LLM context (convertToLlm
                        // ignores `display`) while suppressing the full markdown block from Pi's
                        // main window; rebuild keys on customType, not display.
                        const batchOccurrenceKeys = archivedBatch.toolCalls.map((tc) => occKey(tc.toolCallId, tc.resultTimestamp));
                        if (delivery === "runtime") {
                            pi.sendMessage({ customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: false, details: batchDetails }, { deliverAs: "steer" });
                            indexer.registerSummaryRefs(summaryRefs);
                            indexer.addBatch(archivedBatch, (type, data) => pi.appendEntry(type, data));
                        }
                        else {
                            appendSummaryMessage(summaryText, batchDetails);
                            indexer.registerSummaryRefs(summaryRefs);
                            indexer.addBatch(archivedBatch, appendEntry);
                        }
                        // Keep the in-memory summary-body registry current so chain compression
                        // can build synthetic chain messages without rescanning session entries.
                        indexer.registerSummaryBody(batchOccurrenceKeys, summaryText);
                        stubCount += archivedBatch.toolCalls.length + dedupCount;
                        floorSources.push(...archivedBatch.toolCalls);
                    }
                    else {
                        stubCount += dedupCount;
                        oversizedBatches.push(record);
                    }
                }
                catch (err) {
                    // Persistence error mid-loop: stop here, restore this and remaining batches.
                    if (isStaleContextError(err)) {
                        restoreBatches(batches.slice(i));
                        // Advance frontier to what we managed to persist before this point
                        break;
                    }
                    throw err;
                }
                processedBatches.push(record);
            }
            lowerFloor(supersede, earliestResultTimestamp(floorSources));
            // Restore unprocessed batches (those at and after the first failure)
            if (firstFailureIndex >= 0) {
                restoreBatches(batches.slice(firstFailureIndex));
            }
            if (processedBatches.length === 0) {
                // Nothing was persisted (all calls failed or first call failed)
                setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
                outcome = "error";
                return { ok: false, reason: "summarizer-failed" };
            }
            // Advance frontier to the last batch we actually processed. A fully
            // deduped batch has `toolCalls === []` (the dedup pass shallow-cloned
            // the batch with only the remaining non-dup calls). In that case, fall
            // back to the record's deduped calls so the frontier anchor still points
            // at a real tool call — otherwise we'd dereference `undefined.toolCallId`
            // and the whole flush would throw, silently dropping the dedup-alias
            // write's effect on subsequent flushes.
            const lastRecord = processedBatches[processedBatches.length - 1];
            const lastBatch = lastRecord.batch;
            const lastBatchAllTCs = lastBatch.toolCalls.length > 0 ? lastBatch.toolCalls : lastRecord.deduped;
            const lastTC = lastBatchAllTCs[lastBatchAllTCs.length - 1];
            // Outcome precedence: any actual summary wins; oversized beats deduped
            // beats trivial. (Trivial and deduped are both zero-LLM-cost; deduped
            // is the more interesting signal because it implies the indexer caught
            // a redundancy, so it wins the tiebreaker.)
            const actuallyFlushedCount = processedBatches.length - trivialBatches.length - oversizedBatches.length - dedupedBatches.length;
            const flushOutcome = actuallyFlushedCount > 0
                ? "summarized"
                : oversizedBatches.length > 0
                    ? "skipped-oversized"
                    : dedupedBatches.length > 0
                        ? "skipped-deduped"
                        : "skipped-trivial";
            const frontierSnapshot = {
                lastAttemptedToolCallId: lastTC.toolCallId,
                lastAttemptedToolName: lastTC.toolName,
                lastAttemptedTurnIndex: lastBatch.turnIndex,
                lastAttemptedTimestamp: lastBatch.timestamp,
                attemptedBatchCount: processedBatches.length,
                attemptedToolCallCount: totalToolCallCount,
                rawCharCount: totalRawCharCount,
                summaryCharCount: totalSummaryCharCount,
                outcome: flushOutcome,
            };
            try {
                if (delivery === "runtime") {
                    frontier.advance(frontierSnapshot);
                    frontier.persist(pi);
                    statsAccum.persist(pi);
                }
                else {
                    frontier.advance(frontierSnapshot);
                    appendEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
                    try {
                        appendEntry(CUSTOM_TYPE_STATS, statsAccum.getStats());
                    }
                    catch {
                        // Ignore stats persistence failures; the prune result and frontier are the contract.
                    }
                }
            }
            catch (err) {
                // Batches were summarized/persisted before the frontier/stats write failed;
                // reflect that in processedBatches rather than reporting 0.
                processedCount = processedBatches.length;
                outcome = "error";
                return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
            }
            setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
            emitExternalCost(pi, statsAccum);
            // Automatic history has one owner: the settled per-batch projection.
            // A second rolling chain pass would rewrite older cached prefixes. Explicit
            // /pruner compact-chains remains available and preserves program-owned refs.
            // Notify about any batches that were skipped — either oversized or
            // trivial. Neither is an error: the pruner correctly chose not to grow
            // context (oversized) or to skip the LLM call entirely (trivial). Both
            // are silenced by `quietOversizedSkips`, which acts as a single
            // "quiet all non-error skips" toggle.
            if (!currentConfig.value.quietOversizedSkips) {
                for (const record of oversizedBatches) {
                    const batch = record.batch;
                    const slot = record.result;
                    const batchSummaryLen = slot && slot !== "trivial" && slot !== "deduped" ? slot.summaryText.length : 0;
                    safeNotify(ctx, `pruner: skipped pruning turn ${batch.turnIndex} (${batch.toolCalls.length} tool call${batch.toolCalls.length === 1 ? "" : "s"}) — summary was ${batchSummaryLen} chars vs ${record.rawChars} raw chars; frontier advanced past this range`, "info");
                }
                for (const record of trivialBatches) {
                    const batch = record.batch;
                    safeNotify(ctx, `pruner: skipped pruning turn ${batch.turnIndex} (${batch.toolCalls.length} tool call${batch.toolCalls.length === 1 ? "" : "s"}) — only ${record.rawChars} raw chars (< minBatchChars=${minChars}); no LLM call made; frontier advanced past this range`, "info");
                }
                for (const record of dedupedBatches) {
                    const batch = record.batch;
                    const n = record.deduped.length;
                    safeNotify(ctx, `pruner: deduplicated ${n} tool call${n === 1 ? "" : "s"} (turn ${batch.turnIndex}, ${record.dedupedRawChars} raw chars) against earlier prunes; no LLM call made; frontier advanced past this range`, "info");
                }
                if (totalDedupedCount > 0 && dedupedBatches.length === 0) {
                    // Partial-dedup case: some tool calls were dedup'd but the rest
                    // of the batch went through the summarizer. Surface a single
                    // aggregate notification so users see the savings.
                    safeNotify(ctx, `pruner: deduplicated ${totalDedupedCount} tool call${totalDedupedCount === 1 ? "" : "s"} against earlier prunes (no LLM call for those); remaining tool calls were summarized normally.`, "info");
                }
            }
            // Very end of the try block, deliberately after (and outside) the
            // chain-compression block's own try/catch above: a compression failure
            // must not eat this entry — the summarization phase already succeeded.
            processedCount = processedBatches.length;
            outcome = flushOutcome;
            const returnReason = flushOutcome === "summarized" ? "flushed" : flushOutcome;
            return {
                ok: true,
                reason: returnReason,
                batchCount: processedBatches.length,
                toolCallCount: totalToolCallCount,
                rawCharCount: totalRawCharCount,
                summaryCharCount: totalSummaryCharCount,
                dedupedCount: totalDedupedCount,
            };
        }
        catch (err) {
            restoreBatches(batches);
            outcome = "error";
            // When the abort signal fired, summarizeBatch rethrows rather than
            // swallowing the error.  Don't show a UI error — the user intended this.
            if (options.signal?.aborted) {
                setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
                return { ok: false, reason: "aborted" };
            }
            if (isStaleContextError(err)) {
                return { ok: false, reason: "stale-context", error: errorMessage(err) };
            }
            safeNotify(ctx, `pruner: summarization failed: ${errorMessage(err)}`, "error");
            return { ok: false, reason: "failed", error: errorMessage(err) };
        }
        finally {
            isFlushing = false;
            if (stubCount > 0 || publishedAliasesOrArchives || modelAttempted)
                occ.rewrite(ctx, beforeRewrite);
            emitFlushMetricsOnce();
        }
    };
    // ── session_start: restore config + index + stats ────────────────────────────────
    /** Rebuild the branch-scoped index, chain-id counter and stats accumulator. */
    const rebuildBranchIndex = (ctx) => {
        indexer.reconstructFromSession(ctx);
        blockRefs.rebuildFrom(indexer.getChainEntries().map((e) => e.blockId));
        statsAccum.reconstructFromSession(ctx);
    };
    /** Reset branch-scoped diagnostics/frontier state, drop the old branch's queued
     * batches, then re-probe for recoverable pending work and refresh the footer. */
    const restoreBranchPending = (ctx) => {
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
            }
            catch (err) {
                console.error("pi-condense: reload rearm probe failed", err);
            }
        }
        // Update footer status
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
    };
    pi.on("session_start", async (_event, ctx) => {
        // Load config from <agent-dir>/settings.json `contextPrune` key (honors PI_CODING_AGENT_DIR)
        currentConfig.value = await loadConfig();
        rebuildBranchIndex(ctx);
        // The fallback controller is per-session runtime state, not branch state.
        fallbackController.reset();
        restoreBranchPending(ctx);
        if (currentConfig.value.showPruneStatusLine) {
            ctx.ui.setWidget("pruner-boot", [
                `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
            ], { placement: "belowEditor" });
            setTimeout(() => {
                try {
                    ctx.ui.setWidget("pruner-boot", undefined);
                }
                catch {
                    // UI owner may be gone after session replacement.
                }
            }, 10000).unref?.();
        }
    });
    // Rebuild index and stats after tree navigation too (branch may have different history)
    pi.on("session_tree", async (_event, ctx) => {
        rebuildBranchIndex(ctx);
        restoreBranchPending(ctx);
    });
    // Cache is a per-model prefix; these three moments are cold regardless, so
    // activating every pending supersession here costs no extra cache miss.
    pi.on("model_select", async () => {
        supersede.floor = 0;
    });
    pi.on("session_compact", async () => {
        supersede.floor = 0;
    });
    pi.on("thinking_level_select", async () => {
        supersede.floor = 0;
    });
    // ── turn_end: capture batch, flush immediately or queue ──────────────────
    pi.on("turn_end", async (event, ctx) => {
        if (!currentConfig.value.enabled)
            return;
        const hasToolResults = event.toolResults && event.toolResults.length > 0;
        // Text-only final turns are handled by message_end in agent-message mode.
        // In print mode, turn_end can fire after session shutdown, so do not start
        // deferred LLM work from this late lifecycle event — UNLESS a reload probe
        // (session_start/session_tree) found recoverable pending work: that flag
        // must still reach the budget/delta gate below without a freshly captured
        // batch on this turn.
        if (!hasToolResults && !rearmedPending)
            return;
        let pushedBatch = false;
        if (hasToolResults) {
            // Live batches must be numbered in the frontier's session-wide domain, not
            // Pi's run-local event.turnIndex (which resets on agent_start, #16). The
            // branch at turn_end already holds the just-ended assistant message (pi
            // persists it at message_end, a strictly earlier event), so the derived
            // index is the rescan index of this turn.
            let liveTurnIndex = event.turnIndex;
            let branch;
            try {
                branch = ctx.sessionManager.getBranch();
            }
            catch {
                // Transient getBranch failure must never block the turn; fall back to
                // the run-local index (pre-#16 behavior). The flush-time rescan still
                // recovers the batch.
            }
            if (branch)
                liveTurnIndex = deriveLiveTurnIndex(branch);
            const capturedBatch = captureBatch(event.message, event.toolResults, liveTurnIndex, Date.now());
            // Drop user-protected tool/path results so they stay verbatim in context.
            // Filtering at capture time keeps the
            // underlying assistant `toolCall` block AND its `ToolResultMessage`
            // untouched in Pi's session/event stream — only the in-memory
            // CapturedBatch is pruned, which is exactly what we want.
            const filtered = {
                ...capturedBatch,
                toolCalls: capturedBatch.toolCalls.filter((tc) => !protectionPredicate(tc.toolName, tc.args)),
            };
            // Eager spill: offload oversized single results to sidecar files before they
            // ever reach a request. addBatch inside marks them isSummarized, so
            // trimBatchToPendingRange drops them from the pending set below. Best-effort:
            // a spill failure leaves the result inline for the normal flush pipeline.
            try {
                const beforeRewrite = occ.measure(ctx);
                const deferred = occ.deferLocal(ctx);
                if (occ.isCapacityWaiting()) {
                    for (const call of capturedBatch.toolCalls) {
                        if (!call.outputArchive || indexer.getRecord(occKey(call.toolCallId, call.resultTimestamp)))
                            continue;
                        const archive = { indexer, sessionDir: ctx.sessionManager.getSessionDir(), sessionId: ctx.sessionManager.getSessionId(),
                            appendEntry: (type, data) => ctx.sessionManager.appendCustomEntry(type, data) };
                        await archiveToolOutput(call, capturedBatch, archive);
                        indexer.addBatch({ ...capturedBatch, toolCalls: [call] }, archive.appendEntry, true);
                    }
                }
                const handled = deferred ? new Set() : await spillOversizedBatch({
                    batch: filtered,
                    indexer,
                    config: {
                        spillThreshold: currentConfig.value.spillThreshold,
                        spillPreviewBytes: currentConfig.value.spillPreviewBytes,
                        dedupByContentHash: currentConfig.value.dedupByContentHash,
                    },
                    sessionDir: ctx.sessionManager.getSessionDir(),
                    sessionId: ctx.sessionManager.getSessionId(),
                    appendEntry: (type, data) => ctx.sessionManager.appendCustomEntry(type, data),
                });
                if (handled.size)
                    occ.rewrite(ctx, beforeRewrite);
            }
            catch {
                // best-effort; never block the turn
            }
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
                    safeNotify(ctx, `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`, "info");
                }
            }
        }
        // Mirrors main's `if (!batch) return;`: no freshly pushed batch this turn
        // means no gate evaluation, regardless of leftover pendingBatches from an
        // earlier turn — UNLESS a reload probe armed rearmedPending, in which case
        // the gate below must still run.
        if (!pushedBatch && !rearmedPending)
            return;
        // Final-reply mode defers pressure hints to that same boundary. Pi's native
        // capacity compaction remains the emergency guard during a long tool loop.
        if (currentConfig.value.pruneOn === "agent-message")
            return;
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
        if (f != null)
            previousFraction = f;
        const n = pendingBatches.length;
        if ((n > 0 || rearmedPending) && !isFlushing && (budgetHit || deltaHit || gapHit)) {
            const reason = budgetHit ? "context budget reached" : deltaHit ? "context jumped this turn" : "un-pruned tail exceeded frontier gap threshold";
            // Always surface this flush (even when the routine status line is off): it's a
            // significant, infrequent event — context crossed a threshold, jumped sharply
            // this turn, or the un-pruned tail grew past the gap threshold — and it
            // self-throttles because pendingBatches is drained right after.
            safeNotify(ctx, n > 0
                ? `pruner: ${reason} — compacting ${n} pending turn${n === 1 ? "" : "s"}`
                : `pruner: ${reason} — compacting work recovered after reload`, "info");
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
        if (!currentConfig.value.enabled)
            return;
        if (currentConfig.value.pruneOn !== "agent-message")
            return;
        if (!isFinalAssistantMessage(event.message))
            return;
        await flushPending(ctx, { delivery: "session", closingMessage: event.message, trigger: "message-end" });
    });
    // ── agent_end: last-chance cleanup only ─────────────────────────────────────
    // agent-message normally flushes on message_end. By agent_end, print-mode Pi may
    // already be disposing the session, so avoid starting a best-effort LLM call here.
    pi.on("agent_end", async (_event, ctx) => {
        if (!currentConfig.value.enabled)
            return;
        if (pendingBatches.length === 0 && !rearmedPending)
            return;
        setPruneStatusWidget(ctx, currentConfig.value, pendingBatches.length > 0 ? `prune: ${pendingBatches.length} pending` : "prune: recovered pending (reload)");
    });
    // ── context: prune summarized tool results from next LLM call ─────────────
    const projectContext = (input, api, ctx) => {
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
        if (!currentConfig.value.enabled)
            return { messages, changed };
        // A context edit changes effective evidence, not the immutable archive. Keep
        // edited sources visible and remove stale summaries of the same source group.
        const editedToolIds = new Set();
        if (occ.enabled() && ctx) {
            for (const entry of ctx.sessionManager.buildSessionProjection().entries) {
                if (entry.sourceEntry.type !== "message")
                    continue;
                const original = entry.sourceEntry.message;
                if (original.role !== "toolResult" && original.role !== "assistant")
                    continue;
                const effective = entry.messages[0];
                if (entry.messages.length === 1 && effective && "content" in effective && JSON.stringify(effective.content) === JSON.stringify(original.content))
                    continue;
                if (original.role === "toolResult")
                    editedToolIds.add(original.toolCallId);
                if (original.role === "assistant" && Array.isArray(original.content)) {
                    for (const block of original.content)
                        if (block.type === "toolCall")
                            editedToolIds.add(block.id);
                }
            }
            const summaryIds = (message) => message.customType === CUSTOM_TYPE_SUMMARY
                ? normalizeSummaryToolCallRefs(message.details).map(ref => bareToolCallId(ref.toolCallId)) : [];
            // One summary may cover multiple occurrences; preserve the whole group.
            let previousSize = -1;
            while (previousSize !== editedToolIds.size) {
                previousSize = editedToolIds.size;
                for (const message of ctx.sessionManager.buildSessionProjection().messages) {
                    const ids = summaryIds(message);
                    if (ids.some(id => editedToolIds.has(id)))
                        ids.forEach(id => editedToolIds.add(id));
                }
            }
            const filtered = messages.filter(message => !summaryIds(message).some(id => editedToolIds.has(id)));
            if (filtered.length !== messages.length) {
                messages = filtered;
                changed = true;
            }
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
        const result = pruneMessages(messages, indexer, currentConfig.value.chainCompression, occ.enabled() ? { ...currentConfig.value.purgeErrors, enabled: false } : currentConfig.value.purgeErrors, effectiveProtection(), currentConfig.value.recoveryGraceTurns, diagnostics, occ.enabled() ? undefined : { state: supersede, isProtected: protectionPredicate }, editedToolIds);
        if (result.pruned) {
            messages = result.messages;
            changed = true;
        }
        return { messages, changed, beforeChars: argumentsChanged ? JSON.stringify(input).length : result.beforeChars,
            afterChars: argumentsChanged ? JSON.stringify(messages).length : result.afterChars };
    };
    let activeSessionId;
    let projectionContext;
    const unsubscribeProjection = pi.events.on("metis:condense-project", (data) => {
        if (!data || typeof data !== "object" || !("messages" in data) || !Array.isArray(data.messages))
            return;
        const request = data;
        if (request.sessionId !== activeSessionId)
            return;
        if (isFlushing || (occ.isRunning() && !request.maintenance)) {
            request.busy = true;
            return;
        }
        request.messages = projectContext(request.messages, request.api, projectionContext).messages;
    });
    pi.on("session_start", (_event, ctx) => { activeSessionId = ctx.sessionManager.getSessionId(); projectionContext = ctx; });
    pi.on("session_shutdown", () => { activeSessionId = undefined; projectionContext = undefined; unsubscribeProjection(); });
    pi.on("context", async (event, ctx) => {
        const result = projectContext(event.messages, ctx.model?.api, ctx);
        occ.observeRequest(result.messages);
        if (result.beforeChars !== undefined)
            statsAccum.setLiveReclaim(result.beforeChars, result.afterChars);
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts());
        return result.changed ? { messages: result.messages } : undefined;
    });
    // ── Register context_tree_query tool ──────────────────────────────────────
    registerQueryTool(pi, indexer);
    // ── Register /pruner command + summary message renderer ────────────
    const compactChains = async (ctx) => {
        const beforeRewrite = occ.measure(ctx);
        const branchMessages = projectBranchMessages(ctx.sessionManager.getBranch());
        const chains = detectChains(branchMessages, protectionPredicate);
        const inGrace = inGraceRecoveryToolCallIds(branchMessages, currentConfig.value.recoveryGraceTurns);
        const result = await compressEligible(chains, 0, // effectiveK=0: compress every closed chain not already compressed
        {
            indexer,
            blockRefs,
            appendEntry: (type, data) => pi.appendEntry(type, data),
            now: () => Date.now(),
            fuseRange: makeFuseRange(ctx),
            messages: branchMessages,
            diagnostics,
            backfill: {
                spillThreshold: currentConfig.value.spillThreshold,
                spillPreviewBytes: currentConfig.value.spillPreviewBytes,
                sessionDir: ctx.sessionManager.getSessionDir(),
                sessionId: ctx.sessionManager.getSessionId(),
            },
        }, inGrace);
        if (result.compressedEntries.length > 0) {
            occ.rewrite(ctx, beforeRewrite);
            lowerFloor(supersede, earliestChainStart(result.compressedEntries));
            statsAccum.addChainsCompressed(result.compressedEntries.length);
            statsAccum.persist(pi);
            emitExternalCost(pi, statsAccum);
        }
        return { compressedEntries: result.compressedEntries, skipped: result.skipped.filter((s) => s.reason === "no-summary").length };
    };
    registerCommands(pi, currentConfig, flushPending, capturePendingBatches, () => statsAccum.getStats(), () => statsAccum.getLiveReclaim(), indexer, compactChains, () => diagnostics.counts(), (ctx) => computeMetricsSnapshot(ctx) ?? EMPTY_METRICS_SNAPSHOT, () => rearmedPending, undefined, (ctx) => occ.refreshStatus(ctx));
}
