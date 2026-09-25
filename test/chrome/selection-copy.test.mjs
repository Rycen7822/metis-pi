// Real host mirror/copy parity, mouse/editor integration and streaming caches.
import test from "node:test";
import assert from "node:assert/strict";

import * as Tui from "@earendil-works/pi-tui";
import { detectExternalSerializerPatch } from "../../src/selection-copy/index.ts";
import { makeCodexEditorFactory } from "../../src/chrome/editor.ts";
import { createHardwareCursor } from "../../src/chrome/hardware-cursor.ts";
import { CURSOR_MARKER, makeSurfaceOps } from "../../src/surface.ts";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { productFor, publishedRowsOf } from "../../src/selection-copy/model.ts";
import { wrapTextPrototype, MIRROR_REBUILD_INTERVAL_MS } from "../../src/selection-copy/markdown.ts";
import { createCopyLexer } from "../../src/selection-copy/parser.ts";
import { stripAnsi } from "../../src/selection-copy/wrap.ts";
import { altScreen, container, copyFrame, drag, installCopyPrototypes, markdownTheme, screenLines, select } from "../helpers/ui-fixtures.mjs";

const theme = {
  ...markdownTheme,
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
  italic: (t) => `\x1b[3m${t}\x1b[23m`,
  underline: (t) => `\x1b[4m${t}\x1b[24m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[29m`,
};

// Native prototypes are shared by every case in this file. Install once.
const sys = installCopyPrototypes();
function diagnostics() {
  const d = sys.diagnostics();
  return { degraded: d.mirrors.markdownDegraded + d.mirrors.textDegraded, reason: d.mirrors.lastDegradedReason };
}

const CORPUS = [
  ["cjk paragraph", "这是一个很长的中文段落用来测试软折行复制功能当我们把窗口调窄时中文字符会按宽度折行但复制时应该保持为一行逻辑文本。"],
  ["english words", "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon"],
  ["long url", "see https://example.com/very/long/path/that/definitely/exceeds/narrow/terminal/widths/often for details"],
  ["code block", "Title\n\n```python\nprint(\"alpha\")\nif True:\n    print(\"beta\")\n```\n\ndone"],
  ["lists", "- item one\n- item two with a fairly long description that should wrap at narrow widths nicely\n  - nested item\n\n3. ordered three"],
  ["quote", "> quoted wisdom that is long enough to wrap around at this width for sure yes\n> second line"],
  ["inline styles", "normal **bold text** and `code span` and *emphasized* and ~~struck~~ end"],
  ["heading + paragraphs", "# Heading\n\nFirst paragraph with several words.\n\nSecond paragraph follows here."],
  ["table", "| name | value |\n| --- | ---: |\n| alpha | 1 |\n| beta with a longer cell that wraps | 2 |\n\nAfter the table."],
  ["hard breaks", "first line  \nsecond line after a hard break\\\nthird line"],
];

test("differential: real Markdown mirror builds at every width without degradation", () => {
  for (const [name, text] of CORPUS) {
    for (const width of [60, 80, 120, 160]) {
      const md = new Tui.Markdown(text, 1, 1, theme, undefined, {});
      md.render(width);
    }
  }
  const d = diagnostics();
  assert.equal(d.degraded, 0, `mirror degraded: ${d.reason}`);
});

function buildAltScreen(text, width = 80) {
  const { tui, terminal } = altScreen(width);
  const md = new Tui.Markdown(text, 1, 1, theme, undefined, {});
  tui.setLayoutRoot(container(md));
  tui.doRender();
  assert.ok(sys.installOnTui(tui), "instance serializer must install");
  return { tui, md, terminal };
}

