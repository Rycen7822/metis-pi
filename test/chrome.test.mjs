// chrome.test.mjs — chrome-level tests with REAL host data shapes: the exact
// field names Pi 0.85.1 provides (model.id/name/provider/contextWindow,
// ctx.thinkingLevel, ctx.getContextUsage() = {tokens, contextWindow, percent},
// Usage = {input, output, cacheRead, cacheWrite, cost.total}).
// Fake interfaces that merely mirror the plugin's own assumptions are
// forbidden here — that pattern let 0.8.3 ship an empty footer.
//
// Host-dependent tests (real installed host) are gated by hasHost and SKIP —
// a skip is never reported as a pass.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { activate } from "../src/extension.ts";

const PI_ROOT = process.env.PI_HOST_ROOT
  ?? "/home/xu/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent";
const hasHost = existsSync(`${PI_ROOT}/dist/index.js`);

/** Real host data shapes (Pi 0.85.1), per spec 11.1. `ui` deliberately has
 * NO getContextUsage/requestRender — those are not ui-surface methods. */
function realShapeCtx(overrides = {}) {
  const usage = [];
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
    usage,
  };
}

/** Two completed requests (spec 11.2): session Σ 5000/300/10000/0,
 * cache(last) = 20.0%, cache(session) = 66.7%. */
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
    appearanceVersion: "0.8.4-test",
    piVersion: "0.85.1-test",
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

test("host availability gate", () => {
  assert.equal(typeof hasHost, "boolean");
});

test("chrome modules have no direct host imports (src/ rule)", () => {
  for (const name of ["chrome/editor.ts", "chrome/footer.ts", "chrome/header.ts", "chrome/working.ts"]) {
    const text = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.ok(!text.includes("from \"@earendil-works"), `${name} must not import host packages directly`);
    assert.ok(!text.includes("from '@earendil-works"), `${name} must not import host packages directly`);
  }
});

