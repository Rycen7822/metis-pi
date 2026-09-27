import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodeModeDelegateRuntime } from "../../vendor/pi-codex-conversion/dist/tools/code-mode/delegate-runtime.js";
import { toCodeModeToolResult } from "../../vendor/pi-codex-conversion/dist/tools/code-mode/tool-result.js";
import { FusionEvidenceStore } from "../../vendor/pi-codex-conversion/dist/tools/code-mode/fusion-evidence.js";
import { captureBatch } from "../../vendor/pi-condense/dist/src/batch-capture.js";
import { spillOversizedBatch } from "../../vendor/pi-condense/dist/src/spill.js";
import { ToolCallIndexer } from "../../vendor/pi-condense/dist/src/indexer.js";
import { registerQueryTool } from "../../vendor/pi-condense/dist/src/query-tool.js";
import { DEFAULT_CONFIG } from "../../vendor/pi-condense/dist/src/types.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "fusion-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sm = SessionManager.create(dir, dir), ctx = { cwd: dir, sessionManager: sm };
  const indexer = new ToolCallIndexer();
  const ingest = async (result, id, timestamp) => {
    const batch = captureBatch({ content: [{ type: "toolCall", id, name: "exec", arguments: { code: "fused" } }] },
      [{ ...result, toolCallId: id, timestamp }], 0, timestamp);
    await spillOversizedBatch({ batch, indexer, config: DEFAULT_CONFIG, sessionDir: dir, sessionId: sm.getSessionId(),
      appendEntry: (type, data) => sm.appendCustomEntry(type, data) });
  };
  return { dir, sm, ctx, indexer, ingest };
}

const full = "BEGIN\r\n" + "中文\u001b[31m exact output\n".repeat(500) + "END";
function receipt(path) {
  return { content: [{ type: "text", text: "Updated file.ts\n+saved" }, { type: "text", text: `Command succeeded; log ${path}` }, { type: "text", text: "DISPLAY ONLY" }],
    details: { metisActionFusion: { version: 1, mutationStatus: "success", command: { command: "npm test", status: "succeeded", exitCode: 0, outputBlock: 2,
      fullOutputPath: path, fullOutputBytes: Buffer.byteLength(full), fullOutputComplete: true } } } };
}

async function recover(indexer, ctx, id) {
  let tool; registerQueryTool({ registerTool(value) { tool = value; } }, indexer);
  let cursor, text = "";
  do {
    const data = (await tool.execute("query", { toolCallIds: [id], maxBytes: 2048, ...(cursor ? { cursor } : {}) }, undefined, undefined, ctx)).details;
    assert.equal(data.results.length, 1);
    text += data.results[0].text;
    cursor = data.nextCursor;
  } while (cursor);
  return text;
}

test("nested receipts survive trace eviction, incremental publication, reload and repeated archive import", async (t) => {
  const f = fixture(t), path = join(f.dir, "command.log"); writeFileSync(path, full);
  const runtime = new CodeModeDelegateRuntime(() => {}); t.after(() => runtime.clear());
  const result = receipt(path);
  runtime.bindCell("cell", { cwd: f.dir, extensionContext: f.ctx }, new Map([["apply_patch_then_run", {
    kind: "function", name: "apply_patch_then_run", description: "fuse", inputSchema: {},
    async invoke(_input, ctx) { ctx.captureResult(result); return "done"; },
  }]]));
  const invoke = id => runtime.invokeDirect("cell", id, "apply_patch_then_run", { input: "patch", then_run: { command: "npm test" } });
  for (let id = 0; id < 65; id++) await invoke(id);
  const first = runtime.attach({ kind: "yielded", cellId: "cell", contentItems: [{ type: "input_text", text: "x".repeat(5000) }] });
  assert.ok(first.traces.length < 65, "the proof must actually exceed the UI trace budget");
  assert.ok(first.droppedTraceCount > 0);
  const outer = toCodeModeToolResult(first, 1);
  assert.match(outer.content.map(b => b.text ?? "").join("\n"), /Fused tool evidence:/, "the reference is outside the outer text budget");
  const snapshot = readFileSync(first.fusionEvidence.path).subarray(0, first.fusionEvidence.bytes).toString();
  const records = snapshot.trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(records.length, 65);
  for (let id = 65; id < 68; id++) await invoke(id);
  const second = runtime.attach({ kind: "result", cellId: "cell", contentItems: [] });
  assert.equal(second.fusionEvidence.offsetBytes, first.fusionEvidence.bytes);
  assert.equal(runtime.attach({ kind: "result", cellId: "cell", contentItems: [] }).fusionEvidence, undefined, "attach never republishes old records");
  runtime.clear();
  await f.ingest(outer, "first", 1);
  assert.equal(f.indexer.getIndex().size, 66, "all 65 children are indexed even though most were evicted");
  await f.ingest(outer, "first", 1);
  assert.equal(f.indexer.getIndex().size, 66);
  await f.ingest(toCodeModeToolResult(second), "second", 2);
  assert.equal(f.indexer.getIndex().size, 70);
  const reloaded = new ToolCallIndexer(); reloaded.reconstructFromSession(f.ctx);
  assert.equal(await recover(reloaded, f.ctx, records[0].id), `Updated file.ts\n+saved\nCommand succeeded; log ${path}\n${full}`);
  const parent = await recover(reloaded, f.ctx, "first");
  assert.ok(parent.endsWith(snapshot), "old outer results pin the exact journal byte range despite later appends");
  assert.match(parent, /Still running/);
});

test("failed persistence exposes a warning without breaking completed mutations", (t) => {
  const f = fixture(t), occupied = join(f.dir, "file"); writeFileSync(occupied, "occupied");
  const store = new FusionEvidenceStore();
  store.capture("cell", "id", "apply_patch_then_run", {}, receipt("unused"), {
    cwd: f.dir, extensionContext: { sessionManager: { getSessionDir: () => occupied, getSessionId: () => "s" } },
  });
  const result = toCodeModeToolResult({ kind: "result", cellId: "cell", contentItems: [], ...store.take("cell") });
  assert.match(result.content.map(b => b.text ?? "").join("\n"), /could not be persisted/);
  assert.equal(result.details.fusionEvidence, undefined);
});
