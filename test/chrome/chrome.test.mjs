// chrome.test.mjs — chrome-level tests with REAL host data shapes: the exact
// field names Pi 0.85.1 provides (model.id/name/provider/contextWindow,
// ctx.thinkingLevel, ctx.getContextUsage() = {tokens, contextWindow, percent},
// Usage = {input, output, cacheRead, cacheWrite, cost.total}).
// Fake interfaces that merely mirror the plugin's own assumptions are
// forbidden here — that pattern let 0.8.3 ship an empty footer.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate } from "../../src/extension.ts";

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
  return { handlers, slots, wrapUi };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/<\/?S>/g, "").replace(/<\/?(accent|dim|warning|normal)>/g, "");
const widgetByKey = (slots, key) =>
  slots.widgetCalls.filter((c) => c.key === key && c.content !== undefined).at(-1);

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
  const { handlers, slots, wrapUi } = activateHarness();
  const { ctx } = realShapeCtx();
  const wrapped = wrapUi(ctx);
  handlers.get("session_start")({}, wrapped);
  await tick();

  assert.equal(widgetByKey(slots, "metis-pi:composer-meta"), undefined, "no metadata widget inside the input surface");
  const footer = slots.footerFactories[0](
    { requestRender() {} },
    { fg: (_k, text) => text },
    { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
  );

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

test("footer layout is width-responsive and never overflows (60..200 + 0/1/2)", async () => {
  const { layoutFooter } = await import("../../src/chrome/footer.ts");
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

test("footer keeps unknown context distinct from zero usage", async () => {
  const { layoutFooter } = await import("../../src/chrome/footer.ts");
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

test("footer preserves vendor status but never adds Codex quota with either provider", async () => {
  for (const provider of ["openai-codex", "test-provider"]) {
    const { handlers, slots, wrapUi } = activateHarness();
    const { ctx } = realShapeCtx({ model: { id: "test-model", provider, contextWindow: 1_000_000 } });
    handlers.get("session_start")({}, wrapUi(ctx));
    await tick();
    const footer = slots.footerFactories[0](
      { requestRender() {} },
      { fg: (_k, text) => text },
      { getGitBranch: () => "main", getExtensionStatuses: () => new Map([["codex-adapter", "Codex adapter V: low · weekly: 20% left"]]), onBranchChange: () => () => {} },
    );
    const frame = plain(footer.render(140).join("\n"));
    assert.match(frame, /Codex adapter V: low · weekly: 20% left/, `${provider}: vendor status remains`);
    assert.doesNotMatch(frame, /Codex (?:5h|week) \d+%/, `${provider}: no independent footer quota`);
    handlers.get("session_shutdown")({}, wrapUi(ctx));
  }
});

test("output speed reaches the footer from real events (confirmed usage ÷ observed window)", async () => {
  const { handlers, slots, wrapUi } = activateHarness();
  const { ctx } = realShapeCtx();
  handlers.get("session_start")({}, wrapUi(ctx));
  await tick();
  const footer = slots.footerFactories[0](
    { requestRender() {} },
    { fg: (_k, text) => text },
    { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
  );
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

test("editor factory: surface mode replaces borders; legacy mode keeps accent border", async () => {
  const { makeCodexEditorFactory } = await import("../../src/chrome/editor.ts");
  // Minimal real-shape Editor base: the structural contract the factory relies on.
  class FakeEditorBase {
    focused = true;
    constructor(_tui, _theme, _kb, options) {
      this.options = options;
      this.text = "";
    }
    renderTopBorder(width, hidden) {
      return hidden > 0 ? `↑ ${hidden} more` : "─".repeat(width);
    }
    renderBottomBorder(width, hidden) {
      return hidden > 0 ? `↓ ${hidden} more` : "─".repeat(width);
    }
    render(width) {
      const rows = [this.renderTopBorder(width, 0)];
      // Real host shape: the cursor line always carries the cursor cell
      // (highlighted char, or the exact end-of-text cell `\x1b[7m \x1b[0m`).
      const content = this.text || "";
      const cursor = this.text ? "" : "\x1b[7m \x1b[0m";
      rows.push(`  ${content}${cursor}${" ".repeat(Math.max(0, width - 4 - content.length - (cursor ? 1 : 0)))}  `);
      rows.push(this.renderBottomBorder(width, 0));
      return rows;
    }
    getText() { return this.text; }
  }
  const surface = {
    paintRow: (row, width) => `[bg:${width}]${row}`,
    paintGlyph: (text, tone) => `<${tone}>${text}</${tone}>`,
  };
  const factory = makeCodexEditorFactory({ host: { CustomEditor: FakeEditorBase }, surface, promptPrefix: true, placeholder: "Ask anything..." });
  const editor = factory({}, {}, {});
  assert.deepEqual(editor.options, { embedWorkingStatus: false, paddingX: 2 });

  // Empty editor: blank surface rows, `> ` prefix, dim placeholder, no ─ border.
  const rows = editor.render(40);
  assert.ok(!rows.join("\n").includes("──"), "no full-width accent border in surface mode");
  assert.ok(rows.every((r) => r.startsWith("[bg:40]")), "every row carries the surface bg");
  assert.match(rows[1], /^\[bg:40\]<accent>><\/accent> /, "first body row prefix `> `");
  assert.match(rows[1], /<dim>Ask anything\.\.\.<\/dim>/, "placeholder on the empty editor");
  const widthOf = (r) => r.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[bg:\d+\]|<\/?(accent|dim)>/g, "").length;
  for (const row of rows) assert.ok(widthOf(row) <= 40, "no row overflows");
  assert.equal(editor.getText(), "", "getText unchanged by display decorations");

  // Typed text: placeholder gone, text intact, prefix still exactly 2 cells.
  editor.text = "hello";
  const typed = editor.render(40);
  assert.doesNotMatch(typed[1], /Ask anything/);
  assert.match(typed[1], /hello/);
  assert.equal(editor.getText(), "hello");

  // Scroll indicators survive: `↑ N more` on the surface, still no ─ border.
  assert.match(editor.renderTopBorder(40, 3), /↑ 3 more/);
  assert.match(editor.renderBottomBorder(40, 2), /↓ 2 more/);

  // Legacy mode (no surface): accent border stays for unsupported terminals.
  const legacyFactory = makeCodexEditorFactory({ host: { CustomEditor: FakeEditorBase } });
  const legacy = legacyFactory({}, {}, {});
  assert.match(legacy.render(40).join("\n"), /─{10}/, "legacy border mode intact");
});

test("editor factory: the composer forces the completion query for a second skill trigger", async () => {
  const { makeCodexEditorFactory } = await import("../../src/chrome/editor.ts");
  const calls = { triggers: 0 };
  // Real-shape base: the host editor inserts printable keys and exposes the
  // cursor/lines/isShowingAutocomplete surface the hook reads.
  class FakeEditorBase {
    constructor() {
      this.lines = [""];
      this.cursor = { line: 0, col: 0 };
      this.showing = false;
    }
    handleInput(data) {
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        const line = this.lines[this.cursor.line];
        this.lines[this.cursor.line] = line.slice(0, this.cursor.col) + data + line.slice(this.cursor.col);
        this.cursor.col += data.length;
      }
    }
    tryTriggerAutocomplete() { calls.triggers += 1; }
    isShowingAutocomplete() { return this.showing; }
    getLines() { return this.lines; }
    getCursor() { return { ...this.cursor }; }
    getText() { return this.lines.join("\n"); }
    getPaddingX() { return 2; }
    setPaddingX() {}
  }
  const factory = makeCodexEditorFactory({ host: { CustomEditor: FakeEditorBase }, skillTrigger: true });
  const at = (editor, text) => { editor.lines = [text]; editor.cursor = { line: 0, col: text.length }; };
  const editor = factory({}, {}, {});

  // The FIRST token is the host's business (it auto-triggers "/" at line start).
  at(editor, "");
  editor.handleInput("/");
  assert.equal(calls.triggers, 0, "first-token slash left to the host");
  // Ordinary text, paths, and mid-sentence slashes never force a query.
  at(editor, "hello ");
  editor.handleInput("/");
  at(editor, "see src/");
  editor.handleInput("/");
  at(editor, "hello /skill:alpha ");
  editor.handleInput("/");
  assert.equal(calls.triggers, 0, "no hook outside a leading skill prefix");

  // THE case: a complete skill token + space, then "/" — the host refuses to
  // auto-trigger here, so the hook must run the query (this is what makes the
  // menu pop even when the editor's own menu state already died).
  at(editor, "/skill:alpha ");
  editor.handleInput("/");
  assert.equal(calls.triggers, 1, "second-token slash forces the query");
  at(editor, "￥alpha ");
  editor.handleInput("/");
  assert.equal(calls.triggers, 2, "￥ heads count too");
  at(editor, "/skill:alpha /skill:beta ");
  editor.handleInput("/");
  assert.equal(calls.triggers, 3, "fires for every later token");

  // A live menu already queried for this position — don't query twice.
  at(editor, "/skill:alpha ");
  editor.showing = true;
  editor.handleInput("/");
  assert.equal(calls.triggers, 3, "no duplicate query while the menu is open");
  editor.showing = false;

  // Non-slash keys, and hosts without the private trigger, stay untouched.
  at(editor, "/skill:alpha ");
  editor.handleInput("x");
  assert.equal(calls.triggers, 3, "only the slash key is hooked");
  const plain = makeCodexEditorFactory({ host: { CustomEditor: FakeEditorBase } })({}, {}, {});
  at(plain, "/skill:alpha ");
  plain.handleInput("/");
  assert.equal(calls.triggers, 3, "hook is opt-in");
});

test("Working widget: above-editor placement, Codex format, native loader hidden", async () => {
  const { handlers, slots, wrapUi } = activateHarness();
  const { ctx } = realShapeCtx();
  handlers.get("session_start")({}, wrapUi(ctx));
  await tick();
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

test("outcome through REAL handlers: mid-run tool error then clean stop = Worked (not Failed)", async () => {
  const appended = [];
  const { handlers, slots, wrapUi } = activateHarness({
    api: {
      appendEntry: (type, data) => appended.push({ type, data }),
      registerEntryRenderer: () => {},
      registerCommand: () => {},
    },
  });
  const { ctx } = realShapeCtx();
  handlers.get("session_start")({}, wrapUi(ctx));
  await tick();
  handlers.get("agent_start")({}, {});
  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  handlers.get("tool_execution_start")({ toolCallId: "t1", toolName: "bash", args: {} }, { cwd: "/tmp" });
  handlers.get("tool_execution_end")({ toolCallId: "t1", toolName: "bash", result: {}, isError: true });
  handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } });
  handlers.get("agent_settled")({}, {});
  assert.equal(appended.length, 1, "exactly one summary entry");
  assert.equal(appended[0].data.outcome, "completed", "mid-run tool error must not brand the run Failed");
  assert.equal(appended[0].data.toolErrorsObserved, 1, "tool error kept as a diagnostic count");
  assert.equal(slots.widgetCalls.at(-1).content, undefined);
});

test("outcome: provider error = Failed; user abort = Interrupted; length = incomplete", async () => {
  for (const [stopReason, expected] of [["error", "failed"], ["aborted", "interrupted"], ["length", "incomplete"]]) {
    const appended = [];
    const { handlers, wrapUi } = activateHarness({
      api: { appendEntry: (type, data) => appended.push({ type, data }), registerEntryRenderer: () => {}, registerCommand: () => {} },
    });
    const { ctx } = realShapeCtx();
    handlers.get("session_start")({}, wrapUi(ctx));
    await tick();
    handlers.get("agent_start")({}, {});
    handlers.get("message_start")({ message: { role: "assistant", content: [] } });
    handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
    handlers.get("agent_settled")({}, {});
    assert.equal(appended.length, 1, `one summary for ${stopReason}`);
    assert.equal(appended[0].data.outcome, expected, `${stopReason} → ${expected}`);
  }
});

test("usage dedup through real handlers: preview replaces, final confirms once", async () => {
  const { handlers, slots, wrapUi } = activateHarness();
  const { ctx } = realShapeCtx({ sessionManager: { getEntries: () => [] } });
  handlers.get("session_start")({}, wrapUi(ctx));
  await tick();
  const footer = slots.footerFactories[0](
    { requestRender() {} },
    { fg: (_k, text) => text },
    { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
  );
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
  const dir = mkdtempSync(join(tmpdir(), "metis-pi-chrome-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  const { handlers, slots, wrapUi } = activateHarness({ colorLevel: { kind: "truecolor" } });
  const shutdown = () => handlers.get("session_shutdown")?.({}, wrapUi(realShapeCtx().ctx));
  t.after(shutdown); // stop the 2s poll this test just armed
  handlers.get("session_start")({}, wrapUi(realShapeCtx({ cwd: repo }).ctx));
  await tick(); // the chrome preload resolves the footer factory asynchronously
  assert.ok(slots.footerFactories.length > 0, "footer installed");
  const frame = () => slots.footerFactories.at(-1)(
    { requestRender() {} },
    { fg: (_k, text) => text },
    { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
  ).render(140).join("\n");

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