test("editor factory: paddingX 2, embedWorkingStatus FALSE, accent painter", async () => {
  const { makeCodexEditorFactory } = await import("../src/chrome/editor.ts");
  const created = [];
  class FakeCustomEditor {
    constructor(_tui, _theme, _keybindings, options) {
      this.options = options;
      this.borderColor = (s) => `gray(${s})`;
      created.push(this);
    }
  }
  const factory = makeCodexEditorFactory({ host: { CustomEditor: FakeCustomEditor } });
  const editor = factory({}, {}, {});
  assert.equal(created.length, 1);
  // 0.8.4: the Working line lives in the above-editor widget — NEVER the border.
  assert.deepEqual(editor.options, { embedWorkingStatus: false, paddingX: 2 });
  const painted = editor.borderColor("────");
  assert.match(painted, /────/);
  assert.match(painted, /\x1b\[38;2;148;226;213m|\x1b\[38;5;/);
});

test("extension event surface includes lifecycle, model/effort and structure events", async () => {
  const source = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
  for (const token of ['"agent_start"', '"agent_end"', '"agent_settled"', '"model_select"',
    '"thinking_level_select"', '"session_tree"', '"session_compact"',
    '"message_start"', '"message_end"', '"tool_execution_end"', '"session_shutdown"',
    "setWidget", "setWorkingVisible"]) {
    assert.ok(source.includes(token), `${token} wired`);
  }
  // Public-API-only restore: identity-tracked editor factory, widget cleared.
  assert.ok(source.includes("chrome.editorFactory"), "factory identity tracked");
  assert.ok(source.includes("ui.getEditorComponent?.() === chrome.editorFactory"), "identity-compared restore");
  assert.ok(!source.includes("registerTool"), "no registerTool");
  assert.ok(!source.includes("setActiveTools"), "no setActiveTools");
});

test("config kill-switch: enabled=false disables chrome and summary", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const { config } = loadConfig("/agent", () => JSON.stringify({ enabled: false }));
  assert.equal(config.enabled, false);
});

test("header component: real identity, never impersonates OpenAI", async () => {
  const { createHeaderComponent } = await import("../src/chrome/header.ts");
  const deps = {
    appearanceVersion: "0.8.4",
    piVersion: "0.85.1",
    getModel: () => ({ id: "test-model" }),
    getCwd: () => "/tmp/proj",
  };
  const component = createHeaderComponent(deps, { fg: (_k, t) => t });
  const lines = component.render(80);
  const joined = lines.join("\n");
  assert.ok(joined.includes("codex-appearance"), "own identity shown");
  assert.ok(joined.includes("test-model"), "real model id shown");
  assert.ok(!/OpenAI/i.test(joined), "never claims OpenAI");
});

test("REAL shape → activation → footer: model/effort/provider/context/session all visible", async (t) => {
  const { handlers, slots, wrapUi } = activateHarness();
  const { ctx } = realShapeCtx();
  const wrapped = wrapUi(ctx);
  handlers.get("session_start")({}, wrapped);
  await tick();
  assert.equal(slots.footerFactories.length, 1, "footer factory installed via public API");
  const footer = slots.footerFactories[0](
    { requestRender() {} },
    { fg: (_k, text) => text },
    { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
  );
  const frame = footer.render(120).join("\n");
  assert.ok(frame.includes("test-model"), "real model id");
  assert.ok(frame.includes("high"), "real thinking level");
  assert.ok(frame.includes("test-provider"), "real provider");
  assert.ok(frame.includes("172k/1.0M"), "context tokens/capacity");
  assert.ok(frame.includes("17.2%"), "context percent");
  assert.ok(frame.includes("↑5.0k"), "session input Σ (5000)");
  assert.ok(frame.includes("↓300"), "session output Σ (300)");
  assert.ok(frame.includes("cache(last) 20%"), "last-request cache rate = 20.0%");
  assert.ok(frame.includes("R10k"), "cacheRead Σ");
  await t.test("footer updates after a live model switch without restart", () => {
    // Mutate through the bound context (a live host ctx swaps its model
    // object in place; the bridge must never hold a session_start copy).
    wrapped.model = { id: "switched-model", provider: "other-provider", contextWindow: 2_000_000 };
    wrapped.getContextUsage = () => ({ tokens: 172_000, contextWindow: 2_000_000, percent: 8.6 });
    handlers.get("model_select")({ type: "model_select" });
    const after = footer.render(120).join("\n");
    assert.ok(after.includes("switched-model"), "new model id visible");
    assert.ok(after.includes("other-provider"), "new provider visible");
    assert.ok(after.includes("2.0M"), "new capacity visible");
    assert.ok(after.includes("8.6%"), "new percent visible — same revision, no old-window mixing");
  });
});

test("footer: name-only model still shows id; off effort is explicit", async () => {
  const { createFooterComponent } = await import("../src/chrome/footer.ts");
  const snapshot = {
    model: { id: "glm-5.3-flash" },
    thinkingLevel: "off",
    contextUsage: { tokens: null, contextWindow: 1_000_000, percent: null },
    cwd: "/tmp/proj",
    session: undefined,
    cacheLastPct: null,
    cacheSessionPct: null,
    revision: 1,
  };
  const footer = createFooterComponent(
    { getSnapshot: () => snapshot, requestRender() {} },
    undefined,
    { fg: (_k, t) => t },
  );
  const frame = footer.render(100).join("\n");
  assert.ok(frame.includes("glm-5.3-flash"), "id shown without name");
  assert.ok(frame.includes("off"), "'off' effort shown explicitly");
  assert.ok(frame.includes("ctx —/1.0M"), "unknown tokens render —, capacity still real");
  assert.doesNotMatch(frame, /undefined|NaN/);
});

test("footer layout is width-responsive and never overflows (40/60/80/120/160 + 0/1/2)", async () => {
  const { layoutFooter } = await import("../src/chrome/footer.ts");
  const snapshot = {
    model: { id: "a-very-long-model-name-for-layout", provider: "a-rather-long-provider-name" },
    thinkingLevel: "high",
    contextUsage: { tokens: 172_000, contextWindow: 1_000_000, percent: 17.2 },
    cwd: "/home/xu/projects/codex_workspace",
    session: { input: 205_000, output: 19_200, cacheRead: 1_600_000, cacheWrite: 0, costTotal: 0.42 },
    cacheLastPct: 98.4,
    cacheSessionPct: 88.1,
    revision: 1,
  };
  const show = { details: true, showCache: true, showCost: true };
  const widthOf = (text) => {
    let w = 0;
    for (const ch of text.replace(/\x1b\[[0-9;]*m/g, "")) {
      const code = ch.codePointAt(0) ?? 0;
      w += (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60) ? 2 : 1;
    }
    return w;
  };
  for (const width of [40, 60, 80, 120, 160]) {
    const rows = layoutFooter(snapshot, show, width, "main");
    assert.ok(rows.length >= 2, `width ${width}: detail rows exist`);
    for (const row of rows) {
      assert.ok(widthOf(row.map((s) => s.text).join("")) <= width, `width ${width}: no overflow`);
    }
    const flat = rows.map((r) => r.map((s) => s.text).join("")).join("\n");
    assert.ok(flat.includes("a-very-long-model-name-for-layout"), `width ${width}: model kept`);
    assert.ok(flat.includes("ctx"), `width ${width}: context kept`);
    assert.ok(flat.includes("↑205k") && flat.includes("↓19.2k"), `width ${width}: session tokens kept`);
  }
  // Wide: single rows with both sides; narrow: stats wrapped, still present.
  const wide = layoutFooter(snapshot, show, 160, "main");
  assert.equal(wide.length, 2, "wide: exactly two detail rows");
  const tiny = layoutFooter(snapshot, show, 0, "main");
  assert.deepEqual(tiny, [], "0 columns: hidden, no crash");
  assert.deepEqual(layoutFooter(snapshot, show, 1, "main"), []);
  assert.deepEqual(layoutFooter(snapshot, show, 2, "main"), []);
  // Regaining width restores the stats.
  const restored = layoutFooter(snapshot, show, 120, "main");
  assert.ok(restored.map((r) => r.map((s) => s.text).join("")).join("\n").includes("cache(last) 98.4%"));
});

test("Working widget: above-editor placement, dual timers, tool segment, native loader hidden", async () => {
  const { handlers, slots, wrapUi } = activateHarness();
  const { ctx } = realShapeCtx();
  handlers.get("session_start")({}, wrapUi(ctx));
  await tick();
  // Install registers the namespaced key (hidden while idle) and hides the
  // native loader only AFTER the widget path succeeded.
  assert.ok(slots.widgetCalls.some((c) => c.key === "pi-codex-appearance:working"), "widget key registered");
  assert.equal(slots.workingVisible.at(-1), false, "native loader hidden only after widget install");

  // Interaction: agent_start opens the clock and shows the widget; tool
  // events feed the segments.
  handlers.get("agent_start")({}, {});
  const installCall = slots.widgetCalls.find((c) => c.content !== undefined);
  assert.ok(installCall, "widget shown for the active interaction");
  assert.deepEqual(installCall.options, { placement: "aboveEditor" });
  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")({
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: { content: [{ type: "thinking" }] } },
  });
  handlers.get("tool_execution_start")({ toolCallId: "t1", toolName: "bash", args: {} }, { cwd: "/tmp" });
  const component = installCall.content({ requestRender() {} }, { fg: (_k, t) => t });
  const frame = component.render(100).join("\n");
  assert.match(frame, /Working…/, "stable message");
  assert.match(frame, /bash/, "active tool by name");
  assert.match(frame, /thinking \d+s/, "open thinking grows in real time");
  await tick();
  const frame2 = component.render(100).join("\n");
  assert.match(frame2, /thinking \d+s/);
  handlers.get("tool_execution_end")({ toolCallId: "t1", toolName: "bash", result: {}, isError: false });
  handlers.get("message_update")({
    message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "x" }] } },
  });
  handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason: "stop", usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } });
  handlers.get("agent_settled")({}, {});
  const hidden = slots.widgetCalls.at(-1);
  assert.equal(hidden.content, undefined, "widget cleared at settle");
  const summaryFrame = slots.statuses.get("pi-codex-appearance:summary");
  // persist defaults true → CustomEntry path, not the status path.
  assert.equal(summaryFrame, undefined);
});

