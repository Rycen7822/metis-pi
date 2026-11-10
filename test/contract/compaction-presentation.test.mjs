import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import appearance from "../../extensions/appearance.ts";
import { copyFrame, select } from "../helpers/ui-fixtures.mjs";

const workDir = new URL("../../.work/", import.meta.url);
mkdirSync(workDir, { recursive: true });
const agentDir = mkdtempSync(new URL("compaction-presentation-", workDir));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});
Pi.initTheme("dark", false);
const previousKeys = Tui.getKeybindings();
Tui.setKeybindings(new Tui.KeybindingsManager({
  ...Tui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" },
}, { "app.tools.expand": "alt+o" }));
test.after(() => Tui.setKeybindings(previousKeys));
const prototype = Pi.CompactionSummaryMessageComponent.prototype;
const method = "getDisplayHeader";
const original = Object.getOwnPropertyDescriptor(prototype, method);
const nativeDisplay = Object.getOwnPropertyDescriptor(prototype, "updateDisplay");
const titleLayer = typeof original?.value === "function";
const summary = "Keep **this summary** and its checkpoint unchanged.\n\nCompacted from 899771 tokens is quoted source text.";
const count = n => n.toLocaleString();
const plain = component => component.render(160).map(Tui.stripTerminalSequences).join("\n");
const contextLabel = `Compacted · estimated context: ${count(899771)} tokens`;
const nativeLabel = `Compacted from ${count(899771)} tokens`;
const displayLabel = titleLayer ? contextLabel : nativeLabel;
const inputLabel = `Summary request input (provider-reported): ${count(171435)} tokens`;
const usage = { input: 150000, output: 2468, cacheRead: 20000, cacheWrite: 1435, totalTokens: 173903,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function harness(t, manager = Pi.SessionManager.inMemory(), mode = "tui") {
  const handlers = new Map();
  appearance({
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler); handlers.set(event, list);
      return () => list.splice(list.indexOf(handler), 1);
    },
    getAllTools: () => [], registerCommand() {}, registerEntryRenderer() {},
  });
  const context = sessionManager => ({ mode, hasUI: true, cwd: "/tmp/compaction-presentation",
    sessionManager, ui: { notify() {}, get theme() {
      return globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
    } } });
  let ctx = context(manager);
  const emit = async (type, event = {}, sessionManager) => {
    if (sessionManager) ctx = context(sessionManager);
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
  };
  t.after(() => emit("session_shutdown"));
  return { emit };
}
function append(manager, reportedUsage = usage, body = summary) {
  const id = manager.appendCompaction(body, null, 899771, undefined, false, reportedUsage);
  return manager.getEntry(id);
}
function restored(manager) {
  const message = manager.buildSessionProjection().messages.find(m => m.role === "compactionSummary");
  assert.ok(message);
  return new Pi.CompactionSummaryMessageComponent(message);
}
function click(component, button = "left") {
  const region = component.children[0];
  assert.ok(region instanceof Tui.MouseRegion);
  return region.handleMouse({ type: "click", button, x: 1, y: 0, screenX: 1, screenY: 0 });
}

// Real native handleEvent/addMessageToChat, with incidental interactive collaborators only.
async function liveCard(manager, entry) {
  const mode = {
    isInitialized: true, sessionManager: manager, chatContainer: new Tui.Container(), outputPad: 1,
    loadedResourcesContainer: new Tui.Container(), pendingMessagesContainer: new Tui.Container(),
    toolOutputExpanded: false, footer: { invalidate() {} }, programStatus: { handleEvent() {} },
    settingsManager: { getShowTerminalProgress: () => false, getShowCacheMissNotices: () => false },
    ui: { requestRender() {} }, clearStatusIndicator() {}, flushCompactionQueue: async () => {},
    getMarkdownTransformers: () => [],
    renderSessionEntries(entries) { assert.deepEqual(entries, []); },
    addMessageToChat: Pi.InteractiveMode.prototype.addMessageToChat,
    addCompactionCostNotice: Pi.InteractiveMode.prototype.addCompactionCostNotice,
    getMarkdownThemeWithSettings: Pi.getMarkdownTheme,
  };
  await Pi.InteractiveMode.prototype.handleEvent.call(mode, { type: "compaction_end", result: entry,
    reason: "manual", aborted: false, willRetry: false });
  const card = mode.chatContainer.children.find(c => c instanceof Pi.CompactionSummaryMessageComponent);
  assert.ok(card, "actual compaction_end constructs the native card");
  return card;
}

