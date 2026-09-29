// Actual V8 host smoke checks, deliberately separate from the stand-in protocol tests.
// Pass a freshly built binary explicitly; this script never downloads a host.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CodeModeHostClient } from "../vendor/pi-codex-conversion/src/tools/code-mode/host-client.ts";

assert.ok(process.argv[2], "usage: node --experimental-strip-types scripts/verify-code-mode-host.mjs HOST");
const client = new CodeModeHostClient({ binary: process.argv[2], tools: [], shutdownGraceMs: 1_000 });
const context = { cwd: process.cwd() };
const texts = (r) => r.contentItems?.filter((x) => x.type === "input_text").map((x) => x.text) ?? [];
const timeout = setTimeout(() => { console.error("real host smoke timed out"); process.exit(1); }, 20_000);
let unblock;
try {
  const echo = { name: "echo", kind: "function", inputSchema: { type: "object", properties: {} },
    async invoke(value) { return value ?? "omitted"; } };
  const ordinary = await client.execute('text(await tools.echo(undefined));store("shared",{n:7});', context, undefined, [echo]);
  assert.equal(ordinary.kind, "result");
  assert.deepEqual(texts(ordinary), ["omitted"]);
  assert.deepEqual(texts(await client.execute('text(load("shared").n);', context)), ["7"]);

  // Already signalled when execute begins: the host must remember the request's
  // signal even if its cell observer has not yet been installed.
  const early = new AbortController();
  early.abort();
  const cell = await client.execute('await new Promise(r=>setTimeout(r,600));text("continued");', context, undefined, [], early.signal);
  assert.equal(cell.kind, "yielded");
  const preempt = new AbortController();
  const waiting = client.wait(cell.cellId, 10_000, context, undefined, preempt.signal);
  await delay(30);
  preempt.abort();
  assert.equal((await waiting).kind, "yielded");
  const finished = await client.wait(cell.cellId, 10_000, context);
  assert.equal(finished.kind, "result");
  assert.deepEqual(texts(finished), ["continued"]);

  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { unblock = resolve; });
  let toolSignal;
  const blocked = { ...echo, blocking: true, async invoke(_input, _context, signal) {
    toolSignal = signal; entered(); await gate; return "tool survived";
  } };
  const steering = new AbortController();
  const executing = client.execute('text(await tools.echo());store("afterInput",9);', context, undefined, [blocked], steering.signal);
  await started;
  steering.abort();
  const yielded = await executing;
  assert.equal(yielded.kind, "yielded");
  assert.equal(toolSignal.aborted, false);
  unblock();
  const completed = await client.wait(yielded.cellId, 10_000, context);
  assert.deepEqual(texts(completed), ["tool survived"]);
  assert.deepEqual(texts(await client.execute('text(load("afterInput"));', context)), ["9"]);

  const live = await client.execute('// @exec: {"yield_time_ms": 1}\nawait new Promise(r=>setTimeout(r,60000));', context);
  assert.equal(live.kind, "yielded");
  assert.equal((await client.terminate(live.cellId, context)).kind, "terminated");
  console.log("Real host passed: delegation, undefined, storage, early yield, wait yield, blocking tool survival, terminate.");
} finally {
  unblock?.();
  await client.shutdown();
  clearTimeout(timeout);
}
