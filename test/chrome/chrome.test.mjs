// chrome.test.mjs — chrome-level tests with REAL host data shapes: the exact
// field names Pi 0.85.1 provides (model.id/name/provider/contextWindow,
// ctx.thinkingLevel, ctx.getContextUsage() = {tokens, contextWindow, percent},
// Usage = {input, output, cacheRead, cacheWrite, cost.total}).
// Fake interfaces that merely mirror the plugin's own assumptions are
// forbidden here — that pattern let 0.8.3 ship an empty footer.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activate } from "../../src/extension.ts";
import { GIT_CHANGES_INTERVAL_MS } from "../../src/git-changes.ts";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { theme } from "../helpers.mjs";
import { makeCodexEditorFactory } from "../../src/chrome/editor.ts";
import { layoutFooter } from "../../src/chrome/footer.ts";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { CURSOR_MARKER } from "../../src/surface.ts";
import { altScreen } from "../helpers/ui-fixtures.mjs";

/** Real host data shapes (Pi 0.85.1). `ui` deliberately has NO
 * getContextUsage/requestRender — those are not ui-surface methods. */
function realShapeCtx(overrides = {}) {
  return {
    ctx: {
      mode: "tui",
      hasUI: true,
      model: { id: "test-model", name: "Test Model", provider: "test-provider", contextWindow: 1_000_000 },
      thinkingLevel: "high",
      cwd: "/tmp/workspace",
      getContextUsage() { return { tokens: 172_000, contextWindow: 1_000_000, percent: 17.2 }; },
      sessionManager: { getEntries: () => entriesTwoRequests() },
      ui: {},
      ...overrides,
    },
  };
}

/** Two completed requests: session Σ 5000/300/10000/0, cache(last) 20%. */
function entriesTwoRequests() {
  const base = { type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
  return [
    { ...base, id: "e1", message: assistantMsg("r1", 1000, 100, 9000, 0, 1) },
    { ...base, id: "e2", message: assistantMsg("r2", 4000, 200, 1000, 0, 2) },
  ];
}

function assistantMsg(responseId, input, output, cacheRead, cacheWrite, ts) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    responseId,
    usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: ts,
  };
}

/** Drive the REAL activation with a fake pi, capturing every UI slot call. */
function activateHarness(bindingsExtra = {}) {
  const handlers = new Map();
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    getAllTools: () => [],
  };
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
    prototype: class {}.prototype,
    makeText: (s) => ({ render: () => [s] }),
    expandHint: () => "expand",
    getAgentDir: () => undefined,
    appearanceVersion: "0.8.5-test",
    piVersion: "0.85.1-test",
    // Gray surface painters (index.ts injects real Tui-backed ones).
    surface: {
      paintRow: (row, width) => {
        const bare = row.replace(/\x1b\[[0-9;]*m/g, "");
        const pad = Math.max(0, width - bare.length);
        return `<S>${row}${" ".repeat(pad)}</S>`;
      },
      paintGlyph: (text, tone) => `<${tone}>${text}</${tone}>`,
    },
    ...bindingsExtra,
  };
  activate(pi, bindings);
  const wrapUi = (ctx) => ({
    ...ctx,
    ui: {
      notify: (text, level) => slots.notifications.push({ text, level }),
      setEditorComponent: (factory) => slots.editorFactories.push(factory),
      getEditorComponent: () => slots.editorFactories.at(-1),
      setFooter: (factory) => slots.footerFactories.push(factory),
      setHeader: (factory) => slots.headerFactories.push(factory),
      setWidget: (key, content, options) => slots.widgetCalls.push({ key, content, options }),
      setWorkingVisible: (v) => slots.workingVisible.push(v),
      setWorkingMessage: (m) => slots.workingMessages.push(m),
      setStatus: (key, text) => slots.statuses.set(key, text),
      ...ctx.ui,
    },
  });
  const footer = (data = {}) => slots.footerFactories.at(-1)({ requestRender() {} }, theme, {
    getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
    ...data,
  });
  return { handlers, slots, wrapUi, footer };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function session(t, bindings = {}, overrides = {}) {
  const h = activateHarness(bindings);
  t.after(() => h.handlers.get("session_shutdown")());
  const ctx = h.wrapUi(realShapeCtx(overrides).ctx);
  h.handlers.get("session_start")({}, ctx);
  await tick(); // Chrome preloading installs the factories asynchronously.
  return { ...h, ctx };
}

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/<\/?S>/g, "").replace(/<\/?(accent|dim|warning|normal)>/g, "");
const widgetByKey = (slots, key) =>
  slots.widgetCalls.filter((c) => c.key === key && c.content !== undefined).at(-1);

