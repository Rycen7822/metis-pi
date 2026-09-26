// Session contracts own activation, installed UI slots and teardown.
// Host data uses Pi's actual model/context/usage shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { activate } from "../../src/extension.ts";
import { GIT_CHANGES_INTERVAL_MS } from "../../src/git-changes.ts";
import { theme, toolInfo } from "../helpers.mjs";
import { isolatedToolHost } from "../helpers/native-tool.mjs";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark", false);

// One session-shaped entry proves reconstruction reaches the footer; ledger math lives in core.
function historyEntries() {
  return [{
    type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant", api: "openai-completions", provider: "test-provider", model: "test-model",
      responseId: "r1", stopReason: "stop", timestamp: 1,
      usage: { input: 4000, output: 200, cacheRead: 1000, cacheWrite: 0, totalTokens: 4200,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  }];
}

/** Drive the REAL activation with a fake pi, capturing every UI slot call. */
function activateHarness(t, bindingsExtra = {}) {
  const Host = isolatedToolHost();
  const original = Object.getOwnPropertyDescriptors(Host.prototype);
  const handlers = new Map();
  const pi = new Proxy({
    on: (event, handler) => handlers.set(event, handler),
    getAllTools: () => [toolInfo("read")],
  }, { get(target, key) {
    if (!(key in target)) throw new Error(`Forbidden appearance API: ${String(key)}`);
    return target[key];
  } });
  const slots = {
    editorFactories: [],
    footerFactories: [],
    headerFactories: [],
    widgetCalls: [],
    workingVisible: [],
    workingMessages: [],
    statuses: new Map(),
    notifications: [],
  };
  const bindings = {
    prototype: Host.prototype,
    makeText: (s) => ({ render: () => [s] }),
    expandHint: () => "expand",
    getAgentDir: () => undefined,
    ...bindingsExtra,
  };
  const { whenReady } = activate(pi, bindings);
  t.after(() => {
    handlers.get("session_shutdown")();
    assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), original, "session releases its native prototype");
  });
  const context = (overrides = {}) => ({
    mode: "tui", hasUI: true, cwd: "/tmp/workspace",
    ...overrides,
    ui: {
      notify: (text, level) => slots.notifications.push({ text, level }),
      setEditorComponent: (factory) => slots.editorFactories.push(factory),
      getEditorComponent: () => slots.editorFactories.at(-1),
      setFooter: (factory) => slots.footerFactories.push(factory),
      setHeader: (factory) => slots.headerFactories.push(factory),
      setWidget: (key, content, options) => slots.widgetCalls.push({ key, content, options }),
      setWorkingVisible: (visible) => slots.workingVisible.push(visible),
      setWorkingMessage: (m) => slots.workingMessages.push(m),
      setStatus: (key, text) => slots.statuses.set(key, text),
      ...overrides.ui,
    },
  });
  const footer = (data = {}) => slots.footerFactories.at(-1)({ requestRender() {} }, theme, {
    getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
    ...data,
  });
  return { handlers, slots, context, footer, whenReady, Host, original };
}

async function session(t, bindings = {}, overrides = {}) {
  const h = activateHarness(t, bindings);
  const ctx = h.context(overrides);
  h.handlers.get("session_start")({}, ctx);
  await h.whenReady();
  return { ...h, ctx };
}

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const widgetByKey = (slots, key) =>
  slots.widgetCalls.filter((c) => c.key === key && c.content !== undefined).at(-1);

