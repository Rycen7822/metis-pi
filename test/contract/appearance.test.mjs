import test from "node:test";
import assert from "node:assert/strict";
import { activate } from "../../src/extension.ts";
import { GIT_CHANGES_INTERVAL_MS } from "../../src/git-changes.ts";
import { theme, toolInfo } from "../helpers.mjs";
import { isolatedToolHost } from "../helpers/native-tool.mjs";
import { altScreen, container, screenLines } from "../helpers/ui-fixtures.mjs";
import * as Tui from "@earendil-works/pi-tui";
import { AssistantMessageComponent, CustomEditor, initTheme, SessionManager, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, Spacer, Text, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { ThinkingRailComponent } from "../../src/chrome/transcript-components.ts";
import { stringify } from "smol-toml";
import { Agent } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
const appearanceFile = config => path => path.endsWith("metis-pi.toml") ? stringify({ appearance: config }) : undefined;
// SDK producers enqueue independently of the extension/UI callback clock.
const producers = new WeakMap();
function providerEvent(handlers, message, type, delta = "") {
  let streams = producers.get(handlers);
  if (!streams) producers.set(handlers, streams = new Map());
  if (type === "response.created") {
    const partial = { ...message, content: [] };
    const stream = new AssistantMessageEventStream();
    streams.set(message.responseId, { stream, partial, argumentsJson: "" });
    stream.push({ type: "start", partial });
  } else {
    const producer = streams.get(message.responseId);
    const { stream, partial } = producer;
    const tool = type === "response.function_call_arguments.delta";
    if (!partial.content.length) {
      const original = message.content.find(block => block.type === "toolCall");
      partial.content.push(tool ? { type: "toolCall", id: original?.id ?? "t1", name: original?.name ?? "bash", arguments: {} }
        : { type: "text", text: "" });
      if (tool) stream.push({ type: "toolcall_start", contentIndex: 0, partial });
    }
    if (tool) {
      producer.argumentsJson += delta;
      try { partial.content[0].arguments = JSON.parse(producer.argumentsJson); } catch { /* Partial JSON. */ }
    } else partial.content[0].text += delta;
    stream.push({ type: tool ? "toolcall_delta" : "text_delta", contentIndex: 0, delta, partial });
  }
}
function finishResponse(handlers, message, ctx) {
  const producer = producers.get(handlers)?.get(message.responseId);
  if (producer) {
    if (!message.content.length) message.content = producer.partial.content;
    producer.stream.push({ type: "done", reason: message.stopReason, message });
    producer.stream.end();
  }
  handlers.get("message_end")({ message }, ctx);
}

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

test("captured fullscreen chrome paints sticky prompts with the current public UI theme", async t => {
  const promptColors = [];
  const currentTheme = {
    fg(key, row) { promptColors.push(key); return row; },
    bg(key, row) { promptColors.push(key); return row; },
  };
  const { slots, ctx } = await session(t, {
    fullscreenHost: { ...Tui, UserMessageComponent,
      promptRow: (summary, width) => Tui.truncateToWidth(`↑ ${summary}`, width) },
  }, { ui: { theme: currentTheme } });
  const { tui } = altScreen(60);
  const source = container(new UserMessageComponent("CAPTURED_PROMPT"),
    new Text(Array.from({ length: 100 }, (_, i) => `REPLY_${i}`).join("\n"), 0, 0));
  tui.setLayoutRoot(new Tui.ScrollView(source, { primary: true, follow: "end" }));
  slots.footerFactories.at(-1)(tui, theme, {
    getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
  });
  tui.doRender();
  assert.match(screenLines(tui)[0], /↑ CAPTURED_PROMPT/);
  assert.ok(promptColors.includes("userMessageText"));
  assert.ok(promptColors.includes("userMessageBg"));
  let changed = false;
  ctx.ui.theme = { ...currentTheme, bg: (_key, row) => { changed = true; return row; } };
  tui.doRender();
  assert.equal(changed, true, "theme access is live, not a startup snapshot");
});

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const widgetByKey = (slots, key) =>
  slots.widgetCalls.filter((c) => c.key === key && c.content !== undefined).at(-1);

for (const rail of [false, true]) {
  test(`rail setting ${rail} reaches the native assistant and diagnostics`, async t => {
    class Assistant extends AssistantMessageComponent {
      updateContent(message, isStreaming = this.isStreaming) { super.updateContent(message, isStreaming); }
    }
    let rails = 0;
    const commands = new Map();
    const { handlers, slots } = await session(t, {
      getAgentDir: () => "/unused",
      readFile: appearanceFile({ thinking: { rail, streaming: "full", completed: "full" } }),
      assistantPrototype: Assistant.prototype,
      makeSeparator: () => new Text("separator", 0, 0),
      makeSpacer: () => new Spacer(1),
      makeRail: child => { rails++; return new ThinkingRailComponent(child, { kind: "none" }); },
      api: { registerCommand: (name, command) => commands.set(name, command) },
    });
    handlers.get("agent_start")();
    const message = { role: "assistant", content: [{ type: "thinking", thinking: "RAIL_BODY" }] };
    handlers.get("message_start")({ message });
    handlers.get("message_update")({ message });
    const assistant = new Assistant();
    assistant.updateContent(message, true);
    assert.match(plain(assistant.render(80).join("\n")), /RAIL_BODY/, "the native body is shown in both configurations");
    assert.equal(rails, rail ? 1 : 0, "disabled rail must not construct a wrapper");
    const report = [];
    commands.get("codex-ui").handler("", { ui: { notify: text => report.push(text) } });
    assert.match(report.join("\n"), rail ? /thinking-rail=applied/ : /thinking-rail=disabled\(config\)/);
    assert.doesNotMatch(slots.notifications.map(n => n.text).join("\n"), /decorations partially unavailable/,
      "intentional disable is not an installation failure");
  });
}

for (const enabled of [false, true]) {
  test(`settled verdict survives with summary enabled=${enabled} until the next interaction`, async t => {
    let now = 1_000;
    t.mock.method(performance, "now", () => now);
    t.mock.method(Date, "now", () => 1_700_000_000_000 + now);
    const commands = new Map(), appended = [];
    const { handlers } = await session(t, {
      getAgentDir: () => "/unused", readFile: appearanceFile({ summary: { enabled } }),
      api: {
        appendEntry: (type, data) => appended.push({ type, data }),
        registerCommand: (name, command) => commands.set(name, command),
      },
    });
    const diagnostic = () => {
      const report = [];
      commands.get("codex-ui").handler("", { ui: { notify: text => report.push(text) } });
      return report.join("\n");
    };
    handlers.get("agent_start")();
    const message = { role: "assistant", content: [], stopReason: "error" };
    handlers.get("message_start")({ message });
    handlers.get("tool_execution_end")({ toolCallId: "failed-tool", toolName: "bash", result: {}, isError: true });
    now += 2_000;
    handlers.get("message_end")({ message });
    handlers.get("agent_settled")();
    handlers.get("agent_settled")();
    assert.match(diagnostic(), /outcome: failed \(evidence=assistant-error, attempt=1, toolErrors=1\)/);
    assert.equal(appended.length, enabled ? 1 : 0, "the summary toggle controls delivery, not verdict finalization");
    now += 1_000;
    handlers.get("agent_start")();
    assert.match(diagnostic(), /outcome: pending \(attempts=0, toolErrors=0\)/, "a new interaction clears the prior verdict");
  });
}

for (const acceptance of ["before", "after", "unavailable"]) {
  test(`summary append ${acceptance} acceptance falls back without another append`, async t => {
    let now = 1_000;
    t.mock.method(performance, "now", () => now);
    t.mock.method(Date, "now", () => 1_700_000_000_000 + now);
    const manager = SessionManager.inMemory();
    let attempts = 0;
    const appendEntry = acceptance === "unavailable" ? undefined : (type, data) => {
      attempts++;
      if (acceptance === "after") manager.appendCustomEntry(type, data);
      throw new Error("synthetic persistence failure");
    };
    const { handlers, slots } = await session(t, { api: { appendEntry } }, { sessionManager: manager });
    handlers.get("agent_start")();
    const message = { role: "assistant", content: [], stopReason: "stop" };
    handlers.get("message_start")({ message });
    now += 2_000;
    handlers.get("message_end")({ message });
    handlers.get("agent_settled")();
    handlers.get("agent_settled")();
    const fallback = slots.statuses.get("metis-pi:summary");
    assert.match(fallback, /Worked for 2s/, "a failed append still delivers a visible summary");
    assert.match(fallback, acceptance === "unavailable" ? /summary not saved/ : /summary save unconfirmed/);
    assert.equal(attempts, acceptance === "unavailable" ? 0 : 1, "uncertain delivery must not cause a blind reappend");
    const entries = manager.getEntries().filter(entry => entry.type === "custom");
    assert.equal(entries.length, acceptance === "after" ? 1 : 0);
    if (entries.length) assert.equal(entries[0].data.outcome, "completed", "accepted in-memory data is preserved");
    now += 1_000;
    handlers.get("agent_start")();
    assert.equal(slots.statuses.get("metis-pi:summary"), undefined, "transient display ends at the next interaction");
  });
}

test("appearance installs the public native-status editor path for compaction timing", async t => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const { slots } = await session(t, { editorHost: { CustomEditor } });
  const { tui } = altScreen();
  const editor = slots.editorFactories.at(-1)(tui, { ...theme, borderColor: text => text }, new KeybindingsManager(TUI_KEYBINDINGS));
  assert.equal(editor.embedWorkingStatus, true, "production install opts into native status delivery");
  editor.setWorkingStatusIndicator({ kind: "compaction", renderInBorder: () => "Compacting context... (escape to cancel)" });
  now += 12_000;
  assert.match(plain(editor.render(100)[0]), /Compacting context.*cancel.* · 12s/);
  editor.setWorkingStatusIndicator(undefined);
  await Promise.resolve();
  assert.doesNotMatch(plain(editor.render(100)[0]), /Compacting context| · 12s/);
});

