import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, join } from "node:path";
import type { CapturedBatch, CapturedToolCall, ToolCallRecord } from "./types.ts";

import type { ToolCallIndexer } from "./indexer.ts";
import { hashToolResult } from "./content-hash.ts";
import { occKey } from "./occurrence-key.ts";
import { packToolResult } from "./packing.ts";

/** Import the execution layer's full output, not its truncated display text. */
export async function importOutputArchive(call: CapturedToolCall, sessionDir: string, sessionId: string): Promise<boolean> {
  const source = call.outputArchive;
  if (!source || !isAbsolute(source.path)) return false;
  const info = await stat(source.path);
  if (!info.isFile()) return false;
  const bytes = source.bytes ?? info.size;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > info.size
  )
    throw new Error("Incomplete output archive snapshot");
  const directory = blobDirFor(sessionDir, sessionId);
  // Owned exec logs are append-only, already durable, and can be shared by
  // successive polls. Each record pins its visible byte length independently.
  const local = relative(directory, source.path);
  const appendOnly = source.appendOnly === true && /^exec-[a-f0-9-]+\.log$/.test(local);
  const target = appendOnly ? source.path : blobPathFor(sessionDir, sessionId, `output-${call.toolCallId}@${call.resultTimestamp}`);
  if (!appendOnly) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      if (bytes === 0) await writeFile(target, "", { mode: 0o600 });
      else await pipeline(createReadStream(source.path, { start: 0, end: bytes - 1 }), createWriteStream(target, { mode: 0o600 }));
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
  call.resultText = "";
  call.archiveSource = source.source ?? "command-output";
  call.archiveComplete = source.complete;
  call.archiveAppendOnly = appendOnly;
  // Do not seed normalized tool-result dedup with a truncated preview/empty body.
  call.contentHash = createHash("sha256")
    .update(`${target}:${bytes}${call.resultPrefix ? `:${call.resultPrefix}` : ""}`)
    .digest("hex");
  return true;
}

/** Prepare execution output archives without publishing pruning. */
export async function archiveToolOutput(call: CapturedToolCall, args: {
  sessionDir: string; sessionId: string;
}): Promise<void> {
  if (call.outputArchive?.complete === false || call.archiveComplete === false) throw new Error("Incomplete execution archive");
  if (!call.outputArchive) return;
  if (!await importOutputArchive(call, args.sessionDir, args.sessionId)) throw new Error("Execution archive unavailable");
}

/** Persist complete outputs and recovery records before a caller hides any history. */
export async function archiveBatches(batches: readonly CapturedBatch[], args: {
  indexer: ToolCallIndexer; sessionDir: string; sessionId: string;
  appendEntry: (customType: string, data?: unknown) => void;
  spillThreshold: number; spillPreviewBytes: number;
}) {
  const records: ToolCallRecord[] = [];
  for (const batch of batches) for (const call of batch.toolCalls) {
    await archiveToolOutput(call, args);
    records.push({ ...call, turnIndex: batch.turnIndex, timestamp: batch.timestamp, archiveOnly: true,
      contentHash: call.contentHash ?? hashToolResult(call.toolName, call.resultText) });
  }
  return args.indexer.backfillChainRecords(records, args);
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
  // Safe short IDs keep their names. A lossy replacement or length cap needs
  // the original key's identity: distinct occurrences must not overwrite one
  // another. JSON encoding also preserves any lone UTF-16 code units.
  // 186-byte ASCII prefix + "." + 64-hex digest + ".txt" = 255 bytes.
  // The dot separates hashed names from safe IDs, which cannot contain it.
  const name =
    base === toolCallId && Buffer.byteLength(base, "utf8") <= 251
      ? `${base}.txt`
      : `${base.slice(0, 186)}.${createHash("sha256").update(JSON.stringify(toolCallId)).digest("hex")}.txt`;
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
        indexer.registerDuplicate(key, original, appendEntry, { ...tc, turnIndex: batch.turnIndex, timestamp: batch.timestamp });
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
