import test from "node:test";
import assert from "node:assert/strict";
import { record, queryFixture } from "../helpers/condense-query.mjs";
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { captureBatch } from "../../src/condense/batch-capture.ts";
import { archiveBatches, blobPathFor, spillOversizedBatch } from "../../src/condense/spill.ts";
import { DEFAULT_CONFIG } from "../../src/condense/config.ts";
import { ExecOutputArchive } from "../../src/execution/exec/output-archive.ts";

test("spill paths preserve distinct occurrence bodies after reload and keep existing archive paths readable", async (t) => {
  const dir = temporaryDirectory(t, "condense-spill-identity-");
  const sm = SessionManager.create(dir, dir);
  const { ctx, indexer, run } = queryFixture([], sm);
  const originals = [
    ["a:b", "COLON_BODY\nα😀"],
    ["a/b", "SLASH_BODY\n中文"],
    ["a_b", "UNDERSCORE_BODY"],
  ];
  const batch = {
    turnIndex: 1,
    timestamp: 2,
    assistantText: "",
    toolCalls: originals.map(([id, text]) => record(id, text, 3)),
  };
  const spill = { indexer, sessionDir: dir, sessionId: sm.getSessionId(),
    appendEntry: (type, data) => sm.appendCustomEntry(type, data) };
  let baselines = 0;
  const handled = await spillOversizedBatch({ ...spill, batch,
    config: { ...DEFAULT_CONFIG, spillThreshold: 1, dedupByContentHash: false },
    beforeIndex() {
      baselines++;
      for (const [id] of originals) assert.equal(indexer.getRecord(`${id}@3`), undefined);
    } });
  assert.equal(baselines, 1, "one pre-change baseline for the complete batch");
  assert.equal(handled.size, originals.length, "every spilled occurrence contributes to the action count");
  indexer.reconstructFromSession(ctx);
  for (const [id, original] of originals) {
    const page = (await run({ toolCallIds: [`${id}@3`] })).details.results[0];
    assert.equal(page.text, original);
    assert.equal(page.complete, true);
  }
  assert.equal(new Set(originals.map(([id]) => indexer.getRecord(`${id}@3`).spillPath)).size, originals.length);
  for (const id of ["safe_id", "a:b@3", "a/b@3", "very-long:" + "中".repeat(500)]) {
    const path = blobPathFor(dir, sm.getSessionId(), id);
    assert.ok(Buffer.byteLength(basename(path)) <= 255);
    assert.equal(path, blobPathFor(dir, sm.getSessionId(), id));
  }

  // Existing entries retain their recorded path; filename changes do not rename recovery evidence.
  const legacyDirectory = join(dir, `${sm.getSessionId()}-blobs`);
  mkdirSync(legacyDirectory, { recursive: true });
  const legacyPath = join(legacyDirectory, "legacy_id_7.txt");
  writeFileSync(legacyPath, "LEGACY_ORIGINAL");
  sm.appendCustomEntry("context-prune-index", {
    toolCalls: [record("legacy:id", "", 7, { spillPath: legacyPath, spillBytes: 15 })],
  });
  indexer.reconstructFromSession(ctx);
  assert.equal((await run({ toolCallIds: ["legacy:id@7"] })).details.results[0].text, "LEGACY_ORIGINAL");

  const duplicate = await spillOversizedBatch({ ...spill,
    batch: { ...batch, toolCalls: [record("duplicate", originals[0][1], 4)] },
    config: { ...DEFAULT_CONFIG, spillThreshold: 1, dedupByContentHash: true },
    beforeIndex() {
      baselines++;
      assert.equal(indexer.getRecord("duplicate@4"), undefined, "dedup measures before publishing its reference");
    } });
  assert.ok(duplicate.has("duplicate"));
  assert.equal(baselines, 2);
  assert.equal((await run({ toolCallIds: ["duplicate@4"] })).details.results[0].text, originals[0][1]);
});