test("outcome through REAL handlers: mid-run tool error then clean stop = Worked (not Failed)", async () => {
  const { handlers, slots, wrapUi } = activateHarness();
  const appended = [];
  // Re-activate with an appendEntry-capable api binding.
  const { handlers: h2, slots: s2, wrapUi: w2 } = activateHarness({
    api: {
      appendEntry: (type, data) => appended.push({ type, data }),
      registerEntryRenderer: () => {},
      registerCommand: () => {},
    },
  });
  void handlers; void slots; void wrapUi;
  const { ctx } = realShapeCtx();
  h2.get("session_start")({}, w2(ctx));
  await tick();
  h2.get("agent_start")({}, {});
  h2.get("message_start")({ message: { role: "assistant", content: [] } });
  // A validator fails mid-run …
  h2.get("tool_execution_start")({ toolCallId: "t1", toolName: "bash", args: {} }, { cwd: "/tmp" });
  h2.get("tool_execution_end")({ toolCallId: "t1", toolName: "bash", result: {}, isError: true });
  // … then the run continues and finishes normally.
  h2.get("message_end")({ message: { role: "assistant", content: [], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } });
  h2.get("agent_settled")({}, {});
  assert.equal(appended.length, 1, "exactly one summary entry");
  const data = appended[0].data;
  assert.equal(data.outcome, "completed", "mid-run tool error must not brand the run Failed");
  assert.equal(data.toolErrorsObserved, 1, "tool error kept as a diagnostic count");
  // Widget hidden after settle, native row stays hidden until shutdown.
  assert.equal(s2.widgetCalls.at(-1).content, undefined);
});

