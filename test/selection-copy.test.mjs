// selection-copy.test.mjs — provenance copy against the REAL host classes.
// Layers covered here:
//   B. Differential: real Markdown/Text mirror rows vs real host rows across
//      a corpus and widths (mirror builds must not degrade).
//   C. Real TuiAltScreen: real SGR mouse press/motion/release through
//      handleTerminalInput, then the instance serializer + editor Ctrl+C.
// A (pure wrap fixtures) and property tests live in selection-wrap.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

import * as Tui from "@earendil-works/pi-tui";
import { createSelectionCopySystem, detectExternalSerializerPatch } from "../src/selection-copy/index.ts";
import { makeCodexEditorFactory } from "../src/chrome/editor.ts";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

const theme = {
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
  italic: (t) => `\x1b[3m${t}\x1b[23m`,
  underline: (t) => `\x1b[4m${t}\x1b[24m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[29m`,
  heading: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  codeBlockIndent: "  ",
  listBullet: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
};

const SHARED_SYS = createSelectionCopySystem({
  prototypes: {
    Text: Tui.Text.prototype,
    Markdown: Tui.Markdown.prototype,
    Box: Tui.Box.prototype,
    Container: Tui.Container.prototype,
  },
  fns: {
    visibleWidth: Tui.visibleWidth,
    sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences,
    wrapTextWithAnsi: Tui.wrapTextWithAnsi,
    renderLatex: (text, options) => Tui.renderLatex(text, options) ?? null,
  },
}, undefined);
SHARED_SYS.wrapPrototypes();
function makeSystem() {
  return SHARED_SYS;
}

function diagnostics(sys) {
  const d = sys.diagnostics();
  return { degraded: d.mirrors.markdownDegraded + d.mirrors.textDegraded, reason: d.mirrors.lastDegradedReason };
}

// ---------------------------------------------------------------------------
// B. Differential over a corpus: mirror must build for every width, and the
// serialized full-width selection must reproduce the display logical text.
// ---------------------------------------------------------------------------

const CORPUS = [
  ["cjk paragraph", "这是一个很长的中文段落用来测试软折行复制功能当我们把窗口调窄时中文字符会按宽度折行但复制时应该保持为一行逻辑文本。"],
  ["english words", "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon"],
  ["long url", "see https://example.com/very/long/path/that/definitely/exceeds/narrow/terminal/widths/often for details"],
  ["code block", "Title\n\n```python\nprint(\"alpha\")\nif True:\n    print(\"beta\")\n```\n\ndone"],
  ["lists", "- item one\n- item two with a fairly long description that should wrap at narrow widths nicely\n  - nested item\n\n3. ordered three"],
  ["quote", "> quoted wisdom that is long enough to wrap around at this width for sure yes\n> second line"],
  ["inline styles", "normal **bold text** and `code span` and *emphasized* and ~~struck~~ end"],
  ["heading + paragraphs", "# Heading\n\nFirst paragraph with several words.\n\nSecond paragraph follows here."],
];

test("differential: real Markdown mirror builds at every width without degradation", () => {
  const sys = makeSystem();
  sys.wrapPrototypes();
  for (const [name, text] of CORPUS) {
    for (const width of [60, 80, 120, 160]) {
      const md = new Tui.Markdown(text, 1, 1, theme, undefined, {});
      md.render(width);
    }
  }
  const d = diagnostics(sys);
  assert.equal(d.degraded, 0, `mirror degraded: ${d.reason}`);
});

test("differential: real Text mirror builds without degradation", () => {
  const sys = makeSystem();
  sys.wrapPrototypes();
  const text = new Tui.Text("plain text with a reasonably long line to force wrapping at narrow widths", 1, 1);
  for (const width of [40, 60, 100]) text.render(width);
  const d = diagnostics(sys);
  assert.equal(d.degraded, 0, `mirror degraded: ${d.reason}`);
});