test("summary presentation retains native expansion, mouse, Markdown, wrapping and copy", async t => {
  const manager = Pi.SessionManager.inMemory();
  manager.appendCompaction(summary, null, 899771);
  const before = JSON.stringify(manager.getEntries());
  const h = harness(t, manager);
  await h.emit("session_start");
  const card = restored(manager);
  assert.ok(plain(card).includes(displayLabel));
  assert.doesNotMatch(plain(card), /provider-reported|Keep this summary/);
  assert.ok(plain(card).includes("alt+o to expand"));
  assert.equal(click(card, "right"), undefined);
  assert.deepEqual(click(card), { handled: true });
  assert.equal(card.expanded, true);
  assert.ok(card.children[0].child.children[2] instanceof Tui.Markdown);
  const receiver = { toolOutputExpanded: true, chatContainer: new Tui.Container(),
    loadedResourcesContainer: new Tui.Container(), pendingMessagesContainer: new Tui.Container(), showStatus() {} };
  receiver.chatContainer.addChild(card);
  Pi.InteractiveMode.prototype.setToolsExpanded.call(receiver, false);
  assert.equal(card.expanded, false);
  for (const expanded of [false, true]) {
    card.setExpanded(expanded);
    for (const width of [24, 80]) {
      const frame = copyFrame(card, width);
      assert.ok(frame.root.lines.every(line => Tui.visibleWidth(line) <= width));
      const copied = select(frame).text;
      assert.ok(copied.includes(displayLabel));
      assert.equal(copied.split("estimated context:").length - 1, titleLayer ? 1 : 0, "one display title only");
      assert.equal(copied.includes("Keep this summary"), expanded);
      assert.equal(copied.includes("Compacted from 899771 tokens is quoted source text."), expanded,
        "the source sentence is not rewritten as a label");
    }
  }
  card.invalidate();
  assert.equal(card.expanded, true);
  assert.equal(JSON.stringify(manager.getEntries()), before);
});

test("reported summary input includes cached input, excludes output and does not alter model projection", async t => {
  const manager = Pi.SessionManager.inMemory(); append(manager);
  const before = JSON.stringify(manager.buildSessionProjection().messages);
  const h = harness(t, manager);
  await h.emit("session_start");
  const card = restored(manager);
  for (const expanded of [false, true]) {
    card.setExpanded(expanded);
    for (const width of [24, 80]) {
      const frame = copyFrame(card, width);
      assert.ok(frame.root.lines.every(line => Tui.visibleWidth(line) <= width));
      const copied = select(frame).text;
      assert.ok(copied.includes(displayLabel));
      assert.equal(copied.includes(inputLabel), titleLayer);
      assert.equal(copied.split("provider-reported").length - 1, titleLayer ? 1 : 0);
      assert.ok(!copied.includes(`${count(usage.totalTokens)} tokens`));
    }
  }
  card.setExpanded(false);
  const darkRows = card.render(160);
  Pi.initTheme("light", false);
  t.after(() => Pi.initTheme("dark", false));
  card.invalidate();
  assert.ok(plain(card).includes(displayLabel));
  assert.equal(plain(card).includes(inputLabel), titleLayer);
  assert.notDeepEqual(card.render(160), darkRows);
  card.setExpanded(true);
  assert.equal(JSON.stringify(manager.buildSessionProjection().messages), before);
});

test("normalized zero usage stays unknown while cached-only reported input remains available", async t => {
  const h = harness(t);
  for (const cacheRead of [0, 171435]) {
    const manager = Pi.SessionManager.inMemory();
    append(manager, { ...usage, input: 0, output: 0, cacheRead, cacheWrite: 0, totalTokens: cacheRead });
    await h.emit("session_start", {}, manager);
    const card = restored(manager);
    assert.ok(plain(card).includes(displayLabel));
    assert.equal(plain(card).includes(inputLabel), titleLayer && cacheRead > 0);
    assert.equal(plain(card).includes("provider-reported"), titleLayer && cacheRead > 0);
  }
});

test("a live card accepts only a newly observed unique branch entry, not ambiguous or retired matches", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
  const manager = Pi.SessionManager.inMemory(), h = harness(t, manager);
  await h.emit("session_start");
  const entry = append(manager);
  await h.emit("session_compact", { compactionEntry: entry, fromExtension: false });
  t.mock.timers.tick(2000);
  const card = await liveCard(manager, entry);
  assert.equal(card.message.timestamp, Date.parse(entry.timestamp) + 2000);
  assert.equal(plain(card).includes(inputLabel), titleLayer);
  await h.emit("session_tree"); card.invalidate();
  assert.doesNotMatch(plain(card), /provider-reported/);
  assert.equal(plain(restored(manager)).includes(inputLabel), titleLayer);
  t.mock.timers.tick(1000);
  const duplicate = append(manager);
  await h.emit("session_compact", { compactionEntry: duplicate, fromExtension: false });
  t.mock.timers.tick(2000);
  assert.doesNotMatch(plain(await liveCard(manager, duplicate)), /provider-reported/);
  await h.emit("session_start", {}, Pi.SessionManager.inMemory()); card.invalidate();
  assert.doesNotMatch(plain(card), /provider-reported/);
});

