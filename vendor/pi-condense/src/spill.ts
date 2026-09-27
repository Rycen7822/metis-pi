import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { isAbsolute, relative, join } from "node:path";
import type { CapturedBatch, CapturedToolCall } from "./types.js";

import type { ToolCallIndexer } from "./indexer.js";
import { hashToolResult } from "./content-hash.js";
import { occKey } from "./occurrence-key.js";
import { captureFusionResult } from "./fusion.js";
import { packToolResult } from "./packing.js";

/** Import the execution layer's full output, not its truncated display text. */
async function importOutputArchive(call: CapturedToolCall, sessionDir: string, sessionId: string): Promise<boolean> {
  const source = call.outputArchive;
  if (!source || !isAbsolute(source.path)) return false;
  const info = await stat(source.path);
  if (!info.isFile()) return false;
  const bytes = source.bytes ?? info.size;
  const offset = source.offsetBytes ?? 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(offset) || offset < 0 || offset + bytes > info.size) throw new Error("Incomplete output archive snapshot");
  const directory = blobDirFor(sessionDir, sessionId);
  // Owned exec logs are append-only, already durable, and can be shared by
  // successive polls. Each record pins its visible byte length independently.
  const local = relative(directory, source.path);
  const appendOnly = offset === 0 && source.appendOnly === true && /^exec-[a-f0-9-]+\.log$/.test(local);
  const target = appendOnly ? source.path : blobPathFor(sessionDir, sessionId, `output-${call.toolCallId}@${call.resultTimestamp}`);
  if (!appendOnly) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      if (bytes === 0) await writeFile(target, "", { mode: 0o600 });
      else await pipeline(createReadStream(source.path, { start: offset, end: offset + bytes - 1 }), createWriteStream(target, { mode: 0o600 }));
      if ((await stat(target)).size !== bytes) throw new Error("Output archive changed during capture");
    } catch (error) {
      await unlink(target).catch(() => {});
      throw error;
    }
  }
  call.spillPath = target;
  call.spillBytes = bytes;
  call.resultPreview = call.fusionCommand
    ? packToolResult(call) ?? `${call.resultPrefix ?? ""}\n${headPreview(call.fusionCommand.output, 2048)}`
    : headPreview(call.resultText, 2048);
  if (source.source === "fusion-journal") call.resultPrefix = call.resultText;
  call.resultText = "";
  call.archiveSource = source.source ?? "command-output";
  call.archiveComplete = source.complete;
  call.archiveAppendOnly = appendOnly;
  // Do not seed normalized tool-result dedup with a truncated preview/empty body.
  call.contentHash = createHash("sha256").update(`${target}:${bytes}${call.resultPrefix ? `:${call.resultPrefix}` : ""}`).digest("hex");
  return true;
}

/** Index every persisted nested result, including entries evicted from UI traces. */
async function importFusionJournal(call: CapturedToolCall, batch: CapturedBatch, args: {
  indexer: ToolCallIndexer; sessionDir: string; sessionId: string;
  appendEntry: (customType: string, data?: unknown) => void;
}): Promise<void> {
  const source = call.outputArchive;
  if (source?.source !== "fusion-journal" || !isAbsolute(source.path)) return;
  const offset = source.offsetBytes ?? 0, bytes = source.bytes ?? 0;
  const info = await stat(source.path);
  if (!info.isFile() || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(bytes) || bytes < 1 || offset + bytes > info.size) throw new Error("Incomplete fusion journal snapshot");
  const stream = createReadStream(source.path, { start: offset, end: offset + bytes - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.version !== 1 || typeof entry.id !== "string" || typeof entry.toolName !== "string" || !Number.isSafeInteger(entry.timestamp)) throw new Error("Invalid fusion journal record");
      if (args.indexer.getRecordsForId(entry.id).some(record => record.resultTimestamp === entry.timestamp)) continue;
      const fusion = captureFusionResult(entry.result);
      if (!fusion.fusionCommand) throw new Error("Invalid fusion receipt");
      const child: CapturedToolCall = { toolCallId: entry.id, toolName: entry.toolName,
        args: entry.input && typeof entry.input === "object" ? entry.input : { input: entry.input },
        resultText: entry.result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n"),
        resultTimestamp: entry.timestamp, isError: false, ...fusion,
      };
      if (child.outputArchive) await importOutputArchive(child, args.sessionDir, args.sessionId);
      args.indexer.addBatch({ ...batch, toolCalls: [child] }, args.appendEntry);
    }
  } finally { lines.close(); stream.destroy(); }
}

