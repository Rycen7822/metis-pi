// Paired, fresh-process frame measurements for native and provenance-wrapped TUI.
// Copy timings use committed frames with wrappers ON; they exclude OS clipboard I/O.
// Run: node --experimental-strip-types scripts/copy-perf.mjs [sample pairs]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as Tui from "@earendil-works/pi-tui";
import { createSelectionCopySystem } from "../src/selection-copy/index.ts";
import { SelectionSerializer } from "../src/selection-copy/serialize.ts";

const theme = {
  bold: (t) => `\x1b[1m${t}\x1b[22m`, italic: (t) => t, underline: (t) => t,
  strikethrough: (t) => t, heading: (t) => t, code: (t) => t, codeBlock: (t) => t,
  codeBlockBorder: (t) => t, codeBlockIndent: "  ", listBullet: (t) => t,
  quote: (t) => t, quoteBorder: (t) => t, hr: (t) => t, link: (t) => t, linkUrl: (t) => t,
};

const system = createSelectionCopySystem({
  prototypes: {
    Text: Tui.Text.prototype, Markdown: Tui.Markdown.prototype,
    Box: Tui.Box.prototype, Container: Tui.Container.prototype,
  },
  fns: {
    visibleWidth: Tui.visibleWidth, sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences,
    wrapTextWithAnsi: Tui.wrapTextWithAnsi,
    renderLatex: (t, o) => Tui.renderLatex(t, o) ?? null,
  },
}, undefined);
const mode = process.argv[2];
if (mode !== "--on" && mode !== "--off") {
  const pairs = Number(mode ?? 3);
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 10) throw new Error("sample pairs must be 1..10");
  const samples = [];
  for (let i = 0; i < pairs; i++) {
    const pair = {};
    for (const variant of i % 2 ? ["on", "off"] : ["off", "on"]) {
      pair[variant] = JSON.parse(execFileSync(process.execPath, [
        "--experimental-strip-types", fileURLToPath(import.meta.url), `--${variant}`,
      ], { encoding: "utf8", maxBuffer: 2_000_000 }));
    }
    samples.push(pair);
  }
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(`Node ${process.version}; ${pairs} fresh-process paired sample(s); ms/frame`);
  for (const key of ["smallWarm", "smallChanged", "largeWarm", "largeChanged"]) {
    const off = samples.map((s) => s.off[key]);
    const on = samples.map((s) => s.on[key]);
    const deltas = samples.map((s) => s.on[key] - s.off[key]);
    console.log(`${key}: native=${off.map((n) => n.toFixed(2))} wrapped=${on.map((n) => n.toFixed(2))} paired median delta=${median(deltas).toFixed(2)}`);
  }
  for (const [key, value] of Object.entries(samples.at(-1).on.copy)) {
    const times = samples.map((s) => s.on.copy[key].ms);
    console.log(`${key}: ${times.map((n) => n.toFixed(2))} ms / ${value.rows} rows / ${value.chars} chars / ${value.mode}`);
  }
  process.exit(0);
}
if (mode === "--on") system.wrapPrototypes();

function buildTranscript(messageCount) {
  const chat = new Tui.Container();
  for (let i = 0; i < messageCount; i++) {
    chat.addChild(new Tui.Markdown(
      `Message ${i}: 这是一段中文内容用于测量软折行复制的性能开销。Alpha beta gamma delta epsilon continue with english words.\n\n\`\`\`js\nconst value = compute(${i});\nif (value.ok) {\n  apply(value);\n}\n\`\`\``,
      1, 1, theme, undefined, {},
    ));
  }
  const documentContainer = new Tui.Container();
  documentContainer.addChild(chat);
  return new Tui.ScrollView(documentContainer, { primary: true, follow: "end" });
}

function measureFrame(build, width, height) {
  const terminal = { columns: width, rows: height, write: () => {} };
  const tui = new Tui.TuiAltScreen(terminal);
  tui.beforeTerminalStart();
  const root = build();
  tui.setLayoutRoot(root);
  // Build products, then measure a cache-hot frame and a real scrolled frame.
  tui.doRender();
  const frames = 10;
  const start = performance.now();
  for (let i = 0; i < frames; i++) tui.doRender();
  const warmMs = (performance.now() - start) / frames;
  root.scrollToStart();
  tui.doRender();
  const first = root.scrollTop;
  root.scrollBy(1);
  if (root.scrollTop === first) throw new Error("scroll did not move the viewport");
  root.scrollBy(-1);
  const changedAt = performance.now();
  for (let i = 0; i < frames; i++) {
    root.scrollBy(i % 2 ? -1 : 1);
    tui.doRender();
  }
  return { tui, warmMs, changedMs: (performance.now() - changedAt) / frames };
}

function measureCopy(tui, fromRow, toRow, label) {
  const frame = tui.currentLayout;
  const scrollBox = frame.root;
  const serializer = new SelectionSerializer({
    visibleWidth: Tui.visibleWidth, sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences,
  });
  const selection = {
    scrollView: scrollBox.scrollView,
    startRow: fromRow,
    endRow: toRow,
    sourceLines: scrollBox.scrollContentLines,
    columnsFor: (row) => ({ start: 0, end: Tui.visibleWidth(scrollBox.scrollContentLines[row] ?? "") }),
  };
  const start = performance.now();
  const result = serializer.serialize(frame, selection);
  const ms = performance.now() - start;
  const rowCount = toRow - fromRow + 1;
  return { ms, rows: rowCount, chars: result.text.length, mode: result.nativeRows === 0 ? "exact" : "mixed" };
}

const SMALL = 34;
const LARGE = 340;

const output = { copy: {} };
for (const [label, count] of [["small", SMALL], ["large", LARGE]]) {
  const { tui, warmMs, changedMs } = measureFrame(() => buildTranscript(count), 100, 40);
  output[`${label}Warm`] = warmMs;
  output[`${label}Changed`] = changedMs;
  if (mode === "--on") {
    const total = tui.currentLayout.root.scrollContentLines.length;
    output.copy[`${label}Full`] = measureCopy(tui, 0, total - 1);
    output.copy[`${label}Screen`] = measureCopy(tui, label === "small" ? 40 : total - 40, label === "small" ? 59 : total - 1);
  }
}
console.log(JSON.stringify(output));