test("shared header leases use the current live context after either owner is released", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
  const first = Pi.SessionManager.inMemory(), second = Pi.SessionManager.inMemory();
  for (const [manager, input] of [[first, 111], [second, 222]]) {
    append(manager, { ...usage, input, cacheRead: 0, cacheWrite: 0, totalTokens: input });
  }
  const a = harness(t, first), b = harness(t, second);
  await a.emit("session_start"); await b.emit("session_start");
  const visible = (manager, input) => {
    const text = plain(restored(manager));
    assert.ok(text.includes(displayLabel));
    assert.equal(text.includes(`provider-reported): ${input} tokens`), titleLayer);
  };
  visible(second, 222);
  await a.emit("session_shutdown");
  visible(second, 222);
  await a.emit("session_start");
  visible(first, 111);
  await a.emit("session_shutdown");
  visible(second, 222);
  await b.emit("session_shutdown");
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, method), original);
});

test("session restarts and foreign retained header wrappers do not stack or survive release", async t => {
  const manager = Pi.SessionManager.inMemory(); append(manager);
  const h = harness(t, manager);
  await h.emit("session_start"); await h.emit("session_start");
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay"), nativeDisplay,
    "Metis does not wrap the rendering method");
  const card = restored(manager);
  for (let i = 0; i < 3; i++) card.invalidate();
  assert.equal(plain(card).split("estimated context:").length - 1, titleLayer ? 1 : 0);
  if (!titleLayer) {
    await h.emit("session_shutdown");
    assert.equal(Object.hasOwn(prototype, method), false, "stock capability fallback does not invent an API");
    return;
  }
  const retained = prototype[method];
  let nativeCalls = 0;
  const outer = function (...args) { nativeCalls++; return retained.apply(this, args); };
  Object.defineProperty(prototype, method, { ...original, value: outer });
  t.after(() => Object.defineProperty(prototype, method, original));
  await h.emit("session_shutdown"); await h.emit("session_shutdown");
  assert.equal(prototype[method], outer);
  assert.doesNotMatch(plain(restored(manager)), /estimated context:/);
  const reloaded = harness(t, manager);
  await reloaded.emit("session_start");
  const next = restored(manager);
  assert.ok(plain(next).includes(inputLabel));
  assert.equal(plain(next).split("estimated context:").length - 1, 1);
  assert.equal(nativeCalls, 2);
  await reloaded.emit("session_shutdown");
  assert.equal(prototype[method], outer);
  Object.defineProperty(prototype, method, original);
  const last = harness(t, manager);
  await last.emit("session_start"); await last.emit("session_shutdown");
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, method), original);
});

test("foreign layout decoration stays untouched and non-TUI mode never leases a header", async t => {
  const foreign = function () { nativeDisplay.value.call(this); this.addChild(new Tui.Text("foreign decoration", 0, 0)); };
  Object.defineProperty(prototype, "updateDisplay", { ...nativeDisplay, value: foreign });
  t.after(() => Object.defineProperty(prototype, "updateDisplay", nativeDisplay));
  const manager = Pi.SessionManager.inMemory(); append(manager);
  const h = harness(t, manager);
  await h.emit("session_start");
  const card = restored(manager);
  assert.ok(plain(card).includes(displayLabel));
  assert.match(plain(card), /foreign decoration/);
  assert.equal(card.children.at(-1).text, "foreign decoration", "display data never searches or rewrites an unknown subtree");
  await h.emit("session_shutdown");
  Object.defineProperty(prototype, "updateDisplay", nativeDisplay);
  const rpc = harness(t, manager, "rpc");
  await rpc.emit("session_start");
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, method), original);
});

test("summary transformers keep original body, metadata, order and available width", async t => {
  const manager = Pi.SessionManager.inMemory(); append(manager);
  const h = harness(t, manager);
  await h.emit("session_start");
  const message = manager.buildSessionProjection().messages.find(m => m.role === "compactionSummary");
  const calls = [];
  const transformers = [
    (text, context) => { calls.push({ step: 1, text, context }); return text + "\n\nTRANSFORMED"; },
    (text, context) => { calls.push({ step: 2, text, context }); return text; },
  ];
  const card = new Pi.CompactionSummaryMessageComponent(message, Pi.getMarkdownTheme(), 1,
    transformers, "summary-message", "2026-01-01T00:00:00.000Z");
  card.setExpanded(true);
  const output = plain(card);
  assert.ok(output.includes(displayLabel));
  assert.equal(output.split("TRANSFORMED").length - 1, 1);
  assert.equal(card.children[0].child.children[2].text, summary);
  assert.ok(calls.length >= 2);
  for (let i = 0; i < calls.length; i += 2) {
    assert.equal(calls[i].step, 1);
    assert.equal(calls[i].text, summary);
    assert.equal(calls[i + 1].step, 2);
    assert.equal(calls[i + 1].text, summary + "\n\nTRANSFORMED");
    for (const call of [calls[i], calls[i + 1]]) {
      assert.equal(call.context.messageType, "summary");
      assert.equal(call.context.messageId, "summary-message");
      assert.equal(call.context.timestamp, "2026-01-01T00:00:00.000Z");
      assert.ok(call.context.availableWidth > 0);
    }
  }
});
