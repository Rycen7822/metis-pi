// V8 Code Mode host protocol: a real CodeModeHostClient talking to a stand-in host
// process over the shipped length-prefixed frame protocol. This verifies connection
// setup, session/open, execute/wait/terminate, delegate replies, cancellation,
// connection exit and shutdown; it does NOT prove a real V8 host cell executed.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeModeHostClient } from "../../src/code-mode/host-client.ts";
import { hostAssetUrl, resolveCodeModeHostAsset } from "../../src/code-mode/host-assets.ts";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";

test("host downloads use the metis release only on compatible Linux x64", () => {
	const own = resolveCodeModeHostAsset("linux", "x64", "2.34");
	assert.equal(own.repository, "Rycen7822/metis-pi");
	assert.match(hostAssetUrl(own), /code-mode-host-rust-v0\.145\.0-metis\.3/);
	assert.equal(resolveCodeModeHostAsset("linux", "x64", "2.33").repository, "openai/codex");
	assert.equal(resolveCodeModeHostAsset("linux", "x64", "").repository, "openai/codex");
	assert.equal(resolveCodeModeHostAsset("darwin", "arm64", "2.40").repository, "openai/codex");
});

// Speaks the host wire protocol (4-byte LE length + JSON) and follows the scenario
// flags in its embedded config, appending every received message to its log path.
const hostScript = (config, logPath) => `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const config = ${JSON.stringify(config)};
const log = (entry) => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + "\\n");
const cellId = "cell-1";
let delegateWaiter;
let buffer = Buffer.alloc(0);
const send = (message) => {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
};
const waitResult = (id) => send({ type: "operation/response", id, result: { status: "ok", value: { outcome: { LiveCell: { Result: { cell_id: cellId, content_items: [{ type: "input_text", text: "done" }] } } } } } });

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) return;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
    buffer = buffer.subarray(4 + length);
    handle(message);
  }
});

function handle(message) {
  log({ received: message.type, id: message.id, method: message.request?.method });
  if (message.type === "connection/hello") {
    if (!config.ignoreHello) setTimeout(() => send({ type: "connection/ready", selectedVersion: 1, capabilities: config.capabilities ?? [] }), config.helloDelayMs ?? 0);
    return;
  }
  if (message.type === "delegate/response") {
    log({ delegateResult: message.result });
    const release = delegateWaiter;
    delegateWaiter = undefined;
    release?.();
    return;
  }
  if (message.type !== "operation/request") return;
  const method = message.request.method;
  if (method === "session/open") {
    if (config.ignoreOpen) return;
    send({ type: "operation/response", id: message.id, result: { status: "ok", value: {} } });
    return;
  }
  if (method === "session/execute") {
    send({ type: "execute/initialResponse", id: message.id, result: { status: "ok", value: { Yielded: { cell_id: cellId, content_items: [{ type: "input_text", text: "executing" }] } } } });
    send({ type: "operation/response", id: message.id, result: { status: "ok", value: { type: "execution/started", cellId } } });
    return;
  }
  if (method === "session/wait") {
    if (config.delegateOnWait) {
      delegateWaiter = () => waitResult(message.id);
      send({ type: "delegate/request", id: 7, request: { type: "tool/invoke", invocation: { cell_id: cellId, runtime_tool_call_id: "t1", tool_name: { name: "probe_tool" }, input: { value: 1 } } } });
      return;
    }
    if (config.holdWait) {
      log({ held: message.id });
      if (config.exitWhileWaiting) setTimeout(() => process.exit(0), 20);
      return;
    }
    waitResult(message.id);
    return;
  }
  if (method === "session/terminate") {
    send({ type: "operation/response", id: message.id, result: { status: "ok", value: { outcome: { LiveCell: { Terminated: { cell_id: cellId } } } } } });
    return;
  }
  if (method === "session/shutdown" && !config.ignoreShutdown) {
    send({ type: "operation/response", id: message.id, result: { status: "ok", value: {} } });
  }
}
`;

/** Client plus scenario host; the test owns both processes' cleanup. The shutdown
 * hook is registered before the temp directory so cleanup never deletes it first. */
function startClient(t, config = {}, shutdownGraceMs = 1_000, startupTimeoutMs = 2_000) {
  let client;
  t.after(() => client?.shutdown().catch(() => undefined));
  const dir = temporaryDirectory(t, "metis-code-mode-host-");
  const binary = join(dir, "fake-host.mjs");
  const logPath = join(dir, "host.log");
  writeFileSync(binary, hostScript(config, logPath));
  chmodSync(binary, 0o755);
  writeFileSync(logPath, "");
  client = new CodeModeHostClient({ binary, tools: [], shutdownGraceMs, startupTimeoutMs });
  const host = {
    configure: (next) => writeFileSync(binary, hostScript(next, logPath)),
    messages: () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
  return { host, client, context: { cwd: dir } };
}

const probeTool = (invoked) => ({
  name: "probe_tool",
  kind: "function",
  inputSchema: { type: "object", properties: { value: { type: "number" } } },
  description: "Records the delegated invocation.",
  sourcePath: "/tmp/probe-tool.ts",
  async invoke(input) { invoked.push(input); return { echoed: input }; },
});

// The host runs in its own process, so a receipt is observable only after it is scheduled;
// poll with real time instead of asserting immediately on its log file.
async function waitFor(predicate, description = "the host did not reach the expected state") {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), description);
}