test("one footer keeps ordered host metadata fresh across frames, events and session replacement", async (t) => {
  let reads = 0;
  let leaf = "first";
  let usage = { tokens: 172_000, contextWindow: 1_000_000, percent: 17.2 };
  const { handlers, slots, footer: makeFooter, ctx } = await session(t, {}, {
    model: { id: "test-model", provider: "openai-codex", contextWindow: 1_000_000 }, thinkingLevel: "high",
    sessionManager: { getEntries: historyEntries, getLeafId: () => leaf },
    getContextUsage() { reads += 1; return usage; },
  });
  assert.equal(widgetByKey(slots, "metis-pi:composer-meta"), undefined, "metadata belongs below the editor");
  const footer = makeFooter({ getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([["codex-adapter", "Codex adapter V: low · weekly: 20% left"]]) });
  const frame = () => plain(footer.render(140).join("\n"));
  const initial = frame();
  const fields = ["test-model", "high", "openai-codex", "/tmp/workspace (main)", "ctx 172k/1.0M · 17.2%", "↑4.0k ↓200", "cache 20%"];
  for (const field of fields) assert.ok(initial.includes(field), `${field} reaches the installed footer`);
  assert.match(initial, /Codex adapter V: low · weekly: 20% left/, "vendor status remains");
  for (let i = 0; i < 64; i += 1) frame();
  assert.equal(reads, 1, "animation frames share one context projection");

  ctx.model = { id: "switched-model", provider: "other-provider", contextWindow: 2_000_000 };
  usage = { tokens: 172_000, contextWindow: 2_000_000, percent: 8.6 };
  handlers.get("model_select")({ type: "model_select" });
  const switched = frame();
  assert.match(switched, /switched-model/);
  assert.match(switched, /other-provider/);
  assert.match(switched, /2\.0M/);
  assert.match(switched, /8\.6%/, "same revision cannot mix old and new context windows");
  assert.doesNotMatch(switched, /test-model|17\.2%/);

  usage = { tokens: 10, contextWindow: 100, percent: 10 };
  for (const event of ["message_start", "message_update", "message_end", "agent_end", "agent_settled",
    "model_select", "thinking_level_select", "session_tree", "session_compact", "session_compact_failed"]) {
    usage = { ...usage, tokens: usage.tokens + 1, percent: usage.percent + 1 };
    handlers.get(event)({ type: event });
    assert.match(frame(), new RegExp(`ctx ${usage.tokens}/100 · ${usage.percent}%`), event);
    const refreshed = reads;
    frame();
    assert.equal(reads, refreshed, `${event}: unchanged renders reuse its sample`);
  }
  // Pi persists message_end after callbacks; a later leaf must refresh without a timer.
  usage = { tokens: 30, contextWindow: 100, percent: 30 };
  leaf = "appended-after-message-end";
  assert.match(frame(), /ctx 30\/100 · 30%/);
  usage = { tokens: null, contextWindow: 100, percent: null };
  handlers.get("session_compact")({ type: "session_compact" });
  assert.match(frame(), /ctx —\/100/);

  usage = { tokens: 40, contextWindow: 100, percent: 40 };
  handlers.get("session_start")({ reason: "resume" }, ctx);
  assert.match(frame(), /ctx 40\/100 · 40%/, "session replacement clears the cache");
});

test("hidden footer metadata never requests a context projection", async (t) => {
  let reads = 0;
  const { footer } = await session(t, {
    getAgentDir: () => "/unused",
    readFile: () => JSON.stringify({ composer: { metadata: false } }),
  }, { getContextUsage() { reads += 1; } });
  footer().render(140);
  assert.equal(reads, 0);
});

