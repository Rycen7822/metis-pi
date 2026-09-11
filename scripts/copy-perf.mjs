// Performance measurements for the selection-copy system (VALIDATION §18):
//  1. Frame cost with provenance wrappers ON vs native (frame delta).
//  2. Copy latency over 1k/10k-row selections (must scale with selection).
//  3. Warm-frame cost (all caches hot — the steady-state animation frame).
// Run: node --experimental-strip-types scripts/copy-perf.mjs
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
system.wrapPrototypes();

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

function measureFrame(build, width, height, label) {
  const terminal = { columns: width, rows: height, write: () => {} };
  const tui = new Tui.TuiAltScreen(terminal);
  tui.beforeTerminalStart();
  tui.setLayoutRoot(build());
  // warm-up render (builds all products)
  tui.doRender();
  const frames = 20;
  const start = performance.now();
  for (let i = 0; i < frames; i++) tui.doRender();
  const coldMs = (performance.now() - start) / frames;
  // scroll a little so each render commits (mirrors live usage)
  console.log(`${label}: ${coldMs.toFixed(2)} ms/frame (avg of ${frames})`);
  return { tui, msPerFrame: coldMs };
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
  console.log(`${label}: ${ms.toFixed(2)} ms for ${rowCount} rows (${(ms / rowCount * 1000).toFixed(1)} µs/row), ${result.text.length} chars, mode=${result.nativeRows === 0 ? "exact" : "mixed"}`);
}

const SMALL = 34;  // ≈1k visual rows (each message ≈ 30 rows incl. code)
const LARGE = 340; // ≈10k visual rows

console.log("--- frame cost (provenance ON, steady state) ---");
measureFrame(() => buildTranscript(SMALL), 100, 40, `1k-row transcript frame`);
measureFrame(() => buildTranscript(LARGE), 100, 40, `10k-row transcript frame`);

console.log("--- copy latency (from committed frames) ---");
{
  const { tui } = measureFrame(() => buildTranscript(SMALL), 100, 40, "1k-row frame (for copy)");
  const total = tui.currentLayout.root.scrollContentLines.length;
  measureCopy(tui, 0, total - 1, "copy 1k rows (full transcript)");
  measureCopy(tui, 40, 59, "copy 20 rows (screen-sized)");
}
{
  const { tui } = measureFrame(() => buildTranscript(LARGE), 100, 40, "10k-row frame (for copy)");
  const total = tui.currentLayout.root.scrollContentLines.length;
  measureCopy(tui, 0, total - 1, "copy 10k rows (full transcript)");
  measureCopy(tui, total - 40, total - 1, "copy 40 rows (screen-sized)");
}
