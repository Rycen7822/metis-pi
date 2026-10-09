import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SubagentSession } from "../../src/subagents/session.ts";
import { SubagentClient } from "../../src/subagents/client.ts";
import { installSamplingMailbox } from "../../src/subagents/sampling.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(probe) {
  const end = Date.now() + 2000;
  while (!probe() && Date.now() < end) await tick();
  assert.ok(probe(), "bounded mailbox condition reached");
}
const notice = { notification_id: "question-notice", agent_id: "agent_child", run_id: "run_child", name: "child", event: "question", state: "needs_input", ui_request_id: "question" };
const question = { id: "question", agent_id: notice.agent_id, run_id: notice.run_id, generation: 1, method: "input", title: "Which branch?" };
const usage = { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t, kind = "thinking", toolFirst = false) {
  const dir = mkdtempSync(join(process.cwd(), ".work/mailbox-host-"));
  const manager = SessionManager.inMemory(dir);
  manager.appendCustomEntry("metis-subagent-scope", { sessionId: manager.getSessionId(), scope: "scope_test" });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const models = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  const model = { id: "mailbox", name: "Mailbox mock", provider: "mailbox-test", api: "openai-completions", baseUrl: "http://invalid", reasoning: true,
    input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const requests = [], operations = [], notifications = [], messages = [], events = [];
  let owner, ctx, replyWatch, pending = false, cursor = 0, mainCalls = 0, tools = 0, holdClaim, claimFailure;
  t.mock.method(SubagentClient.prototype, "call", async function (op, params, signal) {
    operations.push({ op, params });
    if (op === "pi_watch") return new Promise((resolve, reject) => {
      replyWatch = resolve;
      signal.addEventListener("abort", () => reject(new Error("owned watch closed")), { once: true });
    });
    if (op === "pi_claim") {
      if (holdClaim) await holdClaim;
      if (claimFailure) throw claimFailure;
      if (!pending) return { events: [], runs: [], questions: [] };
      pending = false;
      return { id: "delivery_question", events: [notice], runs: [], questions: [question] };
    }
    return {};
  });
  models.registerProvider(model.provider, { api: model.api, apiKey: "offline", models: [model], streamSimple(m, context, options) {
    const output = createAssistantMessageEventStream();
    const outside = context.messages.some(v => v.role === "user" && v.content === "outside");
    const n = outside ? 0 : ++mainCalls;
    const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), content: [], stopReason: "stop", usage };
    const r = { context, options, message }; requests.push(r);
    let finished = false;
    if (n > 1) {
      message.content = [{ type: "text", text: "Received the question" }];
      output.push({ type: "done", reason: "stop", message }); output.end(message); return output;
    }
    const index = toolFirst ? 1 : 0;
    if (toolFirst) message.content.push({ type: "toolCall", id: "already-planned", name: "mutate", arguments: {} });
    message.content.push(kind === "thinking" ? { type: "thinking", thinking: "closed reasoning", thinkingSignature: "first-signature" }
      : { type: "text", text: "closed text", ...(kind === "unknown" ? {} : { textSignature: JSON.stringify({ v: 1, id: "message-id", phase: kind }) }) });
    output.push({ type: "start", partial: message });
    output.push({ type: kind === "thinking" ? "thinking_start" : "text_start", contentIndex: index, partial: message });
    output.push({ type: kind === "thinking" ? "thinking_delta" : "text_delta", contentIndex: index, delta: "closed block", partial: message });
    r.endBlock = () => output.push({ type: kind === "thinking" ? "thinking_end" : "text_end", contentIndex: index, content: "closed block", partial: message });
    r.fail = () => {
      finished = true;
      message.stopReason = "error"; message.errorMessage = "Provider failed after the claim";
      output.push({ type: "error", reason: "error", error: message }); output.end(message);
    };
    r.finish = () => {
      finished = true;
      if (!toolFirst) message.content.push({ type: "toolCall", id: "stale-plan", name: "mutate", arguments: {} });
      message.stopReason = "toolUse";
      output.push({ type: "done", reason: "toolUse", message }); output.end(message);
    };
    options.signal.addEventListener("abort", () => {
      if (finished) return;
      finished = true;
      if (message.content[index].type === "thinking") message.content[index].thinkingSignature = "finalized-signature";
      message.stopReason = "aborted"; message.errorMessage = "Controlled request cancellation";
      output.push({ type: "error", reason: "aborted", error: message }); output.end(message);
    }, { once: true });
    return output;
  } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.on("session_start", (_event, context) => { ctx = context; owner = new SubagentSession(pi, { root: "/unused", tools: [], baseEnvKeys: [], scopeEnvKeys: [], maxFrame: 1000000 }, ctx, dir); });
      pi.on("before_agent_start", (_event, context) => owner.update(context));
      pi.on("turn_end", (event, context) => owner.boundary(event, context));
      pi.on("agent_before_settle", (event, context) => owner.boundary(event, context));
      pi.on("agent_settled", (_event, context) => owner.settled(context, true));
      pi.registerTool({ name: "mutate", label: "mutate", description: "Count a dispatched mutation", parameters: { type: "object", properties: {} }, execute: async () => {
        tools++; return { content: [{ type: "text", text: "executed once" }], details: {} };
      } });
    }] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: models, settingsManager: settings, resourceLoader: loader, sessionManager: manager, model, tools: ["mutate"] });
  t.after(async () => { await session.abort(); await owner?.close(); session.dispose(); rmSync(dir, { recursive: true, force: true }); });
  session.subscribe(e => events.push(e));
  await session.bindExtensions({ mode: "rpc", uiContext: { notify: (text, level) => notifications.push({ text, level }), setStatus() {}, setWidget() {} } });
  const deliver = async () => {
    await until(() => replyWatch); pending = true;
    const reply = replyWatch; replyWatch = undefined;
    reply({ cursor: ++cursor, notifications: [notice], agents: [] });
    await until(() => owner.attentionPending);
  };
  return { session, manager, models, model, requests, notifications, operations, events, deliver,
    ctx: () => ctx, tools: () => tools, holdClaim: value => { holdClaim = value; },
    clearPending: () => { pending = false; }, failClaim: error => { claimFailure = error; },
    start: () => { const task = session.prompt("main"); messages.push(task); return task; } };
}

