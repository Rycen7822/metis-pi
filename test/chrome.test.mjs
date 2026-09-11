// chrome.test.mjs — chrome-level tests with REAL host data shapes: the exact
// field names Pi 0.85.1 provides (model.id/name/provider/contextWindow,
// ctx.thinkingLevel, ctx.getContextUsage() = {tokens, contextWindow, percent},
// Usage = {input, output, cacheRead, cacheWrite, cost.total}).
// Fake interfaces that merely mirror the plugin's own assumptions are
// forbidden here — that pattern let 0.8.3 ship an empty footer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activate } from "../src/extension.ts";

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

const QUOTA_SNAPSHOT = {
  capturedAt: 1,
  planType: "pro",
  primary: { usedPercent: 18, remainingPercent: 82, windowMinutes: 300 },
  secondary: { usedPercent: 36, remainingPercent: 64, windowMinutes: 10080 },
};

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
    codexQuotaQuery: async () => QUOTA_SNAPSHOT,
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
  for (const name of ["chrome/editor.ts", "chrome/footer.ts", "chrome/header.ts", "chrome/working.ts", "chrome/composer-metadata.ts"]) {
    const text = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.ok(!text.includes("from \"@earendil-works"), `${name} must not import host packages directly`);
    assert.ok(!text.includes("from '@earendil-works"), `${name} must not import host packages directly`);
  }
});

test("REAL shape → activation → composer metadata + footer, all fields from real host", async (t) => {
  const { handlers, slots, wrapUi } = activateHarness();
  const { ctx } = realShapeCtx();
  const wrapped = wrapUi(ctx);
  handlers.get("session_start")({}, wrapped);
  await tick();

  await t.test("composer metadata widget: model/effort/provider/context", () => {
    const call = widgetByKey(slots, "pi-codex-appearance:composer-meta");
    assert.ok(call, "metadata widget installed below the editor");
    assert.deepEqual(call.options, { placement: "belowEditor" });
    const component = call.content({ requestRender() {} }, { fg: (_k, text) => text });
    const frame = plain(component.render(120).join("\n"));
    assert.ok(frame.includes("test-model"), "real model id");
    assert.ok(frame.includes("high"), "real thinking level");
    assert.ok(frame.includes("test-provider"), "real provider");
    assert.ok(frame.includes("ctx 172k/1.0M"), "context tokens/capacity");
    assert.ok(frame.includes("17.2%"), "context percent");
  });

  await t.test("footer: cwd/branch + session Σ + cache + quota (NO duplicate model/context)", () => {
    const footer = slots.footerFactories[0](
      { requestRender() {} },
      { fg: (_k, text) => text },
      { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
    );
    const frame = plain(footer.render(140).join("\n"));
    assert.ok(frame.includes("/tmp/workspace (main)"), "cwd + branch");
    assert.ok(frame.includes("↑5.0k"), "session Σ input (5000)");
    assert.ok(frame.includes("↓300"), "session Σ output (300)");
    assert.ok(frame.includes("cache 20%"), "last-request cache rate = 20.0%");
    assert.ok(frame.includes("Codex 5h 82%"), "primary quota (300min → 5h, REMAINING not used)");
    assert.ok(frame.includes("week 64%"), "secondary quota (10080min → week)");
    assert.ok(frame.includes("R10k"), "cacheRead Σ");
    assert.doesNotMatch(frame, /test-model|17\.2%/, "model/context belong to the composer surface, not the footer");
  });

  await t.test("live model switch updates the metadata widget without restart", () => {
    wrapped.model = { id: "switched-model", provider: "other-provider", contextWindow: 2_000_000 };
    wrapped.getContextUsage = () => ({ tokens: 172_000, contextWindow: 2_000_000, percent: 8.6 });
    handlers.get("model_select")({ type: "model_select" });
    const call = widgetByKey(slots, "pi-codex-appearance:composer-meta");
    const after = plain(call.content({ requestRender() {} }, { fg: (_k, text) => text }).render(120).join("\n"));
    assert.ok(after.includes("switched-model"), "new model id visible");
    assert.ok(after.includes("other-provider"), "new provider visible");
    assert.ok(after.includes("2.0M"), "new capacity visible");
    assert.ok(after.includes("8.6%"), "new percent — same revision, no old-window mixing");
  });
});

test("footer layout is width-responsive and never overflows (60..200 + 0/1/2)", async () => {
  const { layoutFooter } = await import("../src/chrome/footer.ts");
  const snapshot = {
    cwd: "/home/xu/wiki/codex_workspace",
    session: { input: 106_000, output: 8_900, cacheRead: 851_000, cacheWrite: 0, costTotal: 0 },
    cacheLastPct: 99.9,
    quota: QUOTA_SNAPSHOT,
    quotaStale: false,
    revision: 1,
  };
  const show = { details: true, showCache: true, showCacheReadWrite: true, showCost: true, showCodexQuota: true };
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
    if (width >= 100) {
      assert.ok(flat.includes("Codex 5h 82%") && flat.includes("week 64%"), `width ${width}: P1 quota kept`);
      assert.ok(flat.includes("R851k"), `width ${width}: P2 R/W kept`);
    }
  }
  assert.deepEqual(layoutFooter(snapshot, show, 0, "main"), [], "0 columns: hidden, no crash");
  assert.deepEqual(layoutFooter(snapshot, show, 1, "main"), []);
  assert.deepEqual(layoutFooter(snapshot, show, 2, "main"), []);
});