/** Replace anything outside [A-Za-z0-9_-] so the id can't escape the blob dir. */
export function sanitizeId(toolCallId: string): string {
  return toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function blobDirFor(sessionDir: string, sessionId: string): string {
  return join(sessionDir, `${sessionId}-blobs`);
}

export function blobPathFor(sessionDir: string, sessionId: string, toolCallId: string): string {
  const base = sanitizeId(toolCallId);
  // 255-byte basename cap (gh-14). Uncapped budget: 255 - ".txt" = 251.
  // Capped: 234-byte prefix + "." + 16-hex sha1 + ".txt" = 255 exactly.
  // sanitizeId output is ASCII, so slice counts bytes. The "." separator is
  // unreachable by sanitizeId, keeping capped names disjoint from short-key
  // names. The hash covers the UNsanitized key so ids that sanitize
  // identically stay distinct.
  const name =
    Buffer.byteLength(base, "utf8") <= 251
      ? `${base}.txt`
      : `${base.slice(0, 234)}.${createHash("sha1").update(toolCallId).digest("hex").slice(0, 16)}.txt`;
  return join(blobDirFor(sessionDir, sessionId), name);
}

/** Head of `text` capped at `maxBytes` (UTF-8 safe), preferring a line boundary. */
export function headPreview(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  let slice = buf.subarray(0, end).toString("utf8");
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl > 0) slice = slice.slice(0, lastNl);
  return slice;
}


interface SpillConfig {
  spillThreshold: number;
  spillPreviewBytes: number;
  dedupByContentHash: boolean;
}

interface SpillableRecord {
  toolName: string;
  resultText: string;
  spillBytes?: number;
  resultPreview?: string;
  spillPath?: string;
  contentHash?: string;
}

/** Mutates `record` in place: spillBytes/resultPreview/spillPath/contentHash set, resultText emptied. */
export function applySpill(record: SpillableRecord, spillPath: string, previewBytes: number): void {
  record.spillBytes = Buffer.byteLength(record.resultText, "utf8");
  record.resultPreview = headPreview(record.resultText, previewBytes);
  record.spillPath = spillPath;
  record.contentHash = hashToolResult(record.toolName, record.resultText);
  record.resultText = "";
}

export async function spillOversizedBatch(args: {
  batch: CapturedBatch;
  indexer: ToolCallIndexer;
  config: SpillConfig;
  sessionDir: string;
  sessionId: string;
  appendEntry: (customType: string, data?: unknown) => void;
}): Promise<Set<string>> {
  const { batch, indexer, config, sessionDir, sessionId, appendEntry } = args;
  const handled = new Set<string>();
  const toIndex: CapturedToolCall[] = [];

  for (const tc of batch.toolCalls) {
    if (tc.outputArchive) {
      try {
        await importFusionJournal(tc, batch, { indexer, sessionDir, sessionId, appendEntry });
        if (await importOutputArchive(tc, sessionDir, sessionId)) {
          toIndex.push(tc);
          handled.add(tc.toolCallId);
          continue;
        }
      } catch (error) {
        console.error(`pruner: full output archive unavailable for ${tc.toolCallId}:`, error);
        // Keep the visible result intact; never claim the preview is full output.
      }
    }
    if (tc.resultText.length < config.spillThreshold) continue;

    const key = occKey(tc.toolCallId, tc.resultTimestamp);

    if (config.dedupByContentHash) {
      const original = indexer.lookupByContent(tc.toolName, tc.resultText);
      if (original && original !== key) {
        indexer.registerDuplicate(key, original, appendEntry);
        handled.add(tc.toolCallId);
        continue;
      }
    }

    const path = blobPathFor(sessionDir, sessionId, key);
    try {
      await mkdir(blobDirFor(sessionDir, sessionId), { recursive: true });
      await writeFile(path, tc.resultText, "utf-8");
    } catch (err) {
      console.error(`spill: failed to write sidecar for ${tc.toolCallId} at ${path}:`, err);
      continue;
    }

    applySpill(tc, path, config.spillPreviewBytes);
    toIndex.push(tc);
    handled.add(tc.toolCallId);
  }

  if (toIndex.length > 0) {
    indexer.addBatch(
      { turnIndex: batch.turnIndex, timestamp: batch.timestamp, assistantText: "", toolCalls: toIndex },
      appendEntry,
    );
  }

  return handled;
}