function nativeEditor(options = {}) {
  const { tui } = altScreen();
  const editor = makeCodexEditorFactory({ host: { CustomEditor }, ...options })(
    tui, { ...theme, borderColor: (text) => text }, new KeybindingsManager(TUI_KEYBINDINGS),
  );
  editor.focused = true;
  return editor;
}

test("footer animation frames reuse context usage while host events and late appends stay fresh", async (t) => {
  let reads = 0;
  let tokens = 10;
  let leaf = "first";
  const { handlers, footer: makeFooter, ctx } = await session(t, {}, {
    sessionManager: { getEntries: () => [], getLeafId: () => leaf },
    getContextUsage() {
      reads += 1;
      return { tokens, contextWindow: 100, percent: tokens };
    },
  });
  const footer = makeFooter();
  const frame = () => plain(footer.render(140).join("\n"));
  assert.match(frame(), /ctx 10\/100 · 10%/);
  for (let i = 0; i < 64; i += 1) frame();
  assert.equal(reads, 1);
  for (const event of ["message_start", "message_update", "message_end", "agent_end", "agent_settled",
    "model_select", "thinking_level_select", "session_tree", "session_compact", "session_compact_failed"]) {
    tokens += 1;
    handlers.get(event)({ type: event });
    assert.match(frame(), new RegExp(`ctx ${tokens}/100 · ${tokens}%`), event);
    const refreshed = reads;
    frame();
    assert.equal(reads, refreshed, `${event}: unchanged renders reuse its sample`);
  }
  // Pi persists message_end after extension callbacks. Even if a callback
  // renders early, the next frame must see that later append without a timer.
  tokens = 30;
  leaf = "appended-after-message-end";
  assert.match(frame(), /ctx 30\/100 · 30%/);
  tokens = null;
  handlers.get("session_compact")({ type: "session_compact" });
  assert.match(frame(), /ctx —\/100/);
  tokens = 40;
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

test("git polling follows the installed footer's changes toggle, including reload and failed installs", async (t) => {
  const schedule = globalThis.setInterval;
  const cancel = globalThis.clearInterval;
  const active = new Set();
  let starts = 0;
  t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
    const timer = schedule(callback, ms, ...args);
    if (ms === GIT_CHANGES_INTERVAL_MS) { active.add(timer); starts += 1; }
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => {
    active.delete(timer);
    return cancel(timer);
  });
  const cases = [
    { name: "changes hidden", config: { footer: { showChanges: false } } },
    { name: "changes restored on reload", config: { footer: { showChanges: true } }, polling: true },
    { name: "changes hidden again", config: { footer: { showChanges: false } } },
    { name: "footer disabled", config: { footer: { enabled: false } } },
    { name: "extension disabled", config: { enabled: false } },
    { name: "no footer capability", ui: { setFooter: undefined } },
    { name: "footer install failed", ui: { setFooter() { throw new Error("unsupported"); } } },
    { name: "non-TUI", mode: "rpc" },
    { name: "no displayed cwd", cwd: "" },
    { name: "shutdown before async install", earlyShutdown: true },
  ];
  for (const scenario of cases) {
    const { handlers, wrapUi } = activateHarness({
      getAgentDir: () => "/unused",
      readFile: () => JSON.stringify(scenario.config ?? {}),
    });
    const shutdown = () => handlers.get("session_shutdown")();
    try {
      const before = starts;
      handlers.get("session_start")({}, wrapUi(realShapeCtx({
        mode: scenario.mode ?? "tui", cwd: scenario.cwd ?? "/tmp/workspace", ui: scenario.ui ?? {},
      }).ctx));
      if (scenario.earlyShutdown) shutdown();
      await tick();
      assert.equal(starts - before, scenario.polling ? 1 : 0, scenario.name);
      assert.equal(active.size, scenario.polling ? 1 : 0, scenario.name);
    } finally {
      shutdown();
    }
    assert.equal(active.size, 0, `${scenario.name}: shutdown cancels the poller`);
  }
});

test("chrome modules have no direct host imports (src/ rule)", () => {
  // Read the directory instead of a hardcoded list: every chrome module is covered,
  // including new ones (the factory in editor.ts explains the rule's reason).
  for (const entry of readdirSync(new URL("../../src/chrome/", import.meta.url))) {
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(new URL(`../../src/chrome/${entry}`, import.meta.url), "utf8");
    assert.ok(!text.includes("from \"@earendil-works"), `src/chrome/${entry} must not import host packages directly`);
    assert.ok(!text.includes("from '@earendil-works"), `src/chrome/${entry} must not import host packages directly`);
  }
});

test("REAL shape → activation → one ordered footer below the editor", async (t) => {
  const { handlers, slots, ctx: wrapped, footer: makeFooter } = await session(t);

  assert.equal(widgetByKey(slots, "metis-pi:composer-meta"), undefined, "no metadata widget inside the input surface");
  const footer = makeFooter({ getGitBranch: () => "main" });

  await t.test("footer: model → effort → provider → path → context → I/O → cache", () => {
    const frame = plain(footer.render(140).join("\n"));
    const fields = ["test-model", "high", "test-provider", "/tmp/workspace (main)", "ctx 172k/1.0M · 17.2%", "↑5.0k ↓300", "cache 20%"];
    let previous = -1;
    for (const field of fields) {
      const index = frame.indexOf(field);
      assert.ok(index > previous, `${field} appears once in the requested order`);
      assert.equal(frame.indexOf(field, index + 1), -1, `${field} is not duplicated`);
      previous = index;
    }
    assert.doesNotMatch(frame, /Codex (?:5h|week)|week \d+%/, "no Codex quota in the footer");
    assert.doesNotMatch(frame, /R\d|W\d/, "session cache read/write counters are gone");
  });

  await t.test("live model switch updates the footer without restart", () => {
    wrapped.model = { id: "switched-model", provider: "other-provider", contextWindow: 2_000_000 };
    wrapped.getContextUsage = () => ({ tokens: 172_000, contextWindow: 2_000_000, percent: 8.6 });
    handlers.get("model_select")({ type: "model_select" });
    const after = plain(footer.render(140).join("\n"));
    assert.ok(after.includes("switched-model"), "new model id visible");
    assert.ok(after.includes("other-provider"), "new provider visible");
    assert.ok(after.includes("2.0M"), "new capacity visible");
    assert.ok(after.includes("8.6%"), "new percent — same revision, no old-window mixing");
    assert.doesNotMatch(after, /test-model|17\.2%/, "old model and context absent");
  });
});

test("footer layout is width-responsive and never overflows (60..200 + 0/1/2)", () => {
  const snapshot = {
    model: { id: "gpt-6-sol", provider: "openai-codex", contextWindow: 272_000 },
    thinkingLevel: "xhigh",
    contextUsage: { tokens: 49_600, contextWindow: 272_000, percent: 18.2 },
    cwd: "/home/xu/wiki/codex_workspace",
    session: { input: 106_000, output: 8_900, cacheRead: 851_000, cacheWrite: 0, costTotal: 0 },
    cacheLastPct: 99.9,
    revision: 1,
  };
  const show = { metadata: true, details: true, showCache: true, showChanges: true, showSpeed: true };
  const widthOf = (text) => {
    let w = 0;
    for (const ch of text.replace(/\x1b\[[0-9;]*m/g, "")) {
      const code = ch.codePointAt(0) ?? 0;
      w += (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60) ? 2 : 1;
    }
    return w;
  };
  for (const width of [60, 80, 100, 120, 140, 160, 200]) {
    const rows = layoutFooter(snapshot, show, width, "main");
    assert.ok(rows.length >= 1, `width ${width}: rows exist`);
    for (const row of rows) {
      assert.ok(widthOf(row.map((s) => s.text).join("")) <= width, `width ${width}: no overflow`);
    }
    const flat = rows.map((r) => r.map((s) => s.text).join("")).join("\n");
    assert.ok(flat.includes("↑106k") && flat.includes("↓8.9k"), `width ${width}: P0 session I/O kept`);
    assert.ok(flat.includes("codex_workspace"), `width ${width}: cwd kept`);
    const ordered = ["gpt-6-sol", "xhigh", "openai-codex", "codex_workspace", "ctx 49.6k/272k", "↑106k", "cache 99.9%"];
    assert.ok(ordered.every((field) => flat.includes(field)), `width ${width}: no field lost`);
    assert.deepEqual(ordered.map((field) => flat.indexOf(field)), ordered.map((field) => flat.indexOf(field)).toSorted((a, b) => a - b), `width ${width}: fields keep order`);
    assert.doesNotMatch(flat, /Codex (?:5h|week)|week \d+%/, `width ${width}: no quota`);
    assert.doesNotMatch(flat, /R\d|W\d/, `width ${width}: session cache read/write counters not rendered`);
  }
  assert.deepEqual(layoutFooter(snapshot, show, 0, "main"), [], "0 columns: hidden, no crash");
  assert.deepEqual(layoutFooter(snapshot, show, 1, "main"), []);
  assert.deepEqual(layoutFooter(snapshot, show, 2, "main"), []);
  const hidden = layoutFooter(snapshot, { ...show, metadata: false }, 140, "main").flat().map((s) => s.text).join("");
  assert.doesNotMatch(hidden, /gpt-6-sol|openai-codex|ctx 49\.6k/);
});

test("footer keeps unknown context distinct from zero usage", () => {
  const snapshot = {
    model: { id: "m", provider: "p", contextWindow: 272_000 },
    thinkingLevel: undefined, contextUsage: { tokens: null, contextWindow: 272_000, percent: null },
    cwd: "/tmp/work", session: undefined, cacheLastPct: null, speed: undefined, changes: undefined, revision: 1,
  };
  const show = { metadata: true, details: true, showCache: true, showChanges: true, showSpeed: true };
  const text = (s) => layoutFooter(s, show, 100, undefined).flat().map((seg) => seg.text).join("");
  assert.match(text(snapshot), /ctx —\/272k/);
  assert.doesNotMatch(text(snapshot), /0%|↑0|cache/);
  assert.match(text({ ...snapshot, contextUsage: { tokens: 0, contextWindow: 272_000, percent: 0 } }), /ctx 0\/272k · 0%/);
});

for (const provider of ["openai-codex", "test-provider"]) {
  test(`footer preserves ${provider} vendor status without adding Codex quota`, async (t) => {
    const { footer: makeFooter } = await session(t, {}, { model: { id: "test-model", provider, contextWindow: 1_000_000 } });
    const footer = makeFooter({ getGitBranch: () => "main",
      getExtensionStatuses: () => new Map([["codex-adapter", "Codex adapter V: low · weekly: 20% left"]]) });
    const frame = plain(footer.render(140).join("\n"));
    assert.match(frame, /Codex adapter V: low · weekly: 20% left/, `${provider}: vendor status remains`);
    assert.doesNotMatch(frame, /Codex (?:5h|week) \d+%/, `${provider}: no independent footer quota`);
  });
}

test("output speed reaches the footer from real events (confirmed usage ÷ observed window)", async (t) => {
  const { handlers, footer: makeFooter } = await session(t);
  const footer = makeFooter();
  const msg = (usage) => ({ role: "assistant", content: [], stopReason: "stop", responseId: "req-speed", provider: "test-provider", timestamp: 1, usage });
  const delta = (usage, deltaText) => ({
    message: msg(usage),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: deltaText, partial: { content: [] } },
  });
  handlers.get("agent_start")({}, {});
  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  assert.ok(!plain(footer.render(120).join("\n")).includes("tok/s"), "nothing is claimed before a response completes");
  // One streamed delta, then a real generation window, then the confirmed usage.
  handlers.get("message_update")(delta({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, "PCX"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  handlers.get("message_end")({ message: msg({ input: 100, output: 80, cacheRead: 0, cacheWrite: 0 }) });
  const frame = plain(footer.render(120).join("\n"));
  const match = frame.match(/([\d.]+) tok\/s/);
  assert.ok(match, `footer shows a measured rate: ${JSON.stringify(frame)}`);
  assert.ok(Number(match[1]) > 20 && Number(match[1]) < 2000, `80 tokens over ~0.4s is plausible (got ${match[1]})`);
  assert.ok(frame.indexOf("tok/s") > frame.indexOf("↑"), "rate follows the requested context → I/O → cache order");
  // Live path: a provider that streams cumulative usage updates the same formula.
  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")(delta({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "x"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  handlers.get("message_update")(delta({ input: 0, output: 40, cacheRead: 0, cacheWrite: 0 }, "y"));
  const live = plain(footer.render(120).join("\n")).match(/([\d.]+) tok\/s/);
  assert.ok(live && Number(live[1]) > 20, `live rate mid-stream from cumulative usage (got ${live?.[1]})`);
  handlers.get("message_end")({ message: msg({ input: 0, output: 44, cacheRead: 0, cacheWrite: 0 }) });
  const settled = plain(footer.render(120).join("\n")).match(/([\d.]+) tok\/s/);
  assert.ok(settled, "the measured rate persists after the response settles");
});

test("editor factory: surface mode replaces borders; legacy mode keeps accent border", () => {
  class ObservedEditor extends CustomEditor {
    constructor(...args) { super(...args); this.options = args[3]; }
  }
  const surface = {
    paintRow: (row, width) => `[bg:${width}]${row}`,
    paintGlyph: (text, tone) => `<${tone}>${text}</${tone}>`,
  };
  const editor = nativeEditor({ host: { CustomEditor: ObservedEditor }, surface, promptPrefix: true, placeholder: "Ask anything..." });
  assert.deepEqual(editor.options, { embedWorkingStatus: false, paddingX: 2 });

  // Empty editor: blank surface rows, `> ` prefix, dim placeholder, no ─ border.
  const rows = editor.render(40);
  assert.ok(!rows.join("\n").includes("──"), "no full-width accent border in surface mode");
  assert.ok(rows.every((r) => r.startsWith("[bg:40]")), "every row carries the surface bg");
  assert.match(rows[1], /^\[bg:40\]<accent>><\/accent> /, "first body row prefix `> `");
  assert.match(rows[1], /<dim>Ask anything\.\.\.<\/dim>/, "placeholder on the empty editor");
  const widthOf = (r) => visibleWidth(r.replace(/\[bg:\d+\]|<\/?(accent|dim)>/g, ""));
  for (const row of rows) assert.ok(widthOf(row) <= 40, "no row overflows");
  assert.equal(editor.getText(), "", "getText unchanged by display decorations");

  // Typed text: placeholder gone, text intact, prefix still exactly 2 cells.
  editor.setText("hello");
  const typed = editor.render(40);
  assert.doesNotMatch(typed[1], /Ask anything/);
  assert.match(typed[1], /hello/);
  assert.equal(editor.getText(), "hello");

  // Scroll indicators survive: `↑ N more` on the surface, still no ─ border.
  assert.match(editor.renderTopBorder(40, 3), /↑ 3 more/);
  assert.match(editor.renderBottomBorder(40, 2), /↓ 2 more/);

  // Legacy mode (no surface): accent border stays for unsupported terminals.
  const legacy = nativeEditor();
  assert.match(legacy.render(40).join("\n"), /─{10}/, "legacy border mode intact");
});

test("hardware cursor keeps the exact character under the IME marker", () => {
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const surface = { paintRow: (row) => row, paintGlyph: (text) => text };
  const makeEditor = (withSurface, enabled = true) => nativeEditor({
    surface: withSurface ? surface : undefined, accent: (s) => s,
    hardwareCursor: enabled ? () => () => true : undefined,
  });

  for (const withSurface of [true, false]) {
    const editor = makeEditor(withSurface);
    for (const [text, offset] of [["", 0], ["abc", 1], ["你a", 0], ["👩‍👩‍👦a", 0], ["éa", 0]]) {
      editor.setText(text);
      editor.setCursorCol(offset);
      const rows = editor.render(45);
      const glyph = [...graphemes.segment(text.slice(offset))][0]?.segment ?? " ";
      assert.ok(rows[1].includes(`${CURSOR_MARKER}${glyph}\x1b[0m`), "original glyph remains at native IME marker");
      assert.doesNotMatch(rows[1], /\x1b\[7m/, "no inverse-video block remains while focused");
      assert.equal(visibleWidth(rows[1]), 45, "same physical row width even for wide/combined graphemes");
      assert.equal(editor.getText(), text, "draft content unchanged");
      if (text === "" && withSurface) assert.match(rows[1], / \x1b\[0mAsk anything\.\.\./, "placeholder follows cursor cell");
    }
    editor.focused = false;
    assert.doesNotMatch(editor.render(45)[1], /▏/, "inactive editor does not paint a fake caret");
  }
  const fallback = makeEditor(true, false);
  fallback.setText("world");
  fallback.setCursorCol(3);
  assert.ok(fallback.render(45)[1].includes(`${CURSOR_MARKER}\x1b[7ml\x1b[0m`), "without hardware support the native character and block remain");
});

test("editor factory: the composer forces the completion query for a second skill trigger", () => {
  const calls = { triggers: 0 };
  // Count only the extension's forced query, not the native input handler's
  // own autocomplete attempts. Editing/cursor movement remain real host code.
  class CompletionProbe extends CustomEditor {
    showing = false;
    handleInput(data) {
      this.nativeInput = true;
      try { super.handleInput(data); }
      finally { this.nativeInput = false; }
    }
    tryTriggerAutocomplete() { if (!this.nativeInput) calls.triggers += 1; }
    isShowingAutocomplete() { return this.showing; }
  }
  const host = { CustomEditor: CompletionProbe };
  const editor = nativeEditor({ host, skillTrigger: true });

  // Only later skill-token slashes force the query; first tokens and a live
  // menu remain the host's responsibility. Counts are cumulative.
  for (const [text, key, showing, queries] of [
    ["", "/", false, 0],
    ["hello ", "/", false, 0],
    ["see src/", "/", false, 0],
    ["hello /skill:alpha ", "/", false, 0],
    ["/skill:alpha ", "/", false, 1],
    ["￥alpha ", "/", false, 2],
    ["/skill:alpha /skill:beta ", "/", false, 3],
    ["/skill:alpha ", "/", true, 3],
    ["/skill:alpha ", "x", false, 3],
  ]) {
    editor.setText(text);
    editor.showing = showing;
    editor.handleInput(key);
    assert.equal(calls.triggers, queries, `${JSON.stringify(text)} + ${key}, menu=${showing}`);
  }
  const plain = nativeEditor({ host });
  plain.setText("/skill:alpha ");
  plain.handleInput("/");
  assert.equal(calls.triggers, 3, "hook is opt-in");
});

test("Working widget: above-editor placement, Codex format, native loader hidden", async (t) => {
  const { handlers, slots } = await session(t);
  assert.ok(slots.widgetCalls.some((c) => c.key === "metis-pi:working"), "widget key registered");
  assert.equal(slots.workingVisible.at(-1), false, "native loader hidden only after widget install");

  handlers.get("agent_start")({}, {});
  const installCall = widgetByKey(slots, "metis-pi:working");
  assert.ok(installCall, "widget shown for the active interaction");
  assert.deepEqual(installCall.options, { placement: "aboveEditor" });

  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")({
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: { content: [{ type: "thinking" }] } },
  });
  handlers.get("tool_execution_start")({ toolCallId: "t1", toolName: "bash", args: {} }, { cwd: "/tmp" });
  const component = installCall.content({ requestRender() {} }, { fg: (_k, t) => t });
  const frame = plain(component.render(100).join("\n"));
  assert.match(frame, /• Working \(\d+s · thinking \d+s · esc to interrupt\)/, "Codex status rhythm with dual timers");
  assert.match(frame, /· bash$/, "active tool inline after the parens");
  handlers.get("message_update")({
    message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "x" }] } },
  });
  const afterThink = plain(component.render(100).join("\n"));
  assert.match(afterThink, /thought for \d+s/, "closed thinking switches to 'thought for'");
  handlers.get("tool_execution_end")({ toolCallId: "t1", toolName: "bash", result: {}, isError: false });
  handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason: "stop", usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } });
  handlers.get("agent_settled")({}, {});
  assert.equal(slots.widgetCalls.at(-1).content, undefined, "widget cleared at settle");
  assert.equal(slots.statuses.get("metis-pi:summary"), undefined, "persist=true → CustomEntry path");
});

