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
const original = Object.getOwnPropertyDescriptor(prototype, "updateDisplay");
const summary = "Keep **this summary** and its checkpoint unchanged.\n\nCompacted from 899771 tokens is quoted source text.";
const count = n => n.toLocaleString();
const plain = component => component.render(160).map(Tui.stripTerminalSequences).join("\n");
const contextLabel = `Compacted · estimated context: ${count(899771)} tokens`;
const inputLabel = `Summary request input (provider-reported): ${count(171435)} tokens`;
const usage = { input: 150000, output: 2468, cacheRead: 20000, cacheWrite: 1435, totalTokens: 173903,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// Exercise the production appearance entry and real Pi components. No terminal,
// provider, disk session or personal config is needed by this lifecycle fixture.
function harness(t, manager = Pi.SessionManager.inMemory(), mode = "tui") {
  const handlers = new Map();
  appearance({
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler); handlers.set(event, list);
      return () => list.splice(list.indexOf(handler), 1);
    },
    getAllTools: () => [],
    registerCommand() {}, registerEntryRenderer() {},
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
  assert.ok(message, "native session projection yields the real summary message");
  return new Pi.CompactionSummaryMessageComponent(message);
}
function click(component, button = "left") {
  const region = component.children[0];
  assert.ok(region instanceof Tui.MouseRegion, "native click region is retained");
  return region.handleMouse({ type: "click", button, x: 1, y: 0, screenX: 1, screenY: 0 });
}

// This mirrors the native receiver's collaborators, not its compaction/rendering
// code: handleEvent and addMessageToChat below are the actual Pi 1.4 methods.
async function liveCard(manager, entry) {
  const mode = {
    isInitialized: true, sessionManager: manager, chatContainer: new Tui.Container(), outputPad: 1,
    toolOutputExpanded: false, footer: { invalidate() {} }, programStatus: { handleEvent() {} },
    settingsManager: { getShowTerminalProgress: () => false, getShowCacheMissNotices: () => false },
    ui: { requestRender() {} }, clearStatusIndicator() {}, flushCompactionQueue: async () => {},
    renderSessionEntries(entries) { assert.deepEqual(entries, [], "no kept messages in this fixture"); },
    addMessageToChat: Pi.InteractiveMode.prototype.addMessageToChat,
    addCompactionCostNotice: Pi.InteractiveMode.prototype.addCompactionCostNotice,
    getMarkdownThemeWithSettings: Pi.getMarkdownTheme,
  };
  await Pi.InteractiveMode.prototype.handleEvent.call(mode, { type: "compaction_end", result: entry,
    reason: "manual", aborted: false, willRetry: false });
  const card = mode.chatContainer.children.find(c => c instanceof Pi.CompactionSummaryMessageComponent);
  assert.ok(card, "actual compaction_end constructs the native summary component");
  return card;
}

test("old summaries label context as an estimate, keeping native expand/click, Markdown, wrapping and copy", async t => {
  const old = Pi.SessionManager.inMemory();
  old.appendCompaction(summary, null, 899771);
  const before = JSON.stringify(old.getEntries());
  const h = harness(t, old);
  await h.emit("session_start");
  const card = restored(old);
  assert.match(plain(card), /estimated context:/);
  assert.ok(plain(card).includes(contextLabel));
  assert.doesNotMatch(plain(card), /provider-reported|Keep this summary/);
  assert.ok(plain(card).includes("alt+o to expand"), "the configured native keybinding remains visible");
  assert.equal(click(card, "right"), undefined, "native non-left-click behavior remains unhandled");
  assert.deepEqual(click(card), { handled: true });
  assert.equal(card.expanded, true);
  assert.ok(card.children[0].child.children[2] instanceof Tui.Markdown);
  const keyboardReceiver = { toolOutputExpanded: true, chatContainer: new Tui.Container(),
    loadedResourcesContainer: new Tui.Container(), showStatus() {} };
  keyboardReceiver.chatContainer.addChild(card);
  Pi.InteractiveMode.prototype.setToolsExpanded.call(keyboardReceiver, false);
  assert.equal(card.expanded, false, "native app.tools.expand path still controls this component");
  for (const expanded of [false, true]) {
    card.setExpanded(expanded);
    for (const width of [24, 80]) {
      const frame = copyFrame(card, width);
      assert.ok(frame.root.lines.every(line => Tui.visibleWidth(line) <= width));
      const copied = select(frame);
      assert.ok(copied.text.includes(contextLabel), "narrow selection reconstructs the estimated-context label");
      assert.equal(copied.text.includes("Keep this summary"), expanded, "original summary text remains selectable");
      assert.equal(copied.text.includes("Compacted from 899771 tokens is quoted source text."), expanded,
        "never regex-rewrite summary contents");
    }
  }
  card.invalidate();
  assert.equal(card.expanded, true, "theme invalidation must not collapse the card");
  assert.equal(JSON.stringify(old.getEntries()), before, "presentation cannot alter stored entries");
});

test("persisted entry usage is a separate provider-reported summary input, including cached input but not output", async t => {
  const manager = Pi.SessionManager.inMemory();
  append(manager);
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
      assert.ok(copied.includes(contextLabel));
      assert.ok(copied.includes(inputLabel));
      assert.equal(copied.split("provider-reported").length - 1, 1);
      assert.ok(!copied.includes(`${count(usage.totalTokens)} tokens`), "summary output is not input");
    }
  }
  const darkRows = card.render(160);
  Pi.initTheme("light", false);
  t.after(() => Pi.initTheme("dark", false));
  card.invalidate();
  const light = plain(card);
  assert.ok(light.includes(contextLabel) && light.includes(inputLabel));
  assert.notDeepEqual(card.render(160), darkRows, "theme invalidation rebuilds native styled output");
  assert.equal(card.expanded, true);
  assert.equal(JSON.stringify(manager.buildSessionProjection().messages), before, "model projection is unchanged");
});

