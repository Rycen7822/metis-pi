import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  CapturedBatch,
  ChainCompressionEntry,
  DedupAliasEntryData,
  IndexEntryData,
  ToolCallRecord,
} from "./types.ts";
import {
  CUSTOM_TYPE_CHAIN,
  CUSTOM_TYPE_DEDUP_ALIAS,
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_SUMMARY,
} from "./types.ts";
import { chainMembers, isSharedChain } from "./chain-model.ts";
import { customEntries } from "./custom-entries.ts";
import { readHistoryEntries, reverseBranchEntryReferences, type SessionEntryReference } from "../session-history.ts";
import {
  buildShortToolCallRefs,
  normalizeSummaryToolCallRefs,
  summaryGroupMembers,
  type SummaryToolCallRef,
} from "./summary-refs.ts";
import { captureUnindexedBatchesFromSession } from "./batch-capture.ts";
import { setImmediate } from "node:timers/promises";
import { hashToolResult } from "./content-hash.ts";
import { occKey, parseOccKey } from "./occurrence-key.ts";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { applySpill, blobDirFor, blobPathFor } from "./spill.ts";

type DirectoryMetadata = Pick<ToolCallRecord, "toolCallId" | "resultTimestamp" | "archiveOnly" | "contentHash"
  | "toolName" | "parentToolCallId" | "isError" | "metadataUnavailable" | "spillPath" | "archiveComplete" | "archiveSource">;
function argumentPreview(args: unknown): string {
  const json = JSON.stringify(args) ?? "";
  // Copy bounded UTF-16 units: a sliced preview must not retain its large backing string.
  return json.length <= 256 ? json : Buffer.from(json.slice(0, 256), "utf16le").toString("utf16le");
}
function directoryMetadata(record: DirectoryMetadata): DirectoryMetadata {
  const { toolCallId, resultTimestamp, archiveOnly, contentHash, toolName, parentToolCallId,
    isError, metadataUnavailable, spillPath, archiveComplete, archiveSource } = record;
  return { toolCallId, resultTimestamp, archiveOnly, contentHash, toolName, parentToolCallId,
    isError, metadataUnavailable, spillPath, archiveComplete, archiveSource };
}
export type ToolStubEvidence = Pick<ToolCallRecord, "toolName" | "spillPath" | "spillBytes" | "resultPreview" | "archiveComplete" | "archiveSource">;
type ProjectionEvidence = ToolStubEvidence & Pick<ToolCallRecord, "archiveOnly" | "metadataUnavailable"> & { argumentPath?: string };

function projectionEvidence(record: ToolCallRecord): ProjectionEvidence {
  const { toolName, archiveOnly, metadataUnavailable, spillPath, spillBytes, archiveComplete, archiveSource } = record;
  const argumentPath = typeof record.args?.path === "string" ? record.args.path : undefined;
  return { toolName, archiveOnly, metadataUnavailable, argumentPath, spillPath, spillBytes, archiveComplete, archiveSource,
    resultPreview: spillPath ? record.resultPreview : undefined };
}

type StoredRecord = DirectoryMetadata & ProjectionEvidence & {
  argsPreview: string;
  entryId: string;
  position: number;
  activated?: boolean;
};
type IndexedRecord = { record: ToolCallRecord } | StoredRecord;
type RecordReader = ExtensionContext["sessionManager"];

export class ToolCallIndexer {
  /** Persisted payloads stay in the session store; only legacy aliases without index entries need full fallback records. */
  private index = new Map<string, IndexedRecord>();
  private sourceReader?: RecordReader;
  /** Only reused bare IDs need a list of occurrence keys. */
  private bareIdToKeys = new Map<string, string | string[]>();
  private aliasToToolCallId = new Map<string, string>();
  private toolCallIdToAlias = new Map<string, string>();
  private nextShortAliasNumber = 1;
  /**
   * hash -> original occurrence key (or legacy bare id). Populated as
   * records enter the indexer (`addBatch`) and on `reconstructFromSession`.
   * Drives the pre-flush dedup pass via `lookupByContent`.
   */
  private contentHashToOriginal = new Map<string, string>();
  /**
   * Per-batch summary bodies for chain-compression summary text lookup.
   * Each entry maps a set of toolCallIds to the summary's markdown body.
   * Populated from CUSTOM_TYPE_SUMMARY entries at rebuild time and via
   * `registerSummaryBody` after a successful flush.
   */
  private summaryBodies: Array<{ toolCallIds: string[]; text: string }> = [];
  private seenSummaryEntries = new Set<string>();
  private summaryCursor?: SessionEntryReference;
  private chainRegistry = new Map<string, ChainCompressionEntry>();