for (const [stopReason, expected] of [["stop", "completed"], ["error", "failed"], ["aborted", "interrupted"], ["length", "incomplete"]]) {
  test(`outcome through real handlers: ${stopReason} → ${expected}`, async (t) => {
    const appended = [];
    const { handlers, slots } = await session(t, {
      api: { appendEntry: (type, data) => appended.push({ type, data }), registerEntryRenderer: () => {}, registerCommand: () => {} },
    });
    handlers.get("agent_start")({}, {});
    handlers.get("message_start")({ message: { role: "assistant", content: [] } });
    if (stopReason === "stop") {
      handlers.get("tool_execution_start")({ toolCallId: "t1", toolName: "bash", args: {} }, { cwd: "/tmp" });
      handlers.get("tool_execution_end")({ toolCallId: "t1", toolName: "bash", result: {}, isError: true });
    }
    handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
    handlers.get("agent_settled")({}, {});
    assert.equal(appended.length, 1, `one summary for ${stopReason}`);
    assert.equal(appended[0].data.outcome, expected, `${stopReason} → ${expected}`);
    assert.equal(appended[0].data.toolErrorsObserved, stopReason === "stop" ? 1 : 0, "tool errors are diagnostic, not a Failed verdict");
    assert.equal(slots.widgetCalls.at(-1).content, undefined);
  });
}