test("cold directory preserves historical refs without retaining or loading payloads for listing", async t => {
  const prefix = JSON.stringify({ path: "old.txt", content: "" }).length - 2;
  const args = { path: "old.txt", content: "x".repeat(255 - prefix) + "😀" + "large args ".repeat(1000) };
  const first = record("reused", "ORIGINAL_ONE 宽字符", 3, { args });
  const second = record("reused", "ORIGINAL_TWO", 5);
  const f = queryFixture([first, second]);
  const archive = f.ctx.sessionManager.appendCustomEntry("context-prune-index",
    { toolCalls: [first], backfilled: true, refs: [{ shortId: "t70", toolCallId: "reused", resultTimestamp: 3 }] });
  const kept = f.ctx.sessionManager.appendMessage({ role: "user", content: "current window", timestamp: 10 });
  f.ctx.sessionManager.appendCompaction("old tasks compressed", kept, 1000);
  await f.indexer.reconstructFromSessionAsync(f.ctx, () => {});
  const reader = f.ctx.sessionManager.getEntryForScan.bind(f.ctx.sessionManager);
  const reads = [];
  t.mock.method(f.ctx.sessionManager, "getEntryForScan", id => { reads.push(id); return reader(id); });
  const directory = [...f.indexer.directory()];
  assert.equal(directory.length, 2);
  assert.ok(directory.every(entry => !("args" in entry) && !("resultText" in entry)));
  assert.equal(directory.find(entry => entry.ref === "t70").argsPreview, JSON.stringify(first.args).slice(0, 256));
  assert.equal(f.indexer.lookupByContent(first.toolName, first.resultText), "reused@3");
  assert.equal(f.indexer.resolveToolCallId("reused"), undefined, "reused bare IDs remain ambiguous");
  assert.deepEqual(reads, [], "directory and dedup lookup must not hydrate old payloads");
  assert.equal((await f.run({ toolCallIds: ["t70"] })).details.results[0].text, first.resultText);
  assert.ok(reads.length > 0 && reads.every(id => id === archive), "recall reads only the addressed archival entry");
  assert.equal(f.indexer.getRecord("reused@5").resultText, second.resultText);
});

test("cancelled cold reconstruction cannot publish a partial directory and remains retryable", async () => {
  const f = queryFixture([record("existing", "EXISTING")]);
  f.ctx.sessionManager.appendCustomEntry("context-prune-index", { toolCalls: [record("new", "NEW")] });
  const controller = new AbortController();
  const pending = f.indexer.reconstructFromSessionAsync(f.ctx, () => controller.signal.throwIfAborted());
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.indexer.getRecord("existing@3").resultText, "EXISTING");
  assert.equal(f.indexer.getRecord("new@3"), undefined, "no half-built replacement escapes cancellation");
  await f.indexer.reconstructFromSessionAsync(f.ctx, () => {});
  assert.equal(f.indexer.getRecord("new@3").resultText, "NEW");
});