for (const kind of ["thinking", "commentary"]) test(`mailbox yields at a completed ${kind} item before the stale planned tool`, async t => {
  const f = await fixture(t, kind), run = f.start();
  await until(() => f.requests.length === 1); const signal = f.ctx().signal;
  await f.deliver(); await f.deliver();
  assert.equal(f.operations.filter(v => v.op === "pi_claim").length, 0, "deltas are not yield boundaries");
  f.requests[0].endBlock(); await until(() => f.requests.length === 2); await run;
  assert.equal(f.notifications.filter(v => v.text.includes("needs input")).length, 1, "UI arrival deduped before sampling yields");
  assert.equal(signal.aborted, false, "the agent/tool operation was not cancelled");
  assert.equal(f.requests[0].options.signal.aborted, true, "only the superseded provider request was cancelled");
  assert.equal(f.tools(), 0, "old planned mutations were not dispatched");
  const saved = f.manager.getBranch().filter(e => e.type === "custom_message" && e.customType === "metis-subagent-attention");
  assert.equal(saved.length, 1); assert.equal(saved[0].details.receipt, "delivery_question"); assert.equal(saved[0].details.samplingYield, f.requests[0].message.timestamp);
  assert.ok(f.requests[1].context.messages.some(m => m.content?.some?.(b => b.type === "text" && b.text.includes("Which branch?"))));
  assert.equal(f.manager.getBranch().filter(e => e.type === "message" && e.message.role === "user").length, 1, "child data was not forged as a user instruction");
  const assistant = f.manager.getBranch().find(e => e.type === "message" && e.message.role === "assistant").message;
  assert.equal(assistant.stopReason, "stop"); assert.deepEqual(assistant.usage, usage);
  if (kind === "thinking") assert.equal(assistant.content[0].thinkingSignature, "finalized-signature");
  assert.equal(f.operations.filter(v => v.op === "pi_observe" && v.params.receipt === "delivery_question").length, 1);
  assert.equal(f.operations.some(v => v.op === "pi_uncertain"), false);
});