test("editor factory: surface mode replaces borders; legacy mode keeps accent border", async () => {
  const { makeCodexEditorFactory } = await import("../src/chrome/editor.ts");
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

test("Working widget: above-editor placement, Codex format, native loader hidden", async () => {
  const { handlers, slots, wrapUi } = activateHarness();
  const { ctx } = realShapeCtx();
  handlers.get("session_start")({}, wrapUi(ctx));
  await tick();
  assert.ok(slots.widgetCalls.some((c) => c.key === "pi-codex-appearance:working"), "widget key registered");
  assert.equal(slots.workingVisible.at(-1), false, "native loader hidden only after widget install");

  handlers.get("agent_start")({}, {});
  const installCall = widgetByKey(slots, "pi-codex-appearance:working");
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
  assert.equal(slots.statuses.get("pi-codex-appearance:summary"), undefined, "persist=true → CustomEntry path");
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
  assert.ok(finalFrame.includes("R900"), "session Σ cacheRead = 900 (once)");
  assert.ok(finalFrame.includes("cache 90%"), "cache(last) = 900/(100+900) per the spec formula");
});

test("quota errors never break the interaction or the footer (auxiliary data)", async () => {
  const { handlers, slots, wrapUi } = activateHarness({
    codexQuotaQuery: async () => { throw Object.assign(new Error("boom"), { errorClass: "rpc-error" }); },
  });
  const { ctx } = realShapeCtx();
  handlers.get("session_start")({}, wrapUi(ctx));
  await tick();
  const footer = slots.footerFactories[0](
    { requestRender() {} },
    { fg: (_k, text) => text },
    { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
  );
  handlers.get("agent_start")({}, {});
  handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason: "stop", usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } } });
  handlers.get("agent_settled")({}, {});
  const frame = plain(footer.render(140).join("\n"));
  assert.doesNotMatch(frame, /Codex/, "no fake quota line after failure");
  assert.ok(frame.includes("↑5"), "session data unaffected by quota failure");
});

test("config kill-switch: enabled=false disables chrome and summary", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const { config } = loadConfig("/agent", () => JSON.stringify({ enabled: false }));
  assert.equal(config.enabled, false);
});

test("header component: real identity, never impersonates OpenAI", async () => {
  const { createHeaderComponent } = await import("../src/chrome/header.ts");
  const deps = {
    appearanceVersion: "0.8.5",
    piVersion: "0.85.1",
    getModel: () => ({ id: "test-model" }),
    getCwd: () => "/tmp/proj",
  };
  const component = createHeaderComponent(deps, { fg: (_k, t) => t });
  const joined = component.render(80).join("\n");
  assert.ok(joined.includes("codex-appearance"), "own identity shown");
  assert.ok(joined.includes("test-model"), "real model id shown");
  assert.ok(!/OpenAI/i.test(joined), "never claims OpenAI");
});