test("archive retries reuse occurrence refs, append only changed records and restore missing spill evidence", async t => {
  const dir = temporaryDirectory(t, "condense-archive-retry-");
  const sm = SessionManager.create(dir, dir), f = queryFixture([], sm);
  const calls = [record("small", "small body", 3), record("large", "large body ".repeat(100), 4)];
  const batch = toolCalls => ({ turnIndex: 1, timestamp: 2, assistantText: "", toolCalls: structuredClone(toolCalls) });
  const options = { indexer: f.indexer, sessionDir: dir, sessionId: sm.getSessionId(), spillThreshold: 100,
    spillPreviewBytes: 30, appendEntry: (type, data) => sm.appendCustomEntry(type, data) };
  const entries = () => sm.getEntries().filter(entry => entry.type === "custom"
    && entry.customType === "context-prune-index" && entry.data.toolCalls.length > 0);
  const first = await archiveBatches([batch(calls)], options);
  for (let i = 0; i < 3; i++) assert.deepEqual(await archiveBatches([batch(calls)], options), first);
  assert.equal(entries().length, 1, "unchanged retries do not journal another archive");
  const extra = record("small", "different execution", 5);
  const mixed = await archiveBatches([batch([calls[1], extra, calls[0]])], options);
  assert.deepEqual([mixed[0], mixed[2]], [first[1], first[0]], "mixed batches keep input order and existing refs");
  assert.equal(entries().length, 2);
  assert.deepEqual(entries()[1].data.toolCalls.map(call => `${call.toolCallId}@${call.resultTimestamp}`), ["small@5"]);
  assert.notEqual(mixed[1].shortId, first[0].shortId, "reused bare IDs do not merge independent occurrences");
  f.indexer.reconstructFromSession(f.ctx);
  assert.deepEqual(await archiveBatches([batch(calls)], options), first, "durable refs also survive reconstruction");
  assert.equal(entries().length, 2);
  const spill = f.indexer.getRecord("large@4").spillPath;
  rmSync(spill);
  assert.deepEqual(await archiveBatches([batch([calls[1]])], options), [first[1]], "missing evidence is repaired without renumbering");
  assert.equal(readFileSync(spill, "utf8"), calls[1].resultText);
  assert.equal(entries().length, 3);
  f.indexer.reconstructFromSession(f.ctx);
  for (const [ref, call] of [[first[0], calls[0]], [first[1], calls[1]], [mixed[1], extra]]) {
    const result = (await f.run({ toolCallIds: [ref.shortId] })).details.results[0];
    assert.equal(result.text, call.resultText);
    assert.equal(result.complete, true);
  }
  const published = record("published", "previously indexed evidence", 6);
  f.indexer.addBatch(batch([published]), options.appendEntry);
  assert.equal(f.indexer.isSummarized("published@6"), true);
  await archiveBatches([batch([published])], options);
  assert.equal(f.indexer.isSummarized("published@6"), true, "adding a ref never downgrades existing pruning authorization");
});

test("spill recall reaches the tail; archive loss cannot masquerade as a complete preview", async (t) => {
  const dir = temporaryDirectory(t, "condense-spill-");
  const file = join(dir, "body.txt");
  const original = "α😀\n".repeat(4000) + "TAIL_ERROR";
  writeFileSync(file, original);
  const f = queryFixture([record("spill", "", 3, { spillPath: file, spillBytes: Buffer.byteLength(original), resultPreview: "DECEPTIVE_PREVIEW" })]);
  let cursor, restored = "";
  do {
    const body = JSON.parse((await f.run({ toolCallIds: ["spill"], maxBytes: 2048, cursor })).content[0].text);
    restored += body.results[0].text;
    cursor = body.nextCursor;
  } while (cursor);
  assert.equal(restored, original);
  rmSync(file);
  const result = await f.run({ toolCallIds: ["spill", "missing"] });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /DECEPTIVE_PREVIEW/);
  assert.ok(result.details.results.every((page) => page.error && !page.complete && page.text === undefined));
});