  /** Rebuild a directory, never retain all historical args/results in the extension. */
  reconstructFromSession(ctx: ExtensionContext): void {
    const next = new ToolCallIndexer();
    for (const _ of next.reconstruction(ctx)) { /* Drain the same replay without UI scheduling. */ }
    this.adopt(next);
  }

  async reconstructFromSessionAsync(ctx: ExtensionContext, assertValid: () => void): Promise<void> {
    const next = new ToolCallIndexer();
    let slice = performance.now();
    await setImmediate();
    assertValid();
    for (const _ of next.reconstruction(ctx)) {
      if (performance.now() - slice < 8) continue;
      await setImmediate();
      assertValid();
      slice = performance.now();
    }
    assertValid();
    this.adopt(next); // No half-restored state can escape an aborted or superseded replay.
  }

  private adopt(next: ToolCallIndexer): void {
    this.index = next.index;
    this.sourceReader = next.sourceReader;
    this.bareIdToKeys = next.bareIdToKeys;
    this.aliasToToolCallId = next.aliasToToolCallId;
    this.toolCallIdToAlias = next.toolCallIdToAlias;
    this.contentHashToOriginal = next.contentHashToOriginal;
    this.nextShortAliasNumber = next.nextShortAliasNumber;
    this.summaryBodies = next.summaryBodies;
    this.seenSummaryEntries = next.seenSummaryEntries;
    this.summaryCursor = next.summaryCursor;
    this.chainRegistry = next.chainRegistry;
  }

  private *reconstruction(ctx: ExtensionContext): Generator<void> {
    this.sourceReader = ctx.sessionManager;
    const aliases: DedupAliasEntryData[] = [];
    const entries = readHistoryEntries(ctx.sessionManager, "branch", entry => entry.type === "custom"
      && [CUSTOM_TYPE_INDEX, CUSTOM_TYPE_CHAIN, CUSTOM_TYPE_DEDUP_ALIAS].includes(entry.customType), { cacheAdmission: "bypass" });
    for (const entry of customEntries(entries)) {
      if (entry.customType === CUSTOM_TYPE_INDEX) {
        const data = entry.data as IndexEntryData;
        if (Array.isArray(data?.toolCalls)) for (const [position, record] of data.toolCalls.entries()) {
          this.indexRecord(record, { entryId: entry.id, position, dedupSource: !data.backfilled });
        }
        if (data?.backfilled && Array.isArray(data.refs)) this.registerSummaryRefs(data.refs);
      } else if (entry.customType === CUSTOM_TYPE_CHAIN) {
        const data = entry.data as ChainCompressionEntry;
        if (data?.blockId && (isSharedChain(data) ? Array.isArray(data.members) : typeof data.startUserTimestamp === "number")) {
          this.registerChain(data);
        }
      } else {
        const data = entry.data as DedupAliasEntryData;
        if (data?.newToolCallId && data?.originalToolCallId) aliases.push(data);
      }
      yield;
    }

    // Legacy aliases need their own execution metadata, not a copy of the original's args.
    const sources = new Map<string, ToolCallRecord>();
    if (aliases.some(data => !this.index.has(occKey(data.newToolCallId, data.newResultTimestamp)))) {
      const branch: SessionEntry[] = [];
      for (const entry of readHistoryEntries(ctx.sessionManager, "branch",
        entry => entry.type === "message" || entry.type === "custom_message", { cacheAdmission: "bypass" })) {
        branch.push(entry); yield;
      }
      for (const batch of captureUnindexedBatchesFromSession(branch, { isSummarized: () => false })) {
        for (const call of batch.toolCalls) sources.set(occKey(call.toolCallId, call.resultTimestamp), {
          ...call, turnIndex: batch.turnIndex, timestamp: batch.timestamp,
        });
        yield;
      }
    }
    for (const data of aliases) {
      const key = occKey(data.newToolCallId, data.newResultTimestamp);
      if (this.index.has(key)) continue;
      const original = this.getRecord(occKey(data.originalToolCallId, data.originalResultTimestamp));
      const own = sources.get(key) ?? (original && this.unknownLegacyOccurrence(key, original));
      if (own) this.indexRecord(own);
    }
    for (const entry of readHistoryEntries(ctx.sessionManager, "branch", entry => entry.type === "custom_message"
      && entry.customType === CUSTOM_TYPE_SUMMARY, { cacheAdmission: "bypass" })) {
      this.syncSummaryBranch([entry]); yield;
    }
    this.summaryCursor = ctx.sessionManager.getEntryMetadata?.(ctx.sessionManager.getLeafId() ?? "");
  }