test("nested tool activity does not leak image notices into top-level exploration", async (t) => {
  const { handlers, Host, ctx } = await session(t);
  const outer = { toolCallId: "native-test", toolName: "read", args: { path: "/tmp/outer" } };
  const nested = { toolCallId: "nested-read", parentToolCallId: "codemode-parent", toolName: "read", args: {} };
  handlers.get("tool_execution_start")(nested, ctx);
  handlers.get("tool_execution_end")({ ...nested, result: { content: [{ type: "image", data: "", mimeType: "image/png" }] }, isError: false }, ctx);
  handlers.get("tool_execution_start")(outer, ctx);
  handlers.get("tool_execution_end")({ ...outer, result: { content: [] }, isError: false }, ctx);
  const row = new Host("read", { name: "read" }, outer.args);
  row.updateResult({ content: [{ type: "text", text: "outer text" }] }, false);
  const frame = plain(row.render(80).join("\n"));
  assert.match(frame, /Explored/);
  assert.doesNotMatch(frame, /image/);
});

test("one footer keeps ordered host metadata fresh across frames, events and session replacement", async (t) => {
  let reads = 0;
  let leaf = "first";
  let usage = { tokens: 172_000, contextWindow: 1_000_000, percent: 17.2 };
  const { handlers, slots, footer: makeFooter, ctx } = await session(t, {}, {
    model: { id: "test-model", provider: "openai-codex", contextWindow: 1_000_000 }, thinkingLevel: "high",
    sessionManager: { getEntries: historyEntries, getSessionId: () => "footer-session", getLeafId: () => leaf },
    getContextUsage() { reads += 1; return usage; },
  });
  assert.equal(widgetByKey(slots, "metis-pi:composer-meta"), undefined, "metadata belongs below the editor");
  const footer = makeFooter({ getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([["codex-adapter", "Codex adapter V: low · weekly: 20% left"],
      ["context-prune", "│ prune: ON · usage: 0 tokens\n7 turns queued"]]) });
  const frame = () => plain(footer.render(140).join("\n"));
  const initial = frame();
  const fields = ["test-model", "high", "openai-codex", "ctx 172k/1.0M · 17.2%", "↑4.0k ↓200", "cache 20%"];
  for (const field of fields) assert.ok(initial.includes(field), `${field} reaches the installed footer`);
  assert.doesNotMatch(initial, /\/tmp\/workspace|turns queued/, "secondary details start folded");
  assert.match(frame(), /Codex adapter V: low · weekly: 20% left/, "vendor status remains");
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

  const streaming = { role: "assistant", content: [{ type: "text", text: "partial response" }] };
  handlers.get("message_update")({ message: streaming,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial response", partial: streaming } });
  assert.match(frame(), /ctx 172k\/2\.0M · 8\.6%/, "streaming has not changed the persisted context source");
  assert.equal(reads, 2, "streaming updates reuse the unchanged persisted sample");

  usage = { tokens: 10, contextWindow: 100, percent: 10 };
  for (const event of ["message_start", "message_end", "agent_end", "agent_settled",
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

test("TOML independently controls initial location and prune disclosure through activation", async t => {
  for (const [locationExpanded, pruneExpanded] of [[true, false], [false, true], [true, true]]) {
    await t.test(`${locationExpanded}/${pruneExpanded}`, async t => {
      const { footer } = await session(t, {
        getAgentDir: () => "/unused",
        readFile: appearanceFile({ footer: { locationExpanded, pruneExpanded } }),
      });
      const component = footer({ getGitBranch: () => "main",
        getExtensionStatuses: () => new Map([["context-prune", "│ prune: ON · usage: 0 tokens\n7 turns queued"]]) });
      t.after(() => component.dispose());
      const frame = plain(component.render(140).join("\n"));
      assert.equal(frame.includes("/tmp/workspace (main)"), locationExpanded);
      assert.equal(frame.includes("7 turns queued"), pruneExpanded);
    });
  }
});

test("hidden footer metadata never requests a context projection", async (t) => {
  let reads = 0;
  const { footer } = await session(t, {
    getAgentDir: () => "/unused",
    readFile: appearanceFile({ composer: { metadata: false } }),
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
    await session(t, { getAgentDir: () => "/unused", readFile: appearanceFile(config) });
    assert.equal(schedule.mock.calls.filter(({ arguments: args }) => args[1] === GIT_CHANGES_INTERVAL_MS).length, 0,
      `no poller for ${JSON.stringify(config)}`);
  }
});

test("one interaction wires usage previews, generation rates, Working and the persisted summary", async (t) => {
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
  const message = (id, usage, durationMs) => ({
    role: "assistant",
    content: [],
    stopReason: "stop",
    responseId: id,
    provider: "test-provider", api: "openai-responses", model: "m",
    timestamp: 1,
    usage: { reasoning: 0, ...usage }, durationMs,
  });
  const update = (id, usage, delta) => {
    const m = message(id, usage);
    providerEvent(handlers, m, id === "first" ? "response.function_call_arguments.delta" : "response.output_text.delta", delta);
    handlers.get("message_update")({ message: m,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { content: [] } } });
  };

  assert.equal(slots.workingVisible.at(-1), false, "native loader hidden after widget install");
  handlers.get("agent_start")({}, {});
  const working = widgetByKey(slots, "metis-pi:working");
  assert.ok(working, "Working widget registered for the interaction");
  assert.deepEqual(working.options, { placement: "aboveEditor" });
  handlers.get("turn_start")({});
  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  assert.doesNotMatch(frame(), /tok\/s/, "no rate before a completed response");
  providerEvent(handlers, message("first"), "response.created");
  now += 3000; // initial waiting/reasoning must not dilute generation speed
  update("first", { input: 800, output: 10, cacheRead: 100, cacheWrite: 0 }, '{"command":');
  now += 400;
  update("first", { input: 900, output: 40, cacheRead: 200, cacheWrite: 0 }, '"echo ready"}');
  assert.doesNotMatch(frame(), /tok\/s/, "partial cumulative usage is not a live speed measurement");
  const confirmed = { ...message("first", { input: 100, output: 80, cacheRead: 900, cacheWrite: 0, reasoning: 60 }, 3400),
    stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo ready" } }] };
  finishResponse(handlers, confirmed);
  finishResponse(handlers, confirmed);
  const final = frame();
  assert.match(final, /↑100 ↓80(?:\s|$)/, "one confirmed record replaces both previews and survives duplicate completion");
  assert.match(final, /cache 90%/, "final cache usage replaces the streaming preview");
  assert.equal(speed(final), 47.5, "the tool response updates speed before tool execution or interaction completion");
  handlers.get("tool_execution_start")({ toolCallId: "t1", toolName: "bash", args: {} }, { cwd: "/tmp" });
  const active = plain(working.content({ requestRender() {} }, theme).render(100).join("\n"));
  assert.match(active, /• Working \(\d+s · esc to interrupt\) · bash$/, "tool event reaches the above-editor widget");
  handlers.get("tool_execution_end")({ toolCallId: "t1", toolName: "bash", result: {}, isError: true });
  const toolResult = { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: true, timestamp: Date.now() };
  handlers.get("message_start")({ message: toolResult }); handlers.get("message_end")({ message: toolResult });

  handlers.get("turn_start")({});
  const failed = { ...message("connection-error", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    stopReason: "error", errorMessage: "Connection error." };
  handlers.get("message_start")({ message: failed });
  handlers.get("message_end")({ message: failed });
  handlers.get("agent_end")({});
  assert.equal(speed(frame()), 47.5, "connection failure retains the previous tool response rate");
  handlers.get("agent_start")({}); handlers.get("turn_start")({});
  assert.equal(speed(frame()), 47.5, "retry does not erase the previous valid sample");
  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  providerEvent(handlers, message("second"), "response.created");
  update("second", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "next response");
  now += 400;
  update("second", { input: 0, output: 40, cacheRead: 0, cacheWrite: 0 }, "next delta");
  assert.equal(speed(frame()), 47.5, "incomplete usage retains the previous sample, without inventing a live estimate");
  finishResponse(handlers, message("second", { input: 0, output: 44, cacheRead: 0, cacheWrite: 0 }, 400));
  now += 2_000; // background maintenance finishes after the final reply
  handlers.get("agent_settled")({}, {});
  handlers.get("agent_settled")({}, {});
  assert.equal(speed(frame()), 77.5, "(19 + 43) / (0.4 + 0.4) stays visible after settle");
  assert.match(frame(), /gen\(avg2\)/);
  assert.equal(appended.length, 1, "duplicate settled events append one summary");
  assert.equal(appended[0].type, "metis-pi:interaction-summary:v1");
  const { data } = appended[0];
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.evidence, "assistant-stop");
  assert.equal(data.startedAt, 1_700_000_000_000);
  assert.equal(data.replyEndedAt, 1_700_000_003_800);
  assert.equal(data.settledAt, 1_700_000_005_800);
  assert.equal(data.elapsedMs, 5800);
  assert.match(registered[0].renderer({ customType: appended[0].type, data }).render(140).join("\n"), /Worked for 5s/);
  assert.match(registered[0].renderer({ customType: appended[0].type, data }).render(140).join("\n"), /\n2023-11-15 06:13:23$/);
  assert.equal(data.outcome, "completed");
  assert.equal(appended[0].data.toolErrorsObserved, 1, "tool errors stay diagnostic");
  assert.equal(slots.widgetCalls.at(-1).content, undefined);
  assert.equal(slots.statuses.get("metis-pi:summary"), undefined, "persisted summary stays in CustomEntry");
  handlers.get("agent_start")({}, {});
  assert.equal(speed(frame()), 77.5, "a new interaction retains the completed generation rate");
  handlers.get("turn_start")({});
  assert.equal(speed(frame()), 77.5, "the first request of a new interaction retains it too");
  const next = message("third", { input: 0, output: 20, cacheRead: 0, cacheWrite: 0 }, 1000);
  handlers.get("message_start")({ message: next });
  providerEvent(handlers, next, "response.created");
  update("third", { output: 0 }, "a"); now += 400;
  update("third", { output: 20 }, "b");
  finishResponse(handlers, next);
  handlers.get("agent_end")({}, {});
  handlers.get("agent_settled")({}, {});
  assert.equal(speed(frame()), 67.5, "(19 + 43 + 19) / (0.4 + 0.4 + 0.4) smooths the short response without counting errors");
  assert.match(frame(), /gen\(avg3\)/, "the weighted history is disclosed rather than called the last raw rate");
});

test("SDK producer timing survives queued deltas and pre-request compaction", async t => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const { handlers, footer: makeFooter, ctx } = await session(t, { readFile: appearanceFile({ summary: { enabled: false } }) });
  const footer = makeFooter();
  const frame = () => plain(footer.render(140).join("\n"));
  const model = { id: "offline", name: "offline", provider: "openai", api: "openai-responses", baseUrl: "https://invalid.invalid",
    input: ["text"], reasoning: true, contextWindow: 100000, maxTokens: 10000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let stream, output;
  const agent = new Agent({ initialState: { model, tools: [] }, streamFn() {
    stream = new AssistantMessageEventStream();
    output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, responseId: "producer", timestamp: Date.now(),
      content: [], stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: output });
    return stream;
  } });
  // SDK virtual routing can compact inside prepareRequest, AFTER turn_start.
  agent.prepareRequest = () => {
    handlers.get("session_compact")({ type: "session_compact", fromExtension: false, compactionEntry: {
      type: "compaction", id: "compact", parentId: null, timestamp: new Date().toISOString(),
      firstKeptEntryId: "compact", summary: "prepared context", tokensBefore: 100000,
    } }, ctx);
  };
  const receivedCounts = [];
  // The producer can complete while an earlier async consumer holds start delivery.
  agent.subscribe(async event => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      now = 11000;
      output.content.push({ type: "thinking", thinking: "", thinkingSignature: "opaque" }, { type: "text", text: "first" });
      stream.push({ type: "text_delta", contentIndex: 1, delta: "first", partial: output });
      now = 11500;
      output.content[1].text += "last";
      stream.push({ type: "text_delta", contentIndex: 1, delta: "last", partial: output });
      output.usage = { ...output.usage, output: 1050, reasoning: 1000, totalTokens: 1050 };
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output }); stream.end();
      now = 18000;
    } else if (event.type === "message_update") now += 800;
    else if (event.type === "message_end" && event.message.role === "assistant") now += 5000;
  });
  agent.subscribe(event => {
    handlers.get(event.type)?.(event, ctx);
    if (event.type === "message_update") {
      receivedCounts.push(event.message.usage.output);
      assert.doesNotMatch(frame(), /tok\/s/, "shared future usage does not become a live rate");
    }
  });
  await agent.prompt("offline timing fixture");
  handlers.get("agent_settled")({}, ctx);
  assert.deepEqual(receivedCounts, [1050, 1050], "fixture reaches the shared-partial queue hazard");
  assert.equal(output.durationMs, 10500, "native producer clock excludes the later consumer delays");
  assert.match(frame(), /gen\(last\) 98 tok\/s/, "(1050−1000−1)/0.5 uses producer times, not TTFT or queued callbacks");
});

test("tool-model usage cannot alter main-model totals, cache or persisted summaries before or after reconstruction", async t => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const entries = [], appended = [];
  const { handlers, footer: makeFooter, ctx } = await session(t, { api: {
    appendEntry: (type, data) => appended.push({ type, data }), registerEntryRenderer() {}, registerCommand() {},
  } }, { sessionManager: { getEntries: () => entries } });
  const footer = makeFooter();
  const frame = () => plain(footer.render(140).join("\n"));
  const usage = (input, output, cacheRead) => ({ input, output, cacheRead, cacheWrite: 0, reasoning: 0 });
  const first = { role: "assistant", provider: "p", api: "openai-responses", model: "m", responseId: "a", timestamp: 1000, stopReason: "toolUse", durationMs: 1000,
    content: [{ type: "toolCall", id: "tool", name: "codemode", arguments: {} }], usage: usage(100, 100, 900) };
  handlers.get("agent_start")({}, ctx); handlers.get("turn_start")({}, ctx);
  handlers.get("message_start")({ message: first }, ctx);
  providerEvent(handlers, first, "response.created");
  now = 1010; providerEvent(handlers, first, "response.function_call_arguments.delta", "{");
  now = 2000; providerEvent(handlers, first, "response.function_call_arguments.delta", "}");
  finishResponse(handlers, first, ctx);
  const beforeTool = frame();
  assert.match(beforeTool, /↑100 ↓100.*cache 90%/);
  assert.match(beforeTool, /100 tok\/s/, "the main model's completed tool call is a generation sample");
  handlers.get("tool_execution_start")({ toolCallId: "tool", toolName: "codemode", args: {} }, ctx);
  now = 4000;
  const tool = { role: "toolResult", toolCallId: "tool", toolName: "codemode", timestamp: 4000, isError: false,
    content: [{ type: "text", text: "tool stdout ".repeat(1000) }], usage: usage(50000, 50000, 0) };
  handlers.get("tool_execution_end")({ toolCallId: "tool", toolName: "codemode", result: { content: tool.content, usage: tool.usage }, isError: false }, ctx);
  handlers.get("message_start")({ message: tool }, ctx); handlers.get("message_end")({ message: tool }, ctx);
  assert.equal(frame(), beforeTool, "reported tool-model usage changes neither cache, I/O nor speed");
  const last = { role: "assistant", provider: "p", responseId: "b", timestamp: 4000, stopReason: "stop", durationMs: 1000,
    content: [{ type: "text", text: "complete" }], usage: usage(0, 20, 0) };
  handlers.get("turn_start")({}, ctx); handlers.get("message_start")({ message: last }, ctx);
  now = 5000; handlers.get("message_end")({ message: last }, ctx);
  handlers.get("agent_end")({}, ctx); handlers.get("agent_settled")({}, ctx);
  assert.match(frame(), /↑100 ↓120/);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.usage.output, 120, "interaction summary excludes nested tool-model usage too");
  entries.push(...[first, tool, last].map((message, i) => ({ type: "message", id: `e${i}`, message })));
  handlers.get("session_tree")({}, ctx);
  assert.match(frame(), /↑100 ↓120/, "same persisted history has the same totals after idle tree navigation");
  assert.doesNotMatch(frame(), /tok\/s/, "a new context does not keep a former response's rate");
});

