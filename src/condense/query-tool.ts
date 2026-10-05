import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.ts";
import { QUERY_TOOL_NAME, type ToolCallRecord } from "./types.ts";

const MAX_BYTES = 32768;
interface Cursor { selection: string; index: number; offset: number; version?: string }
interface Selection { ref: string; record?: ToolCallRecord }
interface Page {
  ref: string;
  occurrence?: string;
  legacy?: boolean;
  source?: string;
  archiveComplete?: boolean;
  component?: string;
  turnIndex?: number;
  tool?: string;
  status?: string;
  argsPreview?: string;
  argsTruncated?: boolean;
  offsetBytes?: number;
  totalBytes?: number;
  text?: string;
  complete: boolean;
  error?: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decode(value: string): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof cursor.selection !== "string" || !Number.isSafeInteger(cursor.index) || cursor.index < 0
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
      || (cursor.version !== undefined && typeof cursor.version !== "string")) throw new Error();
    return cursor;
  } catch { throw new Error("Invalid recall cursor. Start a new query with toolCallIds."); }
}

/** Never split a UTF-8 code point, including at the disk-read boundary. */
function prefix(bytes: Buffer, length: number): string {
  let end = Math.min(length, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
}

async function readPage(record: ToolCallRecord, offset: number, budget: number) {
  if (!record.spillPath) {
    const bytes = Buffer.from(record.resultText, "utf8");
    return { bytes: bytes.subarray(offset, offset + budget + 4), total: bytes.length, version: digest(record.resultText) };
  }
  const file = await open(record.spillPath, "r");
  try {
    const stat = await file.stat();
    const bodyBytes = record.archiveAppendOnly ? record.spillBytes! : stat.size;
    if (stat.size < bodyBytes) throw new Error("Archived snapshot is incomplete");
    const prefix = Buffer.from(record.resultPrefix && (record.archiveSource === "fused-command-output" || record.archiveSource === "fusion-journal") ? `${record.resultPrefix}\n` : "", "utf8");
    const total = prefix.length + bodyBytes;
    const bytes = Buffer.alloc(Math.min(budget + 4, Math.max(0, total - offset)));
    const prefixBytes = offset < prefix.length ? prefix.copy(bytes, 0, offset, Math.min(prefix.length, offset + bytes.length)) : 0;
    const { bytesRead } = await file.read(bytes, prefixBytes, bytes.length - prefixBytes, Math.max(0, offset - prefix.length));
    return { bytes: bytes.subarray(0, prefixBytes + bytesRead), total, version: record.archiveAppendOnly ? `${total}:${stat.ino}` : `${stat.size}:${stat.mtimeMs}:${stat.ino}` };
  } finally { await file.close(); }
}

export function registerQueryTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void {
  pi.registerTool({
    name: QUERY_TOOL_NAME,
    label: "Query Original Tool History",
    description: "Omit toolCallIds to list the evidence directory, then recover archived tool outputs by short refs (t12) or raw tool call IDs. Set component=arguments to recover full original parameters, or sourceEntryIds to recover historical message/compaction/summary entries from this branch. Returns JSON pages with exact text, byte offsets, completeness, and nextCursor. Repeat the same toolCallIds with nextCursor until eof. Reused IDs return every indexed occurrence. These are historical captured tool outputs, not current file contents or necessarily unfiltered process logs. Missing archives are explicit errors.",
    promptSnippet: "Retrieve archived tool outputs by tool ref or chain block ID (b1), following nextCursor for subsequent pages",
    promptGuidelines: ["Use context_tree_query to recover evidence omitted from pruner summaries. Follow nextCursor until the needed range or eof; incomplete pages and archive errors are not complete original outputs."],
    parameters: Type.Object({
      toolCallIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 64 })),
      parentToolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Recover the nested calls of this parent, including calls omitted from Pi's bounded nestedCalls." })),
      component: Type.Optional(Type.Union([Type.Literal("output"), Type.Literal("arguments")])),
      sourceEntryIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 64 })),
      cursor: Type.Optional(Type.String({ maxLength: 2048, description: "The previous response's nextCursor; keep toolCallIds unchanged." })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 2048, maximum: MAX_BYTES, description: "Total JSON text budget, including metadata and the continuation cursor. Default 32768." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const budget = params.maxBytes ?? MAX_BYTES;
      if (!Number.isSafeInteger(budget) || budget < 2048 || budget > MAX_BYTES) throw new Error("maxBytes must be between 2048 and 32768.");
      const component = params.component ?? "output";
      if ([params.sourceEntryIds, params.toolCallIds, params.parentToolCallId].filter(Boolean).length > 1) throw new Error("Choose sourceEntryIds, toolCallIds, or parentToolCallId, not multiple selectors.");
      if (params.sourceEntryIds && component !== "output") throw new Error("Arguments requires toolCallIds or parentToolCallId.");
      if (component === "arguments" && !params.toolCallIds && !params.parentToolCallId) throw new Error("Arguments requires toolCallIds or parentToolCallId.");
      const selected: Selection[] = params.sourceEntryIds ? params.sourceEntryIds.map(ref => {
        const entry = ctx.sessionManager.getBranch().find(entry => entry.id === ref);
        const allowed = entry && (entry.type === "message" || entry.type === "compaction"
          || (entry.type === "custom_message" && entry.customType === "context-prune-summary"));
        return { ref, record: allowed ? {
          toolCallId: ref, toolName: "historical-source", args: {}, isError: false, turnIndex: -1, timestamp: 0,
          resultText: JSON.stringify(entry),
        } : undefined };
      }) : params.parentToolCallId ? (() => {
        const records = [...indexer.getIndex()].filter(([, r]) => r.parentToolCallId === params.parentToolCallId);
        return records.length ? records.map(([ref, record]) => ({ ref, record })) : [{ ref: params.parentToolCallId }];
      })() : params.toolCallIds ? params.toolCallIds.flatMap((ref) => {
        const records = indexer.getRecordsForId(ref);
        return records.length ? records.map((record) => ({ ref, record })) : [{ ref }];
      }) : [{ ref: "directory", record: {
        toolCallId: "directory", toolName: "evidence-directory", args: {}, isError: false, turnIndex: -1, timestamp: 0,
        resultText: [...indexer.getIndex()].map(([key, r]) => JSON.stringify({
          ref: indexer.getShortRefForToolCallId(key) ?? key, occurrence: key, tool: r.toolName,
          parentToolCallId: r.parentToolCallId,
          status: r.metadataUnavailable ? "UNKNOWN" : r.isError ? "ERROR" : "OK",
          argsPreview: JSON.stringify(r.args).slice(0, 256), archive: r.spillPath,
          archiveComplete: r.archiveComplete, source: r.archiveSource ?? "tool-result",
        })).join("\n"),
      } }];
      // Stable across reloads and normal conversation growth; branch changes
      // invalidate the cursor if they change the selected occurrences.
      const selection = digest(JSON.stringify([ctx.sessionManager.getSessionId(), component, !!params.sourceEntryIds, selected.map(({ ref, record: r }) => [
        ref, r?.toolCallId, r?.resultTimestamp, r?.timestamp, component === "arguments" && r ? digest(JSON.stringify(r.args)) : r?.contentHash ?? (r && digest(r.resultText)), r?.spillPath,
      ])]));
      let current: Cursor = params.cursor ? decode(params.cursor) : { selection, index: 0, offset: 0 };
      if (current.selection !== selection || current.index >= selected.length) throw new Error("Recall cursor no longer matches this session, branch or selection. Start a new query.");
      const results: Page[] = [];
      const render = (pages: Page[], next: Cursor) => JSON.stringify({
        results: pages, nextCursor: next.index < selected.length ? encode(next) : null, eof: next.index >= selected.length,
      });
      while (current.index < selected.length) {
        signal?.throwIfAborted();
        const { ref, record } = selected[current.index]!;
        const nextRecord: Cursor = { selection, index: current.index + 1, offset: 0 };
        let page: Page = { ref, complete: false };
        let next = nextRecord;
        if (!record) {
          page.error = "Not found in this branch's archive index.";
        } else {
          const args = JSON.stringify(record.args);
          page = {
            ...page, occurrence: record.resultTimestamp === undefined ? record.toolCallId : `${record.toolCallId}@${record.resultTimestamp}`,
            legacy: record.resultTimestamp === undefined, turnIndex: record.turnIndex,
            component: params.sourceEntryIds ? "historical-source" : component,
            source: params.sourceEntryIds ? "historical-source" : component === "arguments" ? "tool-arguments" : record.archiveSource ?? "tool-result",
            archiveComplete: component === "arguments" ? !record.metadataUnavailable : record.archiveComplete,
            tool: record.toolName, status: record.metadataUnavailable ? "UNKNOWN" : record.isError ? "ERROR" : "OK",
            argsPreview: args.slice(0, 256), argsTruncated: args.length > 256,
          };
          if (component === "output" && record.archiveComplete === false) page.error = "Execution archive is incomplete; only the captured prefix is available.";
          if (record.metadataUnavailable) page.error = "Legacy dedup source metadata is unavailable; this is the shared historical body, not verified output of this occurrence.";
          let source;
          try { source = await readPage(component === "arguments"
            ? { ...record, spillPath: undefined, resultText: args } : record, current.offset, budget); }
          catch (error) {
            page.error = `Archive unavailable (${(error as NodeJS.ErrnoException).code ?? "read failed"}); preview is not the original output.`;
          }
          signal?.throwIfAborted();
          if (source) {
            if (current.offset > source.total || (current.version && current.version !== source.version)) {
              throw new Error("Archived output changed or cursor offset is invalid. Start a new query.");
            }
            const { bytes, total, version } = source;
            page.offsetBytes = current.offset;
            page.totalBytes = total;
            // JSON escaping and metadata count toward the same response budget.
            // Binary-search bytes, then retreat to a whole UTF-8 code point.
            const candidate = (length: number) => {
              const text = prefix(bytes, length);
              const offset = current.offset + Buffer.byteLength(text);
              const complete = offset === total;
              return {
                page: { ...page, text, complete },
                next: complete ? nextRecord : { selection, index: current.index, offset, version },
              };
            };
            let low = 0, high = Math.min(bytes.length, budget);
            while (low < high) {
              const middle = Math.ceil((low + high) / 2);
              const c = candidate(middle);
              if (Buffer.byteLength(render([...results, c.page], c.next)) <= budget) low = middle;
              else high = middle - 1;
            }
            const chosen = candidate(low);
            if (!chosen.page.complete && !chosen.page.text) {
              if (results.length) break;
              throw new Error("Recall metadata exceeds the output budget; query a short ref with a larger maxBytes.");
            }
            page = chosen.page;
            next = chosen.next;
          }
        }
        if (Buffer.byteLength(render([...results, page], next)) > budget) {
          if (results.length) break;
          throw new Error("Recall metadata exceeds the output budget; use a short ref.");
        }
        results.push(page);
        current = next;
        if (!page.complete && !page.error) break;
      }
      const text = render(results, current);
      // Do not duplicate the full archive in details: paging must bound both
      // provider-visible output and the newly persisted tool result.
      return { content: [{ type: "text", text }], details: JSON.parse(text), isError: results.some((page) => !!page.error) };
    },
  });
}