test("execution archives survive display eviction, and recall pins append-only snapshots across growth", async (t) => {
  const dir = temporaryDirectory(t, "condense-archive-");
  const sm = SessionManager.create(dir, dir);
  const { indexer, run } = queryFixture([], sm);
  const directory = join(dir, `${sm.getSessionId()}-blobs`);
  const archive = new ExecOutputArchive(directory, 256);
  t.after(() => archive.close());
  const original = "START\r\n" + "中文\u001b[31m".repeat(1500) + "FIRST_END";
  archive.append(original);
  const info = archive.info();
  assert.ok(info);
  const assistant = {
    content: [{ type: "toolCall", id: "exec-original", name: "exec_command", arguments: { cmd: "producer" } }],
  };
  const batch = captureBatch(
    assistant,
    [
      {
        toolCallId: "exec-original",
        timestamp: 3,
        isError: false,
        content: [{ type: "text", text: "DISPLAY_TAIL" }],
        details: info,
      },
    ],
    1,
    2,
  );
  await spillOversizedBatch({
    batch,
    indexer,
    config: DEFAULT_CONFIG,
    sessionDir: dir,
    sessionId: sm.getSessionId(),
    appendEntry: (type, data) => sm.appendCustomEntry(type, data),
  });
  const first = (await run({ toolCallIds: ["exec-original"], maxBytes: 2048 })).details;
  archive.append("LATER OUTPUT THAT MUST NOT CHANGE THE OLD SNAPSHOT");
  archive.close();
  let body = first,
    restored = first.results[0].text;
  while (body.nextCursor) {
    body = (await run({ toolCallIds: ["exec-original"], maxBytes: 2048, cursor: body.nextCursor })).details;
    restored += body.results[0].text;
  }
  assert.equal(restored, original);
  assert.equal(first.results[0].source, "command-output");
  assert.equal(first.results[0].archiveComplete, true);
  assert.equal(
    indexer.getRecord("exec-original").spillPath,
    info.fullOutputPath,
    "polls share the durable producer log",
  );
  assert.ok(existsSync(info.fullOutputPath));
  assert.equal(
    readFileSync(info.fullOutputPath, "utf8"),
    original + "LATER OUTPUT THAT MUST NOT CHANGE THE OLD SNAPSHOT",
  );

  const temporary = join(dir, "native-bash.log");
  writeFileSync(temporary, "native full output");
  const native = captureBatch(
    { content: [{ type: "toolCall", id: "bash-native", name: "bash", arguments: { command: "native" } }] },
    [
      {
        toolCallId: "bash-native",
        timestamp: 7,
        content: [{ type: "text", text: "native tail" }],
        details: { fullOutputPath: temporary },
      },
    ],
    2,
    6,
  );
  await spillOversizedBatch({
    batch: native,
    indexer,
    config: DEFAULT_CONFIG,
    sessionDir: dir,
    sessionId: sm.getSessionId(),
    appendEntry() {},
  });
  rmSync(temporary);
  assert.equal((await run({ toolCallIds: ["bash-native"] })).details.results[0].text, "native full output");
});

test("archive failure is explicit and incomplete captured prefixes are not reported as full output", async (t) => {
  const dir = temporaryDirectory(t, "condense-failed-archive-");
  const { ctx, indexer, run } = queryFixture([]);
  const blocked = join(dir, "not-a-directory"); writeFileSync(blocked, "file");
  const failed = new ExecOutputArchive(blocked, 1);
  assert.doesNotThrow(() => failed.append("command keeps running"));
  assert.equal(failed.info().fullOutputComplete, false);
  assert.match(failed.info().fullOutputError, /unavailable/i);
  failed.close();
  const partial = join(dir, "partial.log");
  writeFileSync(partial, "captured prefix");
  const batch = captureBatch(
    { content: [{ type: "toolCall", id: "partial", name: "bash", arguments: { command: "producer" } }] },
    [
      {
        toolCallId: "partial",
        timestamp: 4,
        content: [{ type: "text", text: "display tail" }],
        details: { fullOutputPath: partial, fullOutputComplete: false },
      },
    ],
    1,
    3,
  );
  await spillOversizedBatch({
    batch,
    indexer,
    config: DEFAULT_CONFIG,
    sessionDir: dir,
    sessionId: ctx.sessionManager.getSessionId(),
    appendEntry() {},
  });
  const result = (await run({ toolCallIds: ["partial"] })).details.results[0];
  assert.equal(result.text, "captured prefix");
  assert.equal(result.archiveComplete, false);
  assert.match(result.error, /incomplete/i);
  assert.throws(
    () =>
      indexer.addBatch({ ...batch, toolCalls: [record("rejected", "unpublished")] }, () => {
        throw new Error("disk write failed");
      }),
    /disk write failed/,
  );
  assert.equal(indexer.getRecord("rejected"), undefined, "failed persistence cannot authorize pruning");
});