for (const [kind, toolFirst] of [["final_answer", false], ["unknown", false], ["thinking", true]]) test(`mailbox preserves ${toolFirst ? "an existing tool call" : kind} and uses the normal boundary`, async t => {
  const f = await fixture(t, kind, toolFirst), run = f.start(); await until(() => f.requests.length === 1);
  await f.deliver(); f.requests[0].endBlock(); await tick(); await tick();
  assert.equal(f.operations.filter(v => v.op === "pi_claim").length, 0);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.signal.aborted, false);
  f.requests[0].finish(); await run;
  assert.equal(f.tools(), 1, `dispatched work runs exactly once: ${JSON.stringify(f.manager.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult").map(e => e.message.content))}`);
  assert.equal(f.manager.getBranch().filter(e => e.type === "custom_message" && e.customType === "metis-subagent-attention").length, 1);
  assert.equal(f.manager.getBranch().find(e => e.type === "custom_message" && e.customType === "metis-subagent-attention").details.samplingYield, undefined);
});

test("without pending mail streaming proceeds and its planned tool runs normally", async t => {
  const f = await fixture(t), run = f.start(); await until(() => f.requests.length === 1);
  f.requests[0].endBlock(); await tick(); await tick();
  assert.equal(f.requests[0].options.signal.aborted, false);
  assert.equal(f.operations.some(v => v.op === "pi_claim"), false);
  f.requests[0].finish(); await run;
  assert.equal(f.tools(), 1); assert.equal(f.manager.getBranch().some(e => e.type === "custom_message"), false);
});

test("parent cancellation during a mailbox claim remains aborted and the unsaved receipt becomes uncertain", async t => {
  const f = await fixture(t), run = f.start(); await until(() => f.requests.length === 1);
  let release; f.holdClaim(new Promise(resolve => { release = resolve; }));
  await f.deliver(); f.requests[0].endBlock(); await until(() => f.operations.some(v => v.op === "pi_claim"));
  const abort = f.session.abort(); release(); await abort; await run;
  assert.equal(f.requests.length, 1); assert.equal(f.tools(), 0);
  assert.equal(f.manager.getBranch().filter(e => e.type === "custom_message" && e.customType === "metis-subagent-attention").length, 0);
  assert.equal(f.operations.filter(v => v.op === "pi_uncertain" && v.params.receipt === "delivery_question").length, 1);
  assert.equal(f.operations.some(v => v.op === "pi_observe"), false);
  assert.equal(f.manager.getBranch().find(e => e.type === "message" && e.message.role === "assistant").message.stopReason, "aborted");
});

test("a genuine provider error after claiming attention is not promoted to a successful yield", async t => {
  const f = await fixture(t), run = f.start(); await until(() => f.requests.length === 1);
  let release; f.holdClaim(new Promise(resolve => { release = resolve; }));
  await f.deliver(); f.requests[0].endBlock(); await until(() => f.operations.some(v => v.op === "pi_claim"));
  f.requests[0].fail(); release(); await run;
  assert.equal(f.requests.length, 1); assert.equal(f.tools(), 0);
  const message = f.manager.getBranch().find(e => e.type === "message" && e.message.role === "assistant").message;
  assert.equal(message.stopReason, "error"); assert.equal(message.errorMessage, "Provider failed after the claim");
  assert.equal(f.operations.filter(v => v.op === "pi_uncertain").length, 1);
  assert.equal(f.manager.getBranch().some(e => e.type === "custom_message"), false);
});