test("differential: user message path (Box > Markdown) builds and copies", () => {
  const sys = makeSystem();
  sys.wrapPrototypes();
  const text = "帮我看看这个很长的中文问题在窗口变窄的时候软折行复制是否保持为一行不添加多余换行或空格";
  const content = new Tui.Box(1, 1, (line) => line);
  content.addChild(new Tui.Markdown(text, 0, 0, theme, { color: (t) => t }, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true }));
  const width = 60;
  const rows = content.render(width);
  const d = diagnostics(sys);
  assert.equal(d.degraded, 0, `mirror degraded: ${d.reason}`);
  // Full content selection through the real layout frame.
  const frame = {
    root: { component: content, rect: { x: 0, y: 0, width, height: rows.length }, clip: { x: 0, y: 0, width, height: rows.length }, children: [], lines: rows },
  };
  const result = serializeFrame(frame, rows, 1, rows.length - 2);
  assert.ok(!result.text.includes("\n\n\n"), "no triple newlines");
  assert.ok(result.text.replace(/\n/g, "").includes(text.replace(/\n/g, "").slice(0, 20)), "content present");
});

function serializeFrame(frame, rows, startRow, endRow) {
  return new SelectionSerializer({
    visibleWidth: Tui.visibleWidth,
    sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences,
  }).serialize(frame, {
    scrollView: undefined,
    startRow,
    endRow,
    sourceLines: rows,
    columnsFor: (row) => ({ start: 0, end: Tui.visibleWidth(rows[row] ?? "") }),
  });
}

import { SelectionSerializer } from "../src/selection-copy/serialize.ts";

// ---------------------------------------------------------------------------
// C. Real TuiAltScreen: real SGR mouse sequences → selection → exact copy.
// ---------------------------------------------------------------------------

function fakeTerminal(columns, rows) {
  const writes = [];
  return { columns, rows, write: (s) => writes.push(s), writes };
}

function buildAltScreen(sys, text, width = 80) {
  const terminal = fakeTerminal(width, 24);
  const tui = new Tui.TuiAltScreen(terminal);
  tui.beforeTerminalStart();
  const md = new Tui.Markdown(text, 1, 1, theme, undefined, {});
  const root = new Tui.Container();
  root.addChild(md);
  tui.setLayoutRoot(root);
  tui.doRender();
  assert.ok(sys.installOnTui(tui), "instance serializer must install");
  return { tui, md, terminal };
}

