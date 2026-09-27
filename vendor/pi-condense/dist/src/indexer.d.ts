import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, ChainCompressionEntry, ToolCallRecord } from "./types.js";
import { type SummaryToolCallRef } from "./summary-refs.js";
export declare class ToolCallIndexer {
    /** occurrence key (`id@resultTimestamp`, or bare id for legacy) -> record */
    private index;
    /** bare toolCallId -> its occurrence keys, in insertion order */
    private bareIdToKeys;
    private aliasToToolCallId;
    private toolCallIdToAlias;
    private nextShortAliasNumber;
    /**
     * hash -> original occurrence key (or legacy bare id). Populated as
     * records enter the indexer (`addBatch`) and on `reconstructFromSession`.
     * Drives the pre-flush dedup pass via `lookupByContent`.
     */
    private contentHashToOriginal;
    /**
     * Per-batch summary bodies for chain-compression summary text lookup.
     * Each entry maps a set of toolCallIds to the summary's markdown body.
     * Populated from CUSTOM_TYPE_SUMMARY entries at rebuild time and via
     * `registerSummaryBody` after a successful flush.
     */
    private summaryBodies;
    /** Compressed chains, keyed on startUserTimestamp for O(1) dedup checks. */
    private chainRegistry;
    /**
     * Rebuilds the in-memory index from session history by scanning all
     * custom entries with customType === CUSTOM_TYPE_INDEX.
     */
    reconstructFromSession(ctx: ExtensionContext): void;
    /**
     * Indexes a single record under its occurrence key and updates the
     * bare-id reverse index + legacy-shape tracking. Shared by `addBatch` and
     * `reconstructFromSession` so both paths key identically.
     */
    private indexRecord;
    /**
     * Returns true if the given occurrence key has been pruned - either
     * because its full record is in the index, or because it has been
     * registered as an alias of an already-indexed original via the
     * content-hash dedup pass.
     *
     * STRICT lookup: no bare-id uniquification happens here, unlike
     * `resolveToolCallId`/`getRecord`/`getRecordsForId`. A bare-id fallback
     * in this method would be a silent correctness bug - it would report an
     * unrelated LIVE tool result as summarized merely because an older
     * occurrence of the same provider-reused id was summarized. Callers that
     * need bare-id resolution use `resolveToolCallId` (unambiguous case) or
     * `getRecordsForId` (all occurrences).
     *
     * `pruneMessages` uses this to decide whether to stub-replace a
     * ToolResultMessage; both index and dedup-alias hits need the same
     * treatment.
     */
    isSummarized(occurrenceKey: string): boolean;
    /**
     * Returns the full runtime index map.
     */
    getIndex(): Map<string, ToolCallRecord>;
    /**
     * Register short aliases for a summary message so future recovery queries can
     * resolve the short ids back to the persisted toolCallIds.
     */
    registerSummaryRefs(refs: SummaryToolCallRef[]): void;
    /**
     * Allocates short aliases for a batch's tool calls and registers them in the
     * runtime alias map.
     */
    allocateSummaryRefs(batch: CapturedBatch): SummaryToolCallRef[];
    /**
     * Resolve a short alias, a duplicate's occurrence key, or a full occurrence
     * key (or legacy bare id) to the canonical occurrence key backing it.
     *
     * Order:
     *   1. Direct hit in `this.index` (canonical occurrence key).
     *   2. Dedup alias → underlying original occurrence key.
     *   3. Short-ref (`t3`) → underlying occurrence key.
     *   4. Bare id with exactly ONE occurrence → that occurrence's key.
     *
     * A bare id with several occurrences resolves to undefined here — that
     * ambiguity is fail-closed by design; callers that must handle collisions
     * use `getRecordsForId`.
     *
     * Used by `getRecord`/`lookupToolCalls` so `context_tree_query` returns
     * the original record for both short refs and dedup'd ids.
     */
    resolveToolCallId(input: string): string | undefined;
    /**
     * Returns the short alias (e.g. "t1") registered for the given occurrence
     * key (or legacy bare id), or undefined if none was registered. Legacy
     * summaries written before short-refs were introduced map shortId === key
     * and intentionally return undefined here so callers (e.g. the pruner
     * stub) can fall back to the key itself.
     */
    getShortRefForToolCallId(occurrenceKey: string): string | undefined;
    /**
     * Look up a single record by occurrence key, short alias, or (unambiguous)
     * bare id (used by query tool).
     */
    getRecord(toolCallIdOrAlias: string): ToolCallRecord | undefined;
    /**
     * Looks up multiple tool call records by occurrence key / short alias.
     * Skips any not found.
     */
    lookupToolCalls(toolCallIds: string[]): ToolCallRecord[];
    /**
     * Every record a bare toolCallId, occurrence key, or short ref can denote,
     * sorted by `resultTimestamp ?? timestamp` ascending. A bare id with
     * multiple occurrences returns all of them; an occurrence key/short ref
     * returns exactly the one record it resolves to.
     *
     * The sort is display order for a multi-match listing, not a causal
     * clock: it mixes a tool-result timestamp with a batch-capture timestamp,
     * which are both epoch ms from the same session and adequate for a
     * listing but not a strict ordering guarantee.
     */
    getRecordsForId(input: string): ToolCallRecord[];
    /**
     * True when the bare id is LEGACY-ONLY: a record is indexed under the
     * bare key AND that bare id has no occurrence-keyed siblings. A legacy
     * record has no `resultTimestamp`, so `occKey` keys it under its bare id
     * - meaning it already lives in `index` under that exact string; this is
     * a derivation, not a separate container.
     *
     * A session that spans the upgrade can hold BOTH a legacy bare record
     * and modern occurrence records under the same bare id (e.g. legacy
     * `bash_23` plus `bash_23@2150`). In that mixed case this must return
     * false: a live, unrelated `bash_23@9150` result is not the legacy one,
     * and a permissive true here would stub it with the stale legacy content
     * - the exact collision this bare-id path exists to avoid re-introducing.
     * `bareIdToKeys` already tracks every key minted under a bare id, so a
     * single-key entry is the discriminant. The pruner's only sanctioned
     * bare-id path.
     */
    hasLegacyBareRecord(toolCallId: string): boolean;
    /**
     * Returns the toolCallId of an already-indexed record whose
     * `(toolName, exact resultText)` matches the supplied input, or
     * `undefined` if there is no match. Driven by the in-memory
     * `contentHashToOriginal` map; only consults records that entered the
     * indexer via `addBatch` (i.e. previous successful prunes) or were
     * replayed at reconstruction time.
     *
     * Returns `undefined` for hash misses; consumers should treat that as
     * "not a duplicate".
     */
    lookupByContent(toolName: string, resultText: string): string | undefined;
    /** Duplicate bodies still have independent execution identity and recall refs. */
    registerDuplicate(newKey: string, originalKey: string, appendEntry: (customType: string, data?: unknown) => void, occurrence?: ToolCallRecord): void;
    private unknownLegacyOccurrence;
    /**
     * Stores summary body text keyed by the toolCallIds it covers.
     * Called after a successful flush so `getPerBatchSummaryTextForToolCallIds`
     * can serve chain summaries without re-scanning session entries.
     */
    registerSummaryBody(toolCallIds: string[], text: string): void;
    /** Returns true if at least one stored summary covers any of the given toolCallIds. */
    hasPerBatchSummaryCoveringAny(toolCallIds: string[]): boolean;
    /**
     * Returns the distinct per-batch summary texts whose toolCallIds overlap the
     * given set (dedup'd by text). Used to build the synthetic chain body and as
     * the fusion input for the range summarizer; the >= 2 count gates fusion.
     */
    getPerBatchSummariesForToolCallIds(toolCallIds: string[]): string[];
    /**
     * Returns the concatenated summary text for all per-batch summaries whose
     * toolCallIds overlap the given set, joined with "\n\n".
     * Used by chain-range-prune to build the synthetic chain message body.
     */
    getPerBatchSummaryTextForToolCallIds(toolCallIds: string[]): string;
    /**
     * Returns the short t<N> refs for the given toolCallIds.
     * Skips ids with no registered short ref (tool calls not yet summarized).
     */
    getToolRefsForToolCallIds(toolCallIds: string[]): string[];
    /** Registers a chain entry in the in-memory registry. Called by chain-compressor after persisting. */
    registerChain(entry: ChainCompressionEntry): void;
    /** Returns all compressed chain entries sorted by startUserTimestamp ascending. */
    getChainEntries(): ChainCompressionEntry[];
    /** O(n) scan over the chain registry by blockId. Registry is small (bounded by session chain count). */
    findChainEntryByBlockId(blockId: string): ChainCompressionEntry | undefined;
    /**
     * Adds all tool calls from a captured batch to the runtime index and
     * persists an IndexEntryData entry to the session via the supplied
     * appendEntry callback. The callback exists so callers can route the
     * append through either `pi.appendEntry` (runtime delivery) or
     * `ctx.sessionManager.appendCustomEntry` (session delivery), without the
     * indexer needing to know which one is active.
     */
    addBatch(batch: CapturedBatch, appendEntry: (customType: string, data?: unknown) => void, archiveOnly?: boolean): void;
    /**
     * Atomic recoverability backfill for an uncovered chain (spec
     * 2026-08-14-uncovered-chain-deterministic-backfill). Append-before-commit:
     * in-memory maps are touched only after the index entry persisted. Records
     * never seed contentHashToOriginal (dedup poison guard). Refs ride the
     * entry so they survive session restart without a summary message.
     */
    backfillChainRecords(records: ToolCallRecord[], opts: {
        spillThreshold: number;
        spillPreviewBytes: number;
        sessionDir: string;
        sessionId: string;
        appendEntry: (customType: string, data?: unknown) => void;
    }): Promise<SummaryToolCallRef[]>;
}