test("usage dedup through real handlers: preview replaces, final confirms once", async (t) => {
  const { handlers, footer: makeFooter } = await session(t, {}, { sessionManager: { getEntries: () => [] } });
  const footer = makeFooter();
  handlers.get("agent_start")({}, {});
  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  const msg = (usage) => ({ role: "assistant", content: [], stopReason: "stop", responseId: "req-1", provider: "test-provider", timestamp: 1, usage });
  // Streaming previews are cumulative snapshots — the second replaces the
  // first (asserted at the interaction level by ui-metrics tests).
  handlers.get("message_update")({ message: msg({ input: 800, output: 10, cacheRead: 100, cacheWrite: 0 }), assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: { content: [] } } });
  handlers.get("message_update")({ message: msg({ input: 900, output: 20, cacheRead: 200, cacheWrite: 0 }), assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: { content: [] } } });
  handlers.get("message_end")({ message: msg({ input: 100, output: 100, cacheRead: 900, cacheWrite: 0 }) });
  handlers.get("message_end")({ message: msg({ input: 100, output: 100, cacheRead: 900, cacheWrite: 0 }) }); // duplicate completion
  handlers.get("agent_settled")({}, {});
  const finalFrame = plain(footer.render(140).join("\n"));
  assert.ok(finalFrame.includes("↑100"), "session Σ input = 100 (once)");
  assert.ok(finalFrame.includes("↓100"), "session Σ output = 100 (once)");
  // The session Σ cache counters are no longer rendered (0.15.0); the same
  // confirmed record still has to dedup, and 90% only holds when the duplicate
  // message_end REPLACED the streaming previews' 200 instead of appending.
  assert.ok(finalFrame.includes("cache 90%"), "cache(last) = 900/(100+900) per the spec formula");
});