test("selection changes cancel generation sampling, including late producer events", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const commands = new Map();
  const { handlers, footer: makeFooter, ctx } = await session(t, { api: {
    registerCommand: (name, options) => commands.set(name, options),
  } });
  const footer = makeFooter();
  const frame = () => plain(footer.render(140).join("\n"));
  let message = { role: "assistant", provider: "p", api: "openai-responses", model: "m", responseId: "r",
    timestamp: 1, content: [], stopReason: "stop", durationMs: 10_025, usage: { output: 2, reasoning: 0 } };
  const produce = () => {
    providerEvent(handlers, message, "response.created");
    now += 10_000; providerEvent(handlers, message, "response.output_text.delta", "a");
    now += 25; providerEvent(handlers, message, "response.output_text.delta", "b");
  };
  for (const event of ["model_select", "thinking_level_select"]) {
    message = { ...message, content: [] }; // each SDK request owns a new completed object
    handlers.get("agent_start")({}, ctx); handlers.get("turn_start")({}, ctx);
    handlers.get("message_start")({ message }, ctx); produce(); finishResponse(handlers, message, ctx);
    handlers.get("agent_end")({}, ctx); handlers.get("agent_settled")({}, ctx);
    assert.match(frame(), /40 tok\/s/);
    let report;
    commands.get("codex-ui").handler("", { ui: { notify: text => { report = text; } } });
    assert.match(report, /gen\(last\) 40 tok\/s \(output=2 tokens, reasoning excluded=0, window=25ms, events=2, samples=1, scope=last completed\)/);
    assert.match(report, /excludes initial wait\/TTFT, reasoning and completion callbacks/);
    handlers.get(event)({}, ctx);
    assert.doesNotMatch(frame(), /tok\/s/);
    handlers.get("agent_start")({}, ctx); handlers.get("turn_start")({}, ctx);
    handlers.get(event)({}, ctx); // change selection while response headers are pending
    handlers.get("message_start")({ message }, ctx); produce(); finishResponse(handlers, message, ctx);
    assert.doesNotMatch(frame(), /tok\/s/, "late old-selection headers must not reopen the invalidated response slot");
    handlers.get("agent_end")({}, ctx); handlers.get("agent_settled")({}, ctx);
  }
});

for (const [name, config, context] of [
  ["disabled", { enabled: false }, {}],
  ["noninteractive", {}, { hasUI: false, mode: undefined }],
]) {
  test(`${name} activation leaves native tools, chrome and summaries untouched`, async (t) => {
    const appended = [];
    const { handlers, slots, Host, original } = await session(t, {
      getAgentDir: () => "/unused", readFile: appearanceFile(config),
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