test("all-zero normalized usage is unavailable, while positive cached-only request input stays visible", async t => {
  const manager = Pi.SessionManager.inMemory();
  const h = harness(t, manager);
  for (const cacheRead of [0, 171435]) {
    const next = Pi.SessionManager.inMemory();
    append(next, { ...usage, input: 0, output: 0, cacheRead, cacheWrite: 0, totalTokens: cacheRead });
    await h.emit("session_start", {}, next);
    const card = restored(next);
    for (const expanded of [false, true]) {
      card.setExpanded(expanded);
      assert.ok(plain(card).includes(contextLabel));
      assert.equal(plain(card).includes(inputLabel), cacheRead > 0);
      assert.equal(plain(card).includes("provider-reported"), cacheRead > 0,
        "zero normalized usage must never be advertised as an exact provider report");
    }
  }
});

test("actual Pi compaction_end's fresh timestamp uses only a newly observed, unambiguous branch entry", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
  const manager = Pi.SessionManager.inMemory();
  const h = harness(t, manager);
  await h.emit("session_start");
  const entry = append(manager);
  await h.emit("session_compact", { compactionEntry: entry, fromExtension: false });
  t.mock.timers.tick(2000);
  const card = await liveCard(manager, entry);
  assert.equal(card.message.timestamp, Date.parse(entry.timestamp) + 2000, "native live UI really changes the timestamp");
  assert.ok(plain(card).includes(inputLabel));
  await h.emit("session_tree");
  card.invalidate();
  assert.doesNotMatch(plain(card), /provider-reported/, "tree navigation retires the live-only identity fallback");
  assert.ok(plain(restored(manager)).includes(inputLabel), "persisted timestamp matching still works after navigation");
  t.mock.timers.tick(1000);
  const duplicate = append(manager);
  await h.emit("session_compact", { compactionEntry: duplicate, fromExtension: false });
  t.mock.timers.tick(2000);
  assert.doesNotMatch(plain(await liveCard(manager, duplicate)), /provider-reported/,
    "same-summary/count entries make the live fallback ambiguous");
  await h.emit("session_start", {}, Pi.SessionManager.inMemory());
  card.invalidate();
  assert.doesNotMatch(plain(card), /provider-reported/, "session replacement cannot leak usage");
});

test("repeated session starts, shutdown, reload and foreign wrappers never stack or clobber a native lease", async t => {
  const manager = Pi.SessionManager.inMemory(); append(manager);
  const h = harness(t, manager);
  await h.emit("session_start");
  await h.emit("session_start");
  const card = restored(manager);
  for (let i = 0; i < 3; i++) card.invalidate();
  assert.equal(plain(card).split("estimated context:").length - 1, 1);
  const patched = prototype.updateDisplay;
  let nativeCalls = 0;
  const outer = function (...args) { nativeCalls++; return patched.apply(this, args); };
  Object.defineProperty(prototype, "updateDisplay", { ...original, value: outer });
  t.after(() => Object.defineProperty(prototype, "updateDisplay", original));
  await h.emit("session_shutdown");
  await h.emit("session_shutdown");
  assert.equal(prototype.updateDisplay, outer, "dispose cannot remove an unrelated outer wrapper");
  assert.doesNotMatch(plain(restored(manager)), /estimated context:/, "released inner wrapper becomes transparent");
  const reloaded = harness(t, manager);
  await reloaded.emit("session_start");
  const next = restored(manager);
  assert.ok(plain(next).includes(inputLabel));
  assert.equal(plain(next).split("estimated context:").length - 1, 1);
  assert.equal(nativeCalls, 2, "each construction traverses the native predecessor once");
  await reloaded.emit("session_shutdown");
  assert.equal(prototype.updateDisplay, outer);
  Object.defineProperty(prototype, "updateDisplay", original);
  const last = harness(t, manager);
  await last.emit("session_start");
  await last.emit("session_shutdown");
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay"), original);
});

test("unknown native subtrees and non-TUI modes are left untouched", async t => {
  const foreign = function () { original.value.call(this); this.addChild(new Tui.Text("foreign decoration", 0, 0)); };
  Object.defineProperty(prototype, "updateDisplay", { ...original, value: foreign });
  t.after(() => Object.defineProperty(prototype, "updateDisplay", original));
  const manager = Pi.SessionManager.inMemory(); append(manager);
  const h = harness(t, manager);
  await h.emit("session_start");
  const card = restored(manager);
  assert.match(plain(card), /Compacted from/);
  assert.doesNotMatch(plain(card), /estimated context:|provider-reported/);
  assert.match(plain(card), /foreign decoration/);
  await h.emit("session_shutdown");
  Object.defineProperty(prototype, "updateDisplay", original);
  const rpc = harness(t, manager, "rpc");
  await rpc.emit("session_start");
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay"), original);
});
