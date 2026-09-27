import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import { QUERY_TOOL_NAME, type ToolCallRecord } from "./types.js";

const MAX_BYTES = 32768;
interface Cursor { selection: string; index: number; offset: number; version?: string }
interface Selection { ref: string; record?: ToolCallRecord }
interface Page {
  ref: string;
  occurrence?: string;
  legacy?: boolean;
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
    const bytes = Buffer.alloc(Math.min(budget + 4, Math.max(0, stat.size - offset)));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
    return { bytes: bytes.subarray(0, bytesRead), total: stat.size, version: `${stat.size}:${stat.mtimeMs}:${stat.ino}` };
  } finally { await file.close(); }
}

export function registerQueryTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void {
  pi.registerTool({
    name: QUERY_TOOL_NAME,
    label: "Query Original Tool History",
    description: "Recover archived tool outputs by short refs (t12) or raw tool call IDs. Returns JSON pages with exact text, byte offsets, completeness, and nextCursor. Repeat the same toolCallIds with nextCursor until eof. Reused IDs return every indexed occurrence. These are historical captured tool outputs, not current file contents or necessarily unfiltered process logs. Missing archives are explicit errors.",
    promptSnippet: "Retrieve archived tool outputs by ref, following nextCursor for subsequent pages",
    promptGuidelines: ["Use context_tree_query to recover evidence omitted from pruner summaries. Follow nextCursor until the needed range or eof; incomplete pages and archive errors are not complete original outputs."],
    parameters: Type.Object({
      toolCallIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 64 }),
      cursor: Type.Optional(Type.String({ maxLength: 2048, description: "The previous response's nextCursor; keep toolCallIds unchanged." })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 2048, maximum: MAX_BYTES, description: "Total JSON text budget, including metadata and the continuation cursor. Default 32768." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const budget = params.maxBytes ?? MAX_BYTES;
      if (!Number.isSafeInteger(budget) || budget < 2048 || budget > MAX_BYTES) throw new Error("maxBytes must be between 2048 and 32768.");
      const selected: Selection[] = params.toolCallIds.flatMap((ref) => {
        const records = indexer.getRecordsForId(ref);
        return records.length ? records.map((record) => ({ ref, record })) : [{ ref }];
      });
      // Stable across reloads and normal conversation growth; branch changes
      // invalidate the cursor if they change the selected occurrences.
      const selection = digest(JSON.stringify([ctx.sessionManager.getSessionId(), selected.map(({ ref, record: r }) => [
        ref, r?.toolCallId, r?.resultTimestamp, r?.timestamp, r?.contentHash ?? (r && digest(r.resultText)), r?.spillPath,
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
            tool: record.toolName, status: record.isError ? "ERROR" : "OK",
            argsPreview: args.slice(0, 256), argsTruncated: args.length > 256,
          };
          let source;
          try { source = await readPage(record, current.offset, budget); }
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