test("footer readiness and polling follow the current session generation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const schedule = t.mock.method(globalThis, "setInterval");
  const cancel = t.mock.method(globalThis, "clearInterval");
  const polls = () => schedule.mock.calls.filter(({ arguments: args }) => args[1] === GIT_CHANGES_INTERVAL_MS);
  const active = () => polls().filter(({ result }) =>
    !cancel.mock.calls.some(({ arguments: [timer] }) => timer === result)).length;
  const { handlers, context, whenReady } = activateHarness(t);
  const installed = [];
  const namedContext = (name) => context({ ui: {
    setWorkingVisible: undefined,
    setFooter: (factory) => installed.push([name, factory === undefined ? "removed" : "installed"]),
  } });
  handlers.get("session_start")({}, namedContext("superseded"));
  const first = whenReady();
  handlers.get("session_start")({}, namedContext("current"));
  const second = whenReady();
  assert.notEqual(first, second, "each session exposes its own completion");
  await Promise.all([first, second]);
  assert.deepEqual(installed, [["current", "installed"]], "superseded installs cannot write to any UI");
  assert.equal(polls().length, 1, "only the current successful footer starts polling");
  assert.equal(active(), 1);

  for (const scenario of [
    { name: "footer capability removed", ui: { setFooter: undefined } },
    { name: "footer restored", polling: true },
    { name: "footer install failed", ui: { setFooter() { throw new Error("unsupported"); } } },
    { name: "footer restored after failure", polling: true },
    { name: "non-TUI", mode: "rpc" },
    { name: "TUI restored", polling: true },
    { name: "no displayed cwd", cwd: "" },
    { name: "shutdown before async install", earlyShutdown: true },
  ]) {
    const before = polls().length;
    handlers.get("session_start")({}, context({
      mode: scenario.mode ?? "tui", cwd: scenario.cwd ?? "/tmp/workspace", ui: scenario.ui ?? {},
    }));
    if (scenario.earlyShutdown) handlers.get("session_shutdown")();
    await whenReady();
    assert.equal(polls().length - before, scenario.polling ? 1 : 0, scenario.name);
    assert.equal(active(), scenario.polling ? 1 : 0, `${scenario.name}: prior session releases its poller`);
  }
  assert.deepEqual(installed, [["current", "installed"], ["current", "removed"]],
    "the previous UI is restored exactly once before switching context");
  handlers.get("session_shutdown")();
  assert.equal(active(), 0, "shutdown remains idempotent after a cancelled install");
});

test("static configuration gates Git polling before a footer can start it", async (t) => {
  const schedule = t.mock.method(globalThis, "setInterval");
  for (const config of [
    { footer: { showChanges: false } },
    { footer: { enabled: false } },
    { enabled: false },
  ]) {
    await session(t, { getAgentDir: () => "/unused", readFile: () => JSON.stringify(config) });
    assert.equal(schedule.mock.calls.filter(({ arguments: args }) => args[1] === GIT_CHANGES_INTERVAL_MS).length, 0,
      `no poller for ${JSON.stringify(config)}`);
  }
});