test("config kill-switch: enabled=false disables chrome and summary", async () => {
  const { loadConfig } = await import("../../src/config.ts");
  const { config } = loadConfig("/agent", () => JSON.stringify({ enabled: false }));
  assert.equal(config.enabled, false);
});

test("header component: real identity, never impersonates OpenAI", async () => {
  const { createHeaderComponent } = await import("../../src/chrome/header.ts");
  const deps = {
    appearanceVersion: "0.8.5",
    piVersion: "0.85.1",
    getModel: () => ({ id: "test-model" }),
    getCwd: () => "/tmp/proj",
  };
  const component = createHeaderComponent(deps, { fg: (_k, t) => t });
  const joined = component.render(80).join("\n");
  assert.ok(joined.includes("metis-pi"), "own identity shown");
  assert.ok(joined.includes("test-model"), "real model id shown");
  assert.ok(!/OpenAI/i.test(joined), "never claims OpenAI");
});

/** Real repo: one tracked edit (−1/+2) plus one untracked file (+2). */
function makeRepo(t) {
  const dir = temporaryDirectory(t, "metis-pi-chrome-");
  const git = (...args) => execFileSync("git", args, {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "tracked.txt"), "one\ntwo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

/** Work done by the SESSION (after session_start), which is what the footer
 * reports: +2 −1 in a tracked file plus a 2-line untracked file. */
function dirtyRepo(dir) {
  writeFileSync(join(dir, "tracked.txt"), "one\nthree\nfour\n");
  writeFileSync(join(dir, "new.txt"), "x\ny\n");
}

test("footer: real git changes reach the frame in the diff's green/red", async (t) => {
  const repo = makeRepo(t);
  const { slots, footer } = await session(t, { colorLevel: { kind: "truecolor" } }, { cwd: repo });
  assert.ok(slots.footerFactories.length > 0, "footer installed");
  const frame = () => footer({ getGitBranch: () => "main" }).render(140).join("\n");

  assert.ok(!plain(frame()).includes(" +"), "a clean session start shows no change segment");
  // The sample read is async; this case only proves the frame plumbing
  // (snapshot → segment → diff colors), so send edits in two waves: whichever
  // wave the first published read sees, both signs (+ and −) must arrive
  // painted. Exact counts are pinned by the git-changes unit tests.
  dirtyRepo(repo); // wave 1: tracked rewrite (+2 −1) + untracked script (+2)
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync( // wave 2: swap a line and extend the file (+2 −1 over wave 1)
    join(repo, "tracked.txt"),
    readFileSync(join(repo, "tracked.txt"), "utf8").replace("nine", "ten") + "eleven\n",
  );
  const deadline = Date.now() + 6_000;
  let rendered = frame();
  while ((!rendered.includes("\x1b[32m") || !plain(rendered).match(/\(main\) \+\d+ -\d+/)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    rendered = frame();
  }
  assert.match(plain(rendered), /\(main\) \+\d+ -\d+/, "a change segment rides with the branch");
  assert.ok(rendered.includes("\x1b[32m +"), "additions paint the diff green");
  assert.ok(rendered.includes("\x1b[31m -"), "deletions paint the diff red");
});
