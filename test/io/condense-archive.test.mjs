import test from "node:test";
import assert from "node:assert/strict";
import { record, queryFixture } from "../helpers/condense-query.mjs";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { captureBatch } from "../../src/condense/batch-capture.ts";
import { spillOversizedBatch } from "../../src/condense/spill.ts";
import { DEFAULT_CONFIG } from "../../src/condense/types.ts";
import { ExecOutputArchive } from "../../src/execution/exec/output-archive.ts";

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
  const info = archive.info(); assert.ok(info);
  const assistant = { content: [{ type: "toolCall", id: "exec-original", name: "exec_command", arguments: { cmd: "producer" } }] };
  const batch = captureBatch(assistant, [{ toolCallId: "exec-original", timestamp: 3, isError: false, content: [{ type: "text", text: "DISPLAY_TAIL" }], details: info }], 1, 2);
  await spillOversizedBatch({ batch, indexer, config: DEFAULT_CONFIG, sessionDir: dir, sessionId: sm.getSessionId(), appendEntry: (type, data) => sm.appendCustomEntry(type, data) });
  const first = (await run({ toolCallIds: ["exec-original"], maxBytes: 2048 })).details;
  archive.append("LATER OUTPUT THAT MUST NOT CHANGE THE OLD SNAPSHOT"); archive.close();
  let body = first, restored = first.results[0].text;
  while (body.nextCursor) {
    body = (await run({ toolCallIds: ["exec-original"], maxBytes: 2048, cursor: body.nextCursor })).details;
    restored += body.results[0].text;
  }
  assert.equal(restored, original);
  assert.equal(first.results[0].source, "command-output");
  assert.equal(first.results[0].archiveComplete, true);
  assert.equal(indexer.getRecord("exec-original").spillPath, info.fullOutputPath, "polls share the durable producer log");
  assert.ok(existsSync(info.fullOutputPath));
  assert.equal(readFileSync(info.fullOutputPath, "utf8"), original + "LATER OUTPUT THAT MUST NOT CHANGE THE OLD SNAPSHOT");

  const temporary = join(dir, "native-bash.log"); writeFileSync(temporary, "native full output");
  const native = captureBatch({ content: [{ type: "toolCall", id: "bash-native", name: "bash", arguments: { command: "native" } }] }, [{ toolCallId: "bash-native", timestamp: 7, content: [{ type: "text", text: "native tail" }], details: { fullOutputPath: temporary } }], 2, 6);
  await spillOversizedBatch({ batch: native, indexer, config: DEFAULT_CONFIG, sessionDir: dir, sessionId: sm.getSessionId(), appendEntry() {} });
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
  const partial = join(dir, "partial.log"); writeFileSync(partial, "captured prefix");
  const batch = captureBatch({ content: [{ type: "toolCall", id: "partial", name: "bash", arguments: { command: "producer" } }] },
    [{ toolCallId: "partial", timestamp: 4, content: [{ type: "text", text: "display tail" }], details: { fullOutputPath: partial, fullOutputComplete: false } }], 1, 3);
  await spillOversizedBatch({ batch, indexer, config: DEFAULT_CONFIG, sessionDir: dir, sessionId: ctx.sessionManager.getSessionId(), appendEntry() {} });
  const result = (await run({ toolCallIds: ["partial"] })).details.results[0];
  assert.equal(result.text, "captured prefix");
  assert.equal(result.archiveComplete, false);
  assert.match(result.error, /incomplete/i);
  assert.throws(() => indexer.addBatch({ ...batch, toolCalls: [record("rejected", "unpublished")] }, () => { throw new Error("disk write failed"); }), /disk write failed/);
  assert.equal(indexer.getRecord("rejected"), undefined, "failed persistence cannot authorize pruning");
});