test("one interaction wires live/final usage, Working and the persisted summary", async (t) => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  t.mock.method(Date, "now", () => 1_700_000_000_000 + now - 1_000);
  const appended = [];
  const registered = [];
  const { handlers, slots, footer: makeFooter } = await session(t, {
    api: {
      appendEntry: (type, data) => appended.push({ type, data }),
      registerEntryRenderer: (type, renderer) => registered.push({ type, renderer }),
      registerCommand() {},
    },
  }, { sessionManager: { getEntries: () => [] } });
  assert.deepEqual(registered.map(({ type }) => type), ["metis-pi:interaction-summary:v1"]);
  const footer = makeFooter();
  const frame = () => plain(footer.render(140).join("\n"));
  const speed = (text) => Number(text.match(/([\d.]+) tok\/s/)?.[1]);
  const message = (id, usage) => ({ role: "assistant", content: [], stopReason: "stop", responseId: id, provider: "test-provider", timestamp: 1, usage });
  const update = (id, usage, delta) => handlers.get("message_update")({
    message: message(id, usage),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { content: [] } },
  });

  assert.equal(slots.workingVisible.at(-1), false, "native loader hidden after widget install");
  handlers.get("agent_start")({}, {});
  const working = widgetByKey(slots, "metis-pi:working");
  assert.ok(working, "Working widget registered for the interaction");
  assert.deepEqual(working.options, { placement: "aboveEditor" });
  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  assert.doesNotMatch(frame(), /tok\/s/, "no rate before a measurable response");
  handlers.get("tool_execution_start")({ toolCallId: "t1", toolName: "bash", args: {} }, { cwd: "/tmp" });
  const active = plain(working.content({ requestRender() {} }, theme).render(100).join("\n"));
  assert.match(active, /• Working \(\d+s · esc to interrupt\) · bash$/, "tool event reaches the above-editor widget");
  handlers.get("tool_execution_end")({ toolCallId: "t1", toolName: "bash", result: {}, isError: true });

  update("first", { input: 800, output: 10, cacheRead: 100, cacheWrite: 0 }, "first delta");
  now += 400;
  update("first", { input: 900, output: 40, cacheRead: 200, cacheWrite: 0 }, "second delta");
  assert.equal(speed(frame()), 100, "live cumulative output reaches the footer");
  const confirmed = message("first", { input: 100, output: 80, cacheRead: 900, cacheWrite: 0 });
  handlers.get("message_end")({ message: confirmed });
  handlers.get("message_end")({ message: confirmed });
  const final = frame();
  assert.match(final, /↑100 ↓80(?:\s|$)/, "one confirmed record replaces both previews and survives duplicate completion");
  assert.match(final, /cache 90%/, "final cache usage replaces the streaming preview");
  assert.equal(speed(final), 200, "80 confirmed tokens over 400ms replaces the live sample");
  assert.ok(final.indexOf("tok/s") > final.indexOf("↑"), "rate follows input/output");

  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  update("second", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "next response");
  now += 400;
  update("second", { input: 0, output: 40, cacheRead: 0, cacheWrite: 0 }, "next delta");
  assert.equal(speed(frame()), 100, "message_start resets the measured window");
  handlers.get("message_end")({ message: message("second", { input: 0, output: 44, cacheRead: 0, cacheWrite: 0 }) });
  handlers.get("agent_settled")({}, {});
  handlers.get("agent_settled")({}, {});
  assert.equal(speed(frame()), 110, "the final rate remains visible after settle");
  assert.equal(appended.length, 1, "duplicate settled events append one summary");
  assert.equal(appended[0].type, "metis-pi:interaction-summary:v1");
  const { data } = appended[0];
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.evidence, "assistant-stop");
  assert.equal(data.startedAt, 1_700_000_000_000);
  assert.equal(data.settledAt, 1_700_000_000_800);
  assert.equal(data.elapsedMs, 800);
  assert.match(registered[0].renderer({ customType: appended[0].type, data }).render(140).join("\n"), /Worked for 0s/);
  assert.equal(data.outcome, "completed");
  assert.equal(appended[0].data.toolErrorsObserved, 1, "tool errors stay diagnostic");
  assert.equal(slots.widgetCalls.at(-1).content, undefined);
  assert.equal(slots.statuses.get("metis-pi:summary"), undefined, "persisted summary stays in CustomEntry");
});

for (const [name, config, context] of [
  ["disabled", { enabled: false }, {}],
  ["noninteractive", {}, { hasUI: false, mode: undefined }],
]) {
  test(`${name} activation leaves native tools, chrome and summaries untouched`, async (t) => {
    const appended = [];
    const { handlers, slots, Host, original } = await session(t, {
      getAgentDir: () => "/unused", readFile: () => JSON.stringify(config),
      api: { appendEntry: (...args) => appended.push(args) },
    }, context);
    const definition = { renderCall: () => ({ render: () => ["native call"] }), renderResult: () => ({ render: () => ["native result"] }) };
    const row = new Host("read", definition);
    assert.equal(row.getCallRenderer(), definition.renderCall);
    assert.equal(row.getResultRenderer(), definition.renderResult);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), original);
    handlers.get("agent_start")({}, {});
    handlers.get("message_start")({ message: { role: "assistant", content: [] } });
    handlers.get("message_end")({ message: {
      role: "assistant", content: [], stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    } });
    handlers.get("agent_settled")({}, {});
    for (const key of ["editorFactories", "footerFactories", "headerFactories", "widgetCalls", "workingVisible", "workingMessages"]) {
      assert.deepEqual(slots[key], [], `${key} remains untouched`);
    }
    assert.equal(slots.statuses.has("metis-pi:summary"), false);
    assert.deepEqual(appended, []);
  });
}