for (const failure of [false, true]) test(`an ${failure ? "unsuccessful" : "empty"} claim does not cancel generation or dispatch a false delivery`, async t => {
  const f = await fixture(t), run = f.start(); await until(() => f.requests.length === 1); await f.deliver();
  if (failure) f.failClaim(new Error("claim failed")); else f.clearPending();
  f.requests[0].endBlock(); await until(() => f.operations.some(v => v.op === "pi_claim")); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.signal.aborted, false);
  f.requests[0].finish(); await run;
  assert.equal(f.tools(), 1); assert.equal(f.manager.getBranch().some(e => e.type === "custom_message"), false);
  assert.equal(f.operations.some(v => v.op === "pi_observe" || v.op === "pi_uncertain"), false);
  assert.equal(f.notifications.filter(v => v.level === "warning").length, failure ? 1 : 0);
});

test("foreign sessions and nested request signals cannot consume the frontend mailbox", async t => {
  const f = await fixture(t), run = f.start(); await until(() => f.requests.length === 1); await f.deliver();
  for (const [sessionId, signal] of [["foreign", f.ctx().signal], [f.manager.getSessionId(), new AbortController().signal]]) {
    const count = f.requests.length;
    const result = f.models.streamSimple(f.model, { messages: [{ role: "user", content: "outside", timestamp: 1 }] }, { sessionId, signal });
    const drained = (async () => { for await (const _event of result) { /* consume the lazy stream */ } return result.result(); })();
    await until(() => f.requests.length === count + 1);
    const r = f.requests.at(-1); r.endBlock(); await tick(); await tick();
    assert.equal(r.options.signal.aborted, false); assert.equal(f.operations.filter(v => v.op === "pi_claim").length, 0);
    r.finish(); await drained;
  }
  f.requests[0].endBlock(); await run;
  assert.equal(f.tools(), 0); assert.equal(f.manager.getBranch().filter(e => e.type === "custom_message").length, 1);
});

test("sampling hook release leaves later descriptor restrictions intact", () => {
  const descriptor = Object.getOwnPropertyDescriptor(ModelRuntime.prototype, "streamSimple");
  const release = installSamplingMailbox({ sessionId: "restricted-owner", signal: () => undefined, pending: () => true, take: async () => false });
  const wrapped = ModelRuntime.prototype.streamSimple;
  try {
    Object.defineProperty(ModelRuntime.prototype, "streamSimple", { ...descriptor, value: wrapped, writable: false });
    assert.doesNotThrow(release);
    assert.equal(Object.getOwnPropertyDescriptor(ModelRuntime.prototype, "streamSimple").writable, false);
    assert.equal(ModelRuntime.prototype.streamSimple, wrapped);
  } finally {
    Object.defineProperty(ModelRuntime.prototype, "streamSimple", { ...descriptor, value: wrapped }); release();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(ModelRuntime.prototype, "streamSimple"), descriptor);
});

test("sampling hook release preserves a later owner and restores its descriptor only when owned", () => {
  const descriptor = Object.getOwnPropertyDescriptor(ModelRuntime.prototype, "streamSimple");
  const release = installSamplingMailbox({ sessionId: "ownership-test", signal: () => undefined, pending: () => true, take: async () => false });
  const wrapped = ModelRuntime.prototype.streamSimple;
  const later = function (...args) { return wrapped.apply(this, args); };
  try {
    Object.defineProperty(ModelRuntime.prototype, "streamSimple", { ...descriptor, value: later });
    release(); assert.equal(ModelRuntime.prototype.streamSimple, later);
  } finally {
    Object.defineProperty(ModelRuntime.prototype, "streamSimple", { ...descriptor, value: wrapped }); release();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(ModelRuntime.prototype, "streamSimple"), descriptor);
});