  /**
   * Indexes a single record under its occurrence key and updates the
   * bare-id reverse index + legacy-shape tracking. Shared by `addBatch` and
   * `reconstructFromSession` so both paths key identically.
   */
  private indexRecord(record: ToolCallRecord, source?: Pick<StoredRecord, "entryId" | "position"> & { dedupSource?: boolean }): void {
    const key = occKey(record.toolCallId, record.resultTimestamp);
    if (source) {
      const { entryId, position, dedupSource } = source;
      const hash = record.contentHash
        ?? (!record.spillPath || dedupSource ? hashToolResult(record.toolName, record.resultText) : undefined);
      this.index.set(key, {
        ...directoryMetadata(record), ...projectionEvidence(record), entryId, position,
        argsPreview: argumentPreview(record.args),
        contentHash: record.spillPath ? record.contentHash : hash,
      });
      if (dedupSource && hash !== undefined && !this.contentHashToOriginal.has(hash)) this.contentHashToOriginal.set(hash, key);
    } else this.index.set(key, { record });

    const known = this.bareIdToKeys.get(record.toolCallId);
    if (known === undefined) this.bareIdToKeys.set(record.toolCallId, key);
    else if (typeof known === "string") {
      if (known !== key) this.bareIdToKeys.set(record.toolCallId, [known, key]);
    } else if (!known.includes(key)) known.push(key);
  }

  /** Writers append one index entry synchronously to the bound session; retain its identity, never its payload. */
  private appendIndex(data: IndexEntryData, appendEntry: (customType: string, data?: unknown) => void): string {
    const reader = this.sourceReader;
    if (!reader) throw new Error("Execution archive reader is not ready");
    const previous = reader.getLeafId();
    appendEntry(CUSTOM_TYPE_INDEX, data);
    const entry = reverseBranchEntryReferences(reader).next().value;
    if (!entry || entry.id === previous || entry.type !== "custom" || entry.customType !== CUSTOM_TYPE_INDEX)
      throw new Error("Execution archive was not persisted on the bound session");
    return entry.id;
  }

  /**
   * True when the addressed occurrence owns an index record with pruning active.
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
   * ToolResultMessage, including duplicates with their own index records.
   */
  isSummarized(occurrenceKey: string): boolean {
    const item = this.index.get(occurrenceKey);
    return !!item && !("record" in item ? item.record : item).archiveOnly;
  }

  hasRecord(key: string): boolean { return this.index.has(key); }

  /** Stub and protection facts for an exact occurrence, with no archive body read. */
  getProjectionEvidence(key: string): ProjectionEvidence | undefined {
    const item = this.index.get(key);
    return item && ("record" in item ? projectionEvidence(item.record) : item);
  }

  /** Directory/parent selection must not load archived argument or result bodies. */
  *directory(): Generator<DirectoryMetadata & { occurrence: string; ref: string; argsPreview: string }> {
    for (const [key, item] of this.index) {
      const record = "record" in item ? item.record : item;
      yield { ...directoryMetadata(record), occurrence: key, ref: this.getShortRefForToolCallId(key) ?? key,
        argsPreview: "record" in item ? argumentPreview(item.record.args) : item.argsPreview };
    }
  }

  /**
   * Register short aliases for a summary message so future recovery queries can
   * resolve the short ids back to the persisted toolCallIds.
   */
  registerSummaryRefs(refs: SummaryToolCallRef[]): void {
    for (const ref of refs) {
      if (!ref.shortId || !ref.toolCallId) continue;
      const key = occKey(ref.toolCallId, ref.resultTimestamp);
      if (ref.shortId !== key) {
        this.aliasToToolCallId.set(ref.shortId, key);
        this.toolCallIdToAlias.set(key, ref.shortId);
      }
      const match = /^t(\d+)$/.exec(ref.shortId);
      if (match) {
        this.nextShortAliasNumber = Math.max(this.nextShortAliasNumber, Number(match[1]) + 1);
      }
    }
  }