test("real TUI draws the hardware bar over the unmodified word and restores terminal state", () => {
  const { tui, terminal } = buildAltScreen("", 80);
  terminal.hideCursor = () => terminal.write("\x1b[?25l");
  terminal.showCursor = () => terminal.write("\x1b[?25h");
  const cursor = createHardwareCursor();
  const keybindings = new Tui.KeybindingsManager(Tui.TUI_KEYBINDINGS);
  const editor = makeCodexEditorFactory({
    host: { CustomEditor },
    surface: makeSurfaceOps({ kind: "truecolor" }, (text) => `\x1b[36m${text}\x1b[39m`, (text) => text),
    hardwareCursor: cursor.acquire,
  })(tui, { fg: (_role, text) => text }, keybindings);
  editor.focused = true;
  for (const draft of ["", "hello", "你们 👩‍👩‍👦", "hello world"]) {
    editor.setText(draft);
    const row = editor.render(80).find((line) => line.includes(CURSOR_MARKER));
    assert.ok(row?.includes(CURSOR_MARKER), "native IME marker retained");
    assert.doesNotMatch(row, /\x1b\[7m/, "host inverse-video block removed");
    assert.equal(Tui.visibleWidth(row), 80, "real surface row stays within terminal width");
    assert.equal(editor.getText(), draft, "display does not change draft");
  }
  editor.setText("hello world");
  editor.handleInput("\x1b[D");
  editor.handleInput("\x1b[D"); // the 'l' before 'd'
  assert.equal(editor.getCursor().col, 9);
  const row = editor.render(80).find((line) => line.includes(CURSOR_MARKER));
  assert.ok(row?.includes(`wor${CURSOR_MARKER}l\x1b[0m`), "the cursor does not replace the 'l'");
  assert.match(Tui.stripTerminalSequences(row), /hello world/, "word stays legible on the surface");
  tui.setLayoutRoot(container(editor));
  tui.setFocus(editor);
  tui.doRender();
  const output = terminal.writes.join("");
  assert.ok(output.includes("\x1b[6 q"), "request steady hardware bar shape");
  assert.match(output, /\x1b\[\?25h/, "real renderer shows the positioned hardware cursor");
  cursor.release();
  assert.equal(tui.getShowHardwareCursor(), false, "Pi cursor setting restored");
  assert.equal(terminal.writes.at(-1), "\x1b[0 q", "terminal default cursor shape restored");
});

test("real TUI: mouse drag selects soft-wrapped CJK paragraph; copy is one logical line", () => {
  const text = "这是一个很长的中文段落用来测试软折行复制功能当我们把窗口调窄时中文字符会按宽度折行但复制时应该保持为一行逻辑文本。";
  const { tui } = buildAltScreen(text, 60);
  // Find the content rows on screen (paddingY=1 → row 1 is first content row;
  // the paragraph wraps at contentWidth 58).
  const screen = screenLines(tui);
  const firstRow = screen.findIndex((line) => line.includes("这是一个很长的"));
  const lastRow = screen.findIndex((line) => line.includes("逻辑文本。"));
  assert.ok(firstRow >= 0 && lastRow > firstRow, `expected wrapped CJK rows, got ${JSON.stringify(screen.slice(0, 5))}`);
  const first = { row: firstRow, line: screen[firstRow] };
  const last = { row: lastRow, line: screen[lastRow] };
  // Press at (3, first.row+1) → drag to end of last row → release.
  // SGR mouse coords are 1-based CELL columns — CJK chars are 2 cells wide.
  const startCell = Tui.visibleWidth(first.line.slice(0, first.line.indexOf("这"))) + 1;
  drag(tui, startCell, first.row + 1, Tui.visibleWidth(last.line) + 1, last.row + 1);
  assert.equal(tui.hasActiveSelection(), true, "geometry selection active after drag");
  const copied = tui.getActiveSelectionText();
  assert.equal(copied, text, `exact logical text expected, got ${JSON.stringify(copied)}`);
});

test("real TUI: Ctrl+C with selection consumes the key, copies, keeps the draft", () => {
  const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
  const { tui } = buildAltScreen(text, 60);
  const screen = screenLines(tui);
  const rowOf = (needle) => screen.findIndex((line) => line.includes(needle));
  const firstRow = rowOf("alpha");
  const lastRow = rowOf("omicron");
  drag(tui, screen[firstRow].indexOf("alpha") + 1, firstRow + 1,
    screen[lastRow].indexOf("omicron") + 7, lastRow + 1);

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

test("external prototype wrapper (pi-copy-soft-wrap pattern) is detected and bypassed", (t) => {
  const text = "一行中文软折行复制测试内容需要足够长才能在窄宽度下折行成多行屏幕显示验证精确复制。";
  const { tui } = buildAltScreen(text, 60);
  // Simulate the old plugin: wrap the PROTOTYPE method with a heuristic
  // normalizer (adds markers around every newline it sees).
  const proto = Object.getPrototypeOf(tui);
  const original = proto.getActiveSelectionText;
  t.after(() => { proto.getActiveSelectionText = original; });
  proto.getActiveSelectionText = function (...args) {
    const value = original.apply(this, args);
    return value === undefined ? undefined : value.split("\n").join("<<HEURISTIC>>");
  };
  // The test wrapper is an unknown foreign owner (the real plugin names
  // itself via its normalizer source); both must be detected as foreign.
  assert.ok(detectExternalSerializerPatch(proto) !== undefined, "foreign wrapper detected");
  const screen = screenLines(tui);
  const first = screen.findIndex((line) => line.includes("一行中文"));
  const last = screen.findIndex((line) => line.includes("精确复制"));
  assert.ok(first >= 0 && last > first, "wrapped rows present");
  tui.selectionAnchor = { row: first, col: 0, scrollView: undefined, boundary: false };
  tui.selectionFocus = { row: last, col: Tui.visibleWidth(screen[last]), scrollView: undefined, boundary: false };
  const copied = tui.getActiveSelectionText();
  assert.ok(!copied.includes("<<HEURISTIC>>"), "instance replacement bypasses the prototype wrapper");
  assert.equal(copied, text, "exact text despite foreign prototype wrapper");
});

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("property: mirrored render equals host rows and full selection round-trips (seeded)", () => {
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
      const frame = copyFrame(md, width);
      const rows = frame.root.lines;
      if (rows.length <= 2) continue;
      const result = select(frame, 1, rows.length - 2);
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
  const d = diagnostics();
  assert.equal(d.degraded, 0, `mirror degraded during property run: ${d.reason}`);
});

test("user message card: copied logical text identical across widths, background never copied", () => {
  const text = "帮我看看这个很长的中文问题在窗口变窄的时候软折行复制是否保持为一行不添加多余换行或空格，同时灰色卡片背景绝对不能混进复制结果里。";
  const bgPaint = (line) => `\x1b[48;2;41;41;41m${line}\x1b[49m`;
  const copies = [];
  for (const width of [60, 80, 120]) {
    const box = new Tui.Box(1, 1, bgPaint);
    box.addChild(new Tui.Markdown(text, 0, 0, theme, { color: (t) => t }, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true }));
    const frame = copyFrame(box, width);
    const rows = frame.root.lines;
    assert.ok(rows.length > 3, `message wraps at ${width}`);
    assert.ok(rows.some((row) => row.includes("\x1b[48;2;41;41;41m")), `surface rendered at ${width}`);
    const result = select(frame, 1, rows.length - 2);
    assert.ok(!/\x1b/.test(result.text), `no ANSI (background included) in copied text at ${width}`);
    copies.push(result.text);
  }
  assert.equal(copies[0], copies[1], "60 vs 80 columns: identical logical copy");
  assert.equal(copies[1], copies[2], "80 vs 120 columns: identical logical copy");
  assert.ok(copies[0].replace(/\n/g, "").includes("软折行复制"), "content present");
});

test("collapsed thought summary copies its label only — hidden reasoning is not rendered anywhere", () => {
  // The real label as index.ts paints it: italic + thinkingText color.
  const label = new Tui.Text("\x1b[3m\x1b[38;2;163;163;163mThought for 13s\x1b[39m\x1b[23m", 1, 0);
  const rows = label.render(40);
  const product = productFor(rows);
  assert.ok(product, "Text mirror builds for the summary label");
  const copied = product.rows
    .map((row) => row.spans
      .filter((span) => span.kind !== "decoration")
      .map((span) => span.text ?? "")
      .join(""))
    .filter((text) => text.length > 0)
    .join("\n");
  assert.equal(copied, "Thought for 13s");
  assert.ok(!/\x1b/.test(copied), "label styling stays out of the copy");
});

function freshTextDeps(now) {
  return {
    fns: {
      visibleWidth: Tui.visibleWidth,
      sliceByColumn: Tui.sliceByColumn,
      stripTerminalSequences: Tui.stripTerminalSequences,
      stripAnsi,
    },
    lexer: createCopyLexer(),
    hostWrap: Tui.wrapTextWithAnsi,
    diagnostics: { markdownBuilt: 0, markdownDegraded: 0, textBuilt: 0, textDegraded: 0, markdownThrottled: 0, textThrottled: 0, lastDegradedReason: "" },
    now,
  };
}

test("throttle: changing text at one width rebuilds at most once per interval; stable text rebuilds immediately", () => {
  let fakeNow = 10_000;
  const deps = freshTextDeps(() => fakeNow);
  class MiniText {
    constructor(text) { this.text = text; this.paddingX = 0; this.paddingY = 0; }
    render(width) { return Tui.wrapTextWithAnsi(this.text, width); }
  }
  assert.equal(wrapTextPrototype(MiniText.prototype, deps), true, "fresh prototype wraps");
  const line = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
  const comp = new MiniText(line);

  // One stream: settling bypasses the interval; changing again starts a new
  // throttle window, while elapsed time or a new width always permits rebuild.
  for (const [name, suffix, elapsed, width, built, throttled, mapped] of [
    ["first render", "", 0, 60, 1, 0, true],
    ["fresh-array cache hit", "", 0, 60, 1, 0, true],
    ["changing text", " STREAMING", 50, 60, 1, 1, false],
    ["settled text", " STREAMING", 50, 60, 2, 1, true],
    ["second throttle window", " STREAMING MORE", 50, 60, 2, 2, false],
    ["interval expired", " STREAMING MORE AND MORE", MIRROR_REBUILD_INTERVAL_MS + 50, 60, 3, 2, true],
    ["resize", " WIDTH CHANGED", 10, 80, 4, 2, true],
  ]) {
    comp.text = line + suffix;
    fakeNow += elapsed;
    const rows = comp.render(width);
    assert.equal(deps.diagnostics.textBuilt, built, name);
    assert.equal(deps.diagnostics.textThrottled, throttled, name);
    assert.equal(Boolean(productFor(rows)), mapped, name);
    assert.equal(publishedRowsOf(comp), rows, `${name}: rows published for alignment`);
  }
});

test("container alignment resolves child products WITHOUT re-rendering children", () => {
  const chat = container(container(
    new Tui.Markdown("steady child content", 0, 0, theme, undefined, {}),
    new Tui.Text("a label", 1, 0),
  ));
  chat.render(60); // first pass: builds products

  // Count leaf renders during one steady-state frame.
  for (const proto of [Tui.Markdown.prototype, Tui.Text.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, "render");
    let calls = 0;
    Object.defineProperty(proto, "render", {
      ...desc,
      value: function (w) { calls++; return desc.value.call(this, w); },
    });
    try {
      chat.render(60);
      assert.equal(calls, 1, "exactly one render per leaf per frame (no alignment re-render)");
    } finally {
      Object.defineProperty(proto, "render", desc);
    }
  }
  // And the steady frame still produced a resolvable container product.
  const rows = chat.render(60);
  const product = productFor(rows);
  assert.ok(product?.children, "container product registered");
  assert.ok(product.children.some((p) => p !== undefined), "placements resolve through the chain");
});