test("a real client drives the framed host session through execute, delegate, wait and terminate", async (t) => {
  const { host, client, context } = startClient(t, { delegateOnWait: true });
  const invoked = [];

  const started = await client.execute("probe();", context, undefined, [probeTool(invoked)]);
  assert.equal(started.kind, "yielded");
  assert.equal(started.cellId, "cell-1");
  assert.deepEqual(started.contentItems, [{ type: "input_text", text: "executing" }]);

  const finished = await client.wait("cell-1", 5, context);
  assert.equal(finished.kind, "result");
  assert.deepEqual(finished.contentItems, [{ type: "input_text", text: "done" }]);
  assert.deepEqual(invoked, [{ value: 1 }]);
  const delegated = host.messages().find((entry) => entry.delegateResult);
  assert.deepEqual(delegated.delegateResult, {
    status: "ok",
    value: { type: "tool/result", result: { echoed: { value: 1 } } },
  });

  const terminated = await client.terminate("cell-1", context);
  assert.equal(terminated.kind, "terminated");
  assert.deepEqual(
    host.messages().filter((entry) => entry.method).map((entry) => entry.method),
    ["session/open", "session/execute", "session/wait", "session/terminate"],
  );
});

test("cancelling a pending host call rejects it and notifies the host", async (t) => {
  const { host, client, context } = startClient(t, { holdWait: true });
  await client.execute("probe();", context, undefined, []);

  const controller = new AbortController();
  const waiting = client.wait("cell-1", 5, context, controller.signal);
  await waitFor(() => host.messages().some((entry) => entry.held !== undefined));
  controller.abort(new Error("user cancelled"));

  await assert.rejects(waiting, (error) => error.name === "AbortError");
  await waitFor(
    () => host.messages().some((entry) => entry.received === "operation/cancel"),
    "the host receives the operation cancellation",
  );
});

test("a host that exits fails the request that was still pending", async (t) => {
  const { host, client, context } = startClient(t, { holdWait: true, exitWhileWaiting: true });
  await client.execute("probe();", context, undefined, []);

  await assert.rejects(
    client.wait("cell-1", 5, context),
    /Code-mode host (is not running|exited with code)/,
  );
  assert.ok(host.messages().some((entry) => entry.held !== undefined), "the wait was in flight when the host exited");
});

test("shutdown honours its deadline when the host never answers and drops pending calls", async (t) => {
  const { host, client, context } = startClient(t, { holdWait: true, ignoreShutdown: true }, 100);
  await client.execute("probe();", context, undefined, []);
  const waiting = assert.rejects(client.wait("cell-1", 5, context), /Code-mode host (shut down|is not running|exited with code)/);
  await waitFor(() => host.messages().some((entry) => entry.held !== undefined));

  const started = performance.now();
  await client.shutdown();
  assert.ok(performance.now() - started < 2_000, "shutdown gives up on a silent host");
  assert.ok(host.messages().some((entry) => entry.method === "session/shutdown"), "the shutdown request was sent");
  await waiting;
});

for (const phase of ["ignoreHello", "ignoreOpen"]) {
  test(`startup deadline bounds ${phase} and allows retry`, async (t) => {
    const { client, host } = startClient(t, { [phase]: true }, 100, 200);
    await assert.rejects(client.start(), /startup timed out/);
    host.configure({});
    await client.start();
  });
}

test("aborting one startup caller preserves another caller and shutdown allows restart", async (t) => {
  const { client, host } = startClient(t, { helloDelayMs: 100 });
  const controller = new AbortController();
  const cancelled = assert.rejects(client.start(controller.signal), { name: "AbortError" });
  const healthy = client.start();
  controller.abort();
  await cancelled;
  await healthy;
  await client.shutdown();
  host.configure({ ignoreHello: true });
  const interrupted = assert.rejects(client.start(), /shut down/);
  await client.shutdown();
  host.configure({});
  await interrupted;
  await client.start();
});

test("delegation keeps execution cwd and model while updates reach the current observer", async (t) => {
  const { client, context } = startClient(t, { delegateOnWait: true });
  let model = { id: "original" };
  const updates = [];
  const hooks = [];
  const origin = { ...context, toolCallId: "exec-origin", extensionContext: { get model() { return model; } },
    preflight: async (call) => { hooks.push(call.cwd); },
    completion: async (call) => { hooks.push(call.cwd); } };
  const tool = { ...probeTool([]), async invoke(_input, ctx) {
    assert.equal(ctx.cwd, context.cwd);
    assert.equal(ctx.extensionContext.model.id, "original");
    return "origin preserved";
  } };
  const executing = client.execute("probe();", origin, undefined, [tool]);
  model = { id: "changed" };
  await executing;
  const result = await client.wait("cell-1", 5, { ...context, cwd: "/different", toolCallId: "wait-observer", onUpdate: (x) => updates.push(x) });
  assert.equal(result.kind, "result");
  assert.deepEqual(hooks, [context.cwd, context.cwd]);
  assert.ok(updates.length > 0);
});

for (const supported of [false, true]) {
  test(`steering transport respects capability negotiation (${supported}) and fails safely`, async (t) => {
    const { client, host, context } = startClient(t, { holdWait: true, capabilities: supported ? ["yield-observation"] : [] });
    await client.execute("probe();", context);
    const preempt = new AbortController();
    const waiting = client.wait("cell-1", 5, context, undefined, preempt.signal);
    await waitFor(() => host.messages().some((entry) => entry.held !== undefined));
    // A transport failure during an input event must reject the operation, not escape abort().
    const send = client.connection.send.bind(client.connection);
    client.connection.send = (message) => {
      if (message.type === "operation/yield") throw new Error("transport unavailable");
      send(message);
    };
    const rejected = assert.rejects(waiting, supported ? /transport unavailable/ : /shut down/);
    preempt.abort();
    await client.shutdown();
    await rejected;
  });
}