  /**
   * Resolve a short ref, full occurrence key, or unique legacy bare ID
   * to the addressed occurrence's own key.
   *
   * Order:
   *   1. Direct hit in `this.index` (canonical occurrence key).
   *   2. Short-ref (`t3`) → underlying occurrence key.
   *   3. Bare id with exactly ONE occurrence → that occurrence's key.
   *
   * A bare id with several occurrences resolves to undefined here — that
   * ambiguity is fail-closed by design; callers that must handle collisions
   * use `getRecordsForId`.
   *
   * Used by `getRecord`/`lookupToolCalls` so `context_tree_query` returns
   * the addressed own record for both short refs and occurrence IDs.
   */
  resolveToolCallId(input: string): string | undefined {
    if (this.index.has(input)) return input;
    const aliased = this.aliasToToolCallId.get(input);
    if (aliased) return aliased;
    const keys = this.bareIdToKeys.get(input);
    return typeof keys === "string" ? keys : undefined;
  }

  /**
   * Returns the short alias (e.g. "t1") registered for the given occurrence
   * key (or legacy bare id), or undefined if none was registered. Legacy
   * summaries written before short-refs were introduced map shortId === key
   * and intentionally return undefined here so callers (e.g. the pruner
   * stub) can fall back to the key itself.
   */
  getShortRefForToolCallId(occurrenceKey: string): string | undefined {
    return this.toolCallIdToAlias.get(occurrenceKey);
  }

  /**
   * Look up a single record by occurrence key, short alias, or (unambiguous)
   * bare id (used by query tool).
   */
  getRecord(toolCallIdOrAlias: string): ToolCallRecord | undefined {
    const resolved = this.resolveToolCallId(toolCallIdOrAlias);
    if (!resolved) return undefined;
    const item = this.index.get(resolved);
    if (!item) return undefined;
    if ("record" in item) return item.record;
    const entry = this.sourceReader?.getEntryForScan(item.entryId);
    const record = entry?.type === "custom" && entry.customType === CUSTOM_TYPE_INDEX
      ? (entry.data as IndexEntryData)?.toolCalls?.[item.position] : undefined;
    if (!record || occKey(record.toolCallId, record.resultTimestamp) !== resolved) {
      throw new Error(`Execution archive record unavailable: ${resolved}`);
    }
    return item.activated ? { ...record, archiveOnly: false } : record;
  }

  lookupToolCalls(toolCallIds: string[]): ToolCallRecord[] {
    const results: ToolCallRecord[] = [];
    for (const id of toolCallIds) {
      const record = this.getRecord(id);
      if (record !== undefined) {
        results.push(record);
      }
    }
    return results;
  }

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
  getRecordsForId(input: string): ToolCallRecord[] {
    const block = this.chainRegistry.get(input);
    if (block) return this.lookupToolCalls(chainMembers(block).flatMap(member => member.droppedOccurrenceKeys ?? member.droppedToolCallIds));
    const keys = this.bareIdToKeys.get(input);
    const records = (typeof keys === "string" ? [keys] : keys ?? [])
      .map((k) => this.getRecord(k))
      .filter((r): r is ToolCallRecord => r !== undefined);

    if (records.length > 0) {
      return records.sort((a, b) => (a.resultTimestamp ?? a.timestamp) - (b.resultTimestamp ?? b.timestamp));
    }
    const record = this.getRecord(input);
    return record ? [record] : [];
  }

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
  hasLegacyBareRecord(toolCallId: string): boolean {
    const item = this.index.get(toolCallId);
    if (!item || ("record" in item ? item.record : item).archiveOnly) return false;
    return typeof this.bareIdToKeys.get(toolCallId) === "string";
  }

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
  lookupByContent(toolName: string, resultText: string): string | undefined {
    const hash = hashToolResult(toolName, resultText);
    return this.contentHashToOriginal.get(hash);
  }