function sgr(button, x, y, release = false) {
  // 1-based screen coords, SGR encoding.
  return `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;
}

test("real TUI: mouse drag selects soft-wrapped CJK paragraph; copy is one logical line", () => {
  const sys = makeSystem();
  sys.wrapPrototypes();
  const text = "这是一个很长的中文段落用来测试软折行复制功能当我们把窗口调窄时中文字符会按宽度折行但复制时应该保持为一行逻辑文本。";
  const { tui } = buildAltScreen(sys, text, 60);
  tui.setCopyOnSelect(false);
  // Find the content rows on screen (paddingY=1 → row 1 is first content row;
  // the paragraph wraps at contentWidth 58).
  const screen = tui.previousScreen.map((line) => Tui.stripTerminalSequences(line).trimEnd());
  const firstRow = screen.findIndex((line) => line.includes("这是一个很长的"));
  const lastRow = screen.findIndex((line) => line.includes("逻辑文本。"));
  assert.ok(firstRow >= 0 && lastRow > firstRow, `expected wrapped CJK rows, got ${JSON.stringify(screen.slice(0, 5))}`);
  const first = { row: firstRow, line: screen[firstRow] };
  const last = { row: lastRow, line: screen[lastRow] };
  // Press at (3, first.row+1) → drag to end of last row → release.
  // SGR mouse coords are 1-based CELL columns — CJK chars are 2 cells wide.
  const startCell = Tui.visibleWidth(first.line.slice(0, first.line.indexOf("这"))) + 1;
  tui.handleTerminalInput(sgr(0, startCell, first.row + 1));
  tui.handleTerminalInput(sgr(32, Tui.visibleWidth(last.line) + 1, last.row + 1));
  tui.handleTerminalInput(sgr(0, Tui.visibleWidth(last.line) + 1, last.row + 1, true));
  assert.equal(tui.hasActiveSelection(), true, "geometry selection active after drag");
  const copied = tui.getActiveSelectionText();
  assert.equal(copied, text, `exact logical text expected, got ${JSON.stringify(copied)}`);
});

test("real TUI: Ctrl+C with selection consumes the key, copies, keeps the draft", () => {
  const sys = makeSystem();
  sys.wrapPrototypes();
  const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
  const { tui } = buildAltScreen(sys, text, 60);
  tui.setCopyOnSelect(false);
  const screen = tui.previousScreen.map((line) => Tui.stripTerminalSequences(line).trimEnd());
  const rowOf = (needle) => screen.findIndex((line) => line.includes(needle));
  const firstRow = rowOf("alpha");
  const lastRow = rowOf("omicron");
  tui.handleTerminalInput(sgr(0, screen[firstRow].indexOf("alpha") + 1, firstRow + 1));
  tui.handleTerminalInput(sgr(32, screen[lastRow].indexOf("omicron") + 7, lastRow + 1));
  tui.handleTerminalInput(sgr(0, screen[lastRow].indexOf("omicron") + 7, lastRow + 1, true));

  // Real CustomEditor wired through our factory with the Ctrl+C hook.
  const keybindings = new Tui.KeybindingsManager({
    ...Tui.TUI_KEYBINDINGS,
    "app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
  });
  const clipboard = { calls: [], text: "DRAFT" };
  const editor = makeCodexEditorFactory({
    host: { CustomEditor: CustomEditor },
    accent: (s) => s,
    selectionCopy: sys.editorHook(),
  })(tui, { fg: (_k, t) => t }, keybindings);
  editor.setText(clipboard.text);
  editor.setPaddingX(2);
  // Route the copy through the hook's clipboard executor: patch the TUI
  // copyTextToClipboard (the host's own backend entry) to record calls.
  tui.copyTextToClipboard = async (value) => {
    clipboard.calls.push(value);
    return true;
  };
  let cleared = false;
  editor.onAction("app.clear", () => {
    cleared = true;
  });
  editor.handleInput("\x03");
  assert.equal(clipboard.calls.length, 1, "exactly one clipboard write");
  assert.ok(clipboard.calls[0].includes("alpha beta gamma"), "copied selection text");
  assert.equal(cleared, false, "app.clear handler NOT invoked");
  assert.equal(editor.getText(), "DRAFT", "draft preserved");

  // No selection → stock behavior (app.clear runs).
  tui.selectionAnchor = undefined;
  tui.selectionFocus = undefined;
  editor.handleInput("\x03");
  assert.equal(cleared, true, "stock clear behavior without selection");
});

test("real TUI: decoration-only selection returns empty and never touches the clipboard", () => {
  const sys = makeSystem();
  sys.wrapPrototypes();
  const text = "tiny";
  const { tui } = buildAltScreen(sys, text, 60);
  tui.setCopyOnSelect(false);
  // The padding band row is pure decoration: mapped spans, no content.
  tui.selectionAnchor = { row: 0, col: 0, scrollView: undefined, boundary: false };
  tui.selectionFocus = { row: 0, col: 30, scrollView: undefined, boundary: false };
  assert.equal(tui.getActiveSelectionText(), "", "empty for decoration-only");
  const d = sys.diagnostics();
  assert.ok(d.telemetry.emptyDecoration >= 1, "telemetry records empty-decoration");
});

test("external prototype wrapper (pi-copy-soft-wrap pattern) is detected and bypassed", () => {
  const sys = makeSystem();
  sys.wrapPrototypes();
  const text = "一行中文软折行复制测试内容需要足够长才能在窄宽度下折行成多行屏幕显示验证精确复制。";
  const { tui } = buildAltScreen(sys, text, 60);
  tui.setCopyOnSelect(false);
  // Simulate the old plugin: wrap the PROTOTYPE method with a heuristic
  // normalizer (adds markers around every newline it sees).
  const proto = Object.getPrototypeOf(tui);
  const original = proto.getActiveSelectionText;
  proto.getActiveSelectionText = function (...args) {
    const value = original.apply(this, args);
    return value === undefined ? undefined : value.split("\n").join("<<HEURISTIC>>");
  };
  // The test wrapper is an unknown foreign owner (the real plugin names
  // itself via its normalizer source); both must be detected as foreign.
  assert.ok(detectExternalSerializerPatch(proto) !== undefined, "foreign wrapper detected");
  const screen = tui.previousScreen.map((line) => Tui.stripTerminalSequences(line).trimEnd());
  const first = screen.findIndex((line) => line.includes("一行中文"));
  const last = screen.findIndex((line) => line.includes("精确复制"));
  assert.ok(first >= 0 && last > first, "wrapped rows present");
  tui.selectionAnchor = { row: first, col: 0, scrollView: undefined, boundary: false };
  tui.selectionFocus = { row: last, col: Tui.visibleWidth(screen[last]), scrollView: undefined, boundary: false };
  const copied = tui.getActiveSelectionText();
  assert.ok(!copied.includes("<<HEURISTIC>>"), "instance replacement bypasses the prototype wrapper");
  assert.equal(copied, text, "exact text despite foreign prototype wrapper");
  proto.getActiveSelectionText = original;
});

// ---------------------------------------------------------------------------
// A. Property tests (seeded): mirror rows must equal host rows for arbitrary
// inputs, and full-width selection must reproduce the source logical text.
// ---------------------------------------------------------------------------

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("property: mirrored render equals host rows and full selection round-trips (seeded)", () => {
  const sys = makeSystem();
  sys.wrapPrototypes();
  const rand = seededRandom(0x9e3779b9);
  const words = ["alpha", "beta", "gamma", "中文词语", "x".repeat(20), "https://example.com/a/b/c", "hyphen-ated", "3.14", "foo_bar"];
  const joins = [" ", " ", "\n", "\n\n", ""];
  let roundTrips = 0;
  for (let caseIndex = 0; caseIndex < 24; caseIndex++) {
    const pieces = [];
    const count = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < count; i++) {
      pieces.push(words[Math.floor(rand() * words.length)]);
      pieces.push(joins[Math.floor(rand() * joins.length)]);
    }
    const text = pieces.join("");
    for (const width of [44, 72, 130]) {
      const md = new Tui.Markdown(text, 1, 1, theme, undefined, {});
      const rows = md.render(width);
      if (rows.length <= 2) continue;
      const { SelectionSerializer: Serializer } = { SelectionSerializer };
      const frame = { root: { component: md, rect: { x: 0, y: 0, width, height: rows.length }, clip: { x: 0, y: 0, width, height: rows.length }, children: [], lines: rows } };
      const result = new Serializer({
        visibleWidth: Tui.visibleWidth,
        sliceByColumn: Tui.sliceByColumn,
        stripTerminalSequences: Tui.stripTerminalSequences,
      }).serialize(frame, {
        scrollView: undefined,
        startRow: 1,
        endRow: rows.length - 2,
        sourceLines: rows,
        columnsFor: (row) => ({ start: 0, end: Tui.visibleWidth(rows[row] ?? "") }),
      });
      const flattened = text.replace(/\n+/g, "\n");
      const got = result.text.replace(/\n\n+/g, "\n").trim();
      const expected = flattened.trim();
      if (got !== expected) {
        assert.fail(`case ${caseIndex} width ${width}: ${JSON.stringify(got)} !== ${JSON.stringify(expected)}`);
      }
      roundTrips += 1;
    }
  }
  assert.ok(roundTrips > 20, `expected many round trips, got ${roundTrips}`);
  const d = diagnostics(sys);
  assert.equal(d.degraded, 0, `mirror degraded during property run: ${d.reason}`);
});