test("outcome: provider error = Failed; user abort = Interrupted", async () => {
  for (const [stopReason, expected] of [["error", "failed"], ["aborted", "interrupted"], ["length", "incomplete"]]) {
    const appended = [];
    const { handlers, wrapUi } = activateHarness({
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
    handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
    handlers.get("agent_settled")({}, {});
    assert.equal(appended.length, 1, `one summary for ${stopReason}`);
    assert.equal(appended[0].data.outcome, expected, `${stopReason} → ${expected}`);
    assert.equal(appended[0].data.evidence, `assistant-${stopReason === "length" ? "length" : stopReason}`);
  }
});

test("usage dedup through real handlers: preview replaces, final confirms once, duplicates don't double-count", async () => {
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
  const widgetCall = () => slots.widgetCalls.find((c) => c.content !== undefined);
  const widgetFrame = () => widgetCall().content({ requestRender() {} }, { fg: (_k, t) => t }).render(120).join("\n");
  handlers.get("message_start")({ message: { role: "assistant", content: [] } });
  const msg = (usage) => ({ role: "assistant", content: [], stopReason: "stop", responseId: "req-1", provider: "test-provider", timestamp: 1, usage });
  // Streaming previews are CUMULATIVE snapshots: the second replaces the first.
  handlers.get("message_update")({ message: msg({ input: 800, output: 10, cacheRead: 100, cacheWrite: 0 }), assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: { content: [] } } });
  handlers.get("message_update")({ message: msg({ input: 900, output: 20, cacheRead: 200, cacheWrite: 0 }), assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: { content: [] } } });
  assert.ok(widgetFrame().includes("↑900"), "preview shows the cumulative snapshot, never summed deltas");
  // Final confirms once; a duplicate completion of the same request does not add.
  handlers.get("message_end")({ message: msg({ input: 100, output: 100, cacheRead: 900, cacheWrite: 0 }) });
  handlers.get("message_end")({ message: msg({ input: 100, output: 100, cacheRead: 900, cacheWrite: 0 }) });
  assert.ok(widgetFrame().includes("↑100"), "interaction tokens confirm once (no double-count)");
  handlers.get("agent_settled")({}, {});
  const finalFrame = footer.render(120).join("\n");
  assert.ok(finalFrame.includes("↑100"), "session Σ input = 100 (once)");
  assert.ok(finalFrame.includes("↓100"), "session Σ output = 100 (once)");
  assert.ok(finalFrame.includes("R900"), "session Σ cacheRead = 900 (once)");
  assert.ok(finalFrame.includes("cache(last) 90%"), "cache(last) = 900/(100+900) per the spec formula");
});