  /** Duplicate bodies still have independent execution identity and recall refs. */
  registerDuplicate(
    newKey: string,
    originalKey: string,
    appendEntry: (customType: string, data?: unknown) => void,
    occurrence?: ToolCallRecord,
  ): void {
    if (newKey === originalKey) return;
    const original = this.getRecord(originalKey);
    const own = occurrence ?? (original && this.unknownLegacyOccurrence(newKey, original));
    if (!own) return;
    const existingRef = this.getShortRefForToolCallId(newKey);
    const { refs, nextIndex } = existingRef
      ? { refs: [{ shortId: existingRef, toolCallId: own.toolCallId, resultTimestamp: own.resultTimestamp }], nextIndex: this.nextShortAliasNumber }
      : buildShortToolCallRefs([own], this.nextShortAliasNumber);
    const entryId = this.appendIndex({ toolCalls: [own], backfilled: true, refs }, appendEntry);
    this.nextShortAliasNumber = nextIndex;
    this.indexRecord(own, { entryId, position: 0 });
    this.registerSummaryRefs(refs);
  }

  private unknownLegacyOccurrence(key: string, original: ToolCallRecord): ToolCallRecord {
    const { toolCallId, resultTimestamp } = parseOccKey(key);
    return {
      ...original, toolCallId, resultTimestamp, args: {}, turnIndex: -1,
      timestamp: resultTimestamp ?? 0, metadataUnavailable: true, archiveComplete: false,
    };
  }

  /**
   * Stores summary body text keyed by the toolCallIds it covers.
   * Called after a successful flush so `getPerBatchSummaryTextForToolCallIds`
   * can serve chain summaries without re-scanning session entries.
   */
  syncSummaryEntries(ctx: ExtensionContext): void {
    const manager = ctx.sessionManager;
    const select = (entry: SessionEntryReference) => entry.type === "custom_message"
      && entry.customType === CUSTOM_TYPE_SUMMARY && !this.seenSummaryEntries.has(entry.id);
    if (manager !== this.sourceReader || !manager.getEntryMetadata) {
      this.syncSummaryBranch(readHistoryEntries(manager, "branch", select));
      return;
    }
    // Only immutable metadata identities prove an already-scanned prefix. A
    // different branch or a rebuilt prefix falls back to scanning that path.
    const tail: SessionEntry[] = [];
    let head: SessionEntryReference | undefined;
    for (const entry of reverseBranchEntryReferences(manager)) {
      head ??= entry;
      if (entry === this.summaryCursor) break;
      if (!select(entry)) continue;
      const body = manager.getEntry(entry.id);
      if (!body) throw new Error(`Session entry not found: ${entry.id}`);
      tail.push(body);
    }
    this.syncSummaryBranch(tail.reverse());
    this.summaryCursor = head;
  }

  private syncSummaryBranch(branch: Iterable<SessionEntry>): void {
    for (const entry of branch) {
      if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE_SUMMARY || this.seenSummaryEntries.has(entry.id)) continue;
      const refs = normalizeSummaryToolCallRefs(entry.details);
      this.registerSummaryRefs(refs);
      const text = typeof entry.content === "string" ? entry.content
        : entry.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      const members = summaryGroupMembers(entry);
      if (members) {
        for (const member of members) this.registerSummaryBody(
          member.toolCallRefs.map(ref => occKey(ref.toolCallId, ref.resultTimestamp)), text.slice(member.bodyStart, member.bodyEnd));
      } else this.registerSummaryBody(refs.map(ref => occKey(ref.toolCallId, ref.resultTimestamp)), text);
      this.seenSummaryEntries.add(entry.id);
    }
  }

  private registerSummaryBody(toolCallIds: string[], text: string): void {
    if (!text || toolCallIds.length === 0) return;
    this.summaryBodies.push({ toolCallIds, text });
    for (const key of toolCallIds) {
      const item = this.index.get(key);
      if (!item) continue;
      const record = "record" in item ? item.record : item;
      if (!record.archiveOnly) continue;
      this.index.set(key, "record" in item ? { record: { ...item.record, archiveOnly: false } }
        : { ...item, archiveOnly: false, activated: true });
      const hash = "record" in item
        ? item.record.contentHash ?? (!item.record.spillPath ? hashToolResult(item.record.toolName, item.record.resultText) : undefined)
        : item.contentHash;
      if (hash && !this.contentHashToOriginal.has(hash)) this.contentHashToOriginal.set(hash, key);
    }
  }

  hasPerBatchSummaryCoveringAny(toolCallIds: string[]): boolean {
    if (toolCallIds.length === 0) return false;
    const idSet = new Set(toolCallIds);
    return this.summaryBodies.some((s) => s.toolCallIds.some((id) => idSet.has(id)));
  }

  /**
   * Returns the distinct per-batch summary texts whose toolCallIds overlap the
   * given set (dedup'd by text). Used to build the synthetic chain body and as
   * the fusion input for the range summarizer; the >= 2 count gates fusion.
   */
  getPerBatchSummariesForToolCallIds(toolCallIds: string[]): string[] {
    if (toolCallIds.length === 0) return [];
    const idSet = new Set(toolCallIds);
    const texts = new Set<string>();
    for (const summary of this.summaryBodies) {
      if (summary.toolCallIds.some(id => idSet.has(id))) texts.add(summary.text);
    }
    return [...texts];
  }

  getPerBatchSummaryTextForToolCallIds(toolCallIds: string[]): string {
    return this.getPerBatchSummariesForToolCallIds(toolCallIds).join("\n\n");
  }

  /** A mixed semantic summary cannot be split by guessing from its refs. */
  getOwnedSummaryText(toolCallIds: string[]): string | null {
    const own = new Set(toolCallIds);
    const summaries = this.summaryBodies.filter(s => s.toolCallIds.some(id => own.has(id)));
    if (summaries.some(s => s.toolCallIds.some(id => !own.has(id)))) return null;
    return [...new Set(summaries.map(s => s.text))].join("\n\n");
  }

  getToolRefsForToolCallIds(toolCallIds: string[]): string[] {
    const refs: string[] = [];
    for (const id of toolCallIds) {
      const ref = this.toolCallIdToAlias.get(id);
      if (ref) refs.push(ref);
    }
    return refs;
  }

  /** Registers a chain entry in the in-memory registry. Called by chain-compressor after persisting. */
  registerChain(entry: ChainCompressionEntry): void {
    this.chainRegistry.set(entry.blockId, entry);
  }

  getChainEntries(): ChainCompressionEntry[] {
    return [...this.chainRegistry.values()].sort((a, b) => chainMembers(a)[0].startUserTimestamp - chainMembers(b)[0].startUserTimestamp);
  }

  findChainEntryByBlockId(blockId: string): ChainCompressionEntry | undefined {
    return this.chainRegistry.get(blockId);
  }

  /**
   * Adds all tool calls from a captured batch to the runtime index and
   * persists an IndexEntryData entry to the session via the supplied
   * appendEntry callback. The callback exists so callers can route the
   * append through either `pi.appendEntry` (runtime delivery) or
   * `ctx.sessionManager.appendCustomEntry` (session delivery), without the
   * indexer needing to know which one is active.
   */
  addBatch(
    batch: CapturedBatch,
    appendEntry: (customType: string, data?: unknown) => void,
    archiveOnly = false,
  ): void {
    const records: ToolCallRecord[] = [];

    for (const tc of batch.toolCalls) {
      const record: ToolCallRecord = {
        ...(archiveOnly ? { archiveOnly: true } : {}),
        ...(tc.parentToolCallId ? { parentToolCallId: tc.parentToolCallId } : {}),
        ...(tc.nestedProtected ? { nestedProtected: true } : {}),
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        resultText: tc.resultText,
        isError: tc.isError,
        turnIndex: batch.turnIndex,
        timestamp: batch.timestamp,
        ...(tc.resultTimestamp !== undefined ? { resultTimestamp: tc.resultTimestamp } : {}),
        ...(tc.resultPrefix !== undefined ? { resultPrefix: tc.resultPrefix } : {}),
        ...(tc.archiveSource
          ? {
              archiveSource: tc.archiveSource,
              archiveComplete: tc.archiveComplete,
              archiveAppendOnly: tc.archiveAppendOnly,
            }
          : {}),
        ...(tc.spillPath !== undefined ? { spillPath: tc.spillPath } : {}),
        ...(tc.spillBytes !== undefined ? { spillBytes: tc.spillBytes } : {}),
        ...(tc.resultPreview !== undefined ? { resultPreview: tc.resultPreview } : {}),
        ...(tc.contentHash !== undefined ? { contentHash: tc.contentHash } : {}),
      };
      records.push(record);
    }

    const entryId = this.appendIndex({ toolCalls: records, ...(archiveOnly ? { backfilled: true } : {}) }, appendEntry);
    for (const [position, record] of records.entries()) {
      this.indexRecord(record, { entryId, position, dedupSource: !archiveOnly });
    }
  }

  private sameArchive(existing: ToolCallRecord, incoming: ToolCallRecord): boolean {
    return !existing.metadataUnavailable && !incoming.metadataUnavailable
      && existing.archiveComplete !== false && incoming.archiveComplete !== false
      && (["toolName", "isError", "parentToolCallId", "nestedProtected",
        "resultPrefix", "archiveSource", "archiveAppendOnly"] as const)
        .every(field => existing[field] === incoming[field])
      && JSON.stringify(existing.args) === JSON.stringify(incoming.args)
      && (existing.spillPath
        ? (existing.contentHash ?? hashToolResult(existing.toolName, existing.resultText)) === incoming.contentHash
        : existing.resultText === incoming.resultText);
  }

  private async archiveExists(record: ToolCallRecord, incoming: ToolCallRecord): Promise<boolean> {
    if (!record.spillPath) return true;
    try {
      const info = await stat(record.spillPath);
      const bytes = record.spillBytes ?? incoming.spillBytes ?? Buffer.byteLength(incoming.resultText, "utf8");
      return info.isFile() && (record.archiveAppendOnly ? info.size >= bytes : info.size === bytes);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  }

  /**
   * Atomic recoverability backfill for an uncovered chain (spec
   * 2026-08-14-uncovered-chain-deterministic-backfill). Append-before-commit:
   * in-memory maps are touched only after the index entry persisted. Records
   * never seed contentHashToOriginal (dedup poison guard). Refs ride the
   * entry so they survive session restart without a summary message.
   */
  async backfillChainRecords(
    records: ToolCallRecord[],
    opts: {
      spillThreshold: number;
      spillPreviewBytes: number;
      sessionDir: string;
      sessionId: string;
      appendEntry: (customType: string, data?: unknown) => void;
      assertValid?: () => void;
    },
  ): Promise<SummaryToolCallRef[]> {
    const refs: SummaryToolCallRef[] = [], changed: ToolCallRecord[] = [], changedRefs: SummaryToolCallRef[] = [];
    for (const r of records) {
      opts.assertValid?.();
      const key = occKey(r.toolCallId, r.resultTimestamp), existing = this.getRecord(key);
      const shortId = this.toolCallIdToAlias.get(key);
      const matches = existing !== undefined && this.sameArchive(existing, r);
      if (matches && shortId && await this.archiveExists(existing, r)) {
        refs.push({ shortId, toolCallId: r.toolCallId, resultTimestamp: r.resultTimestamp });
        continue;
      }
      if (r.resultText.length >= opts.spillThreshold) {
        const path = blobPathFor(opts.sessionDir, opts.sessionId, key);
        await mkdir(blobDirFor(opts.sessionDir, opts.sessionId), { recursive: true });
        opts.assertValid?.();
        await writeFile(path, r.resultText, "utf-8"); // throw = abort backfill (fail-closed)
        opts.assertValid?.();
        applySpill(r, path, opts.spillPreviewBytes);
      }
      if (!await this.archiveExists(r, r)) throw new Error("Execution archive unavailable");
      if (matches && !existing.archiveOnly) r.archiveOnly = false;
      const allocation = shortId ? undefined : buildShortToolCallRefs([r], this.nextShortAliasNumber);
      if (allocation) this.nextShortAliasNumber = allocation.nextIndex; // failures may burn numbers, never reuse them
      const ref = shortId ? { shortId, toolCallId: r.toolCallId, resultTimestamp: r.resultTimestamp } : allocation!.refs[0]!;
      refs.push(ref); changedRefs.push(ref); changed.push(r);
    }
    opts.assertValid?.();
    if (changed.length) {
      const entryId = this.appendIndex({ toolCalls: changed, backfilled: true, refs: changedRefs }, opts.appendEntry);
      for (const [position, record] of changed.entries()) this.indexRecord(record, { entryId, position });
      this.registerSummaryRefs(changedRefs);
    }
    return refs;
  }
}
