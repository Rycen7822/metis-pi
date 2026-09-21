// Render the ACTUAL assembly path (renderers.makeRenderers → renderCall +
// renderResult → shell/diff/write modules) to ANSI/plain/HTML snapshots.
// No model calls. The HTML is a renderer preview, not a screenshot of a
// running Pi installation — that role belongs to host-smoke (real components).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { makeRenderers, safeText, languageForPath } from "../src/renderers.ts";
import { renderDiffLines } from "../src/diff.ts";
import { detectColorLevel } from "../src/palette.ts";
import { TranscriptState } from "../src/transcript-state.ts";
import { renderShellCall, renderShellResult } from "../src/shell.ts";
import { renderWritePreview } from "../src/write-preview.ts";
const root = new URL("../", import.meta.url);
const palette = JSON.parse(readFileSync(new URL("themes/metis-pi.json", root), "utf8"));
function hexColor(key) {
  let value = palette.colors[key] || "#e5e7eb";
  for (let i = 0; i < 8 && !value.startsWith("#"); i++) value = palette.vars[value] || "#e5e7eb";
  return value;
}
const theme = {
  fg(key, text) {
    const color = hexColor(key).slice(1);
    const rgb = [0, 2, 4].map((p) => parseInt(color.slice(p, p + 2), 16));
    return `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
  },
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const result = (text, extra = {}) => ({ content: [{ type: "text", text }], ...extra });
const ansiRE = /\x1b\[[0-9;]*m/g;
function isWide(code) {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}
function visibleWidth(text) {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) {
    const code = char.codePointAt(0);
    if (code >= 0x300 && code <= 0x36f) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}
function wrapCells(text, width) {
  if (!text) return [];
  // ANSI-aware wrap: escape sequences ride along without width and are never
  // split (mirrors Tui.wrapTextWithAnsi behavior used by the live adapter).
  const lines = [];
  let current = "", cells = 0;
  let index = 0;
  const pushChar = (char, w) => {
    if (current && cells + w > width) { lines.push(current); current = ""; cells = 0; }
    current += char; cells += w;
  };
  while (index < text.length) {
    const char = text[index];
    if (char === "\x1b") {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(index));
      if (match) { current += match[0]; index += match[0].length; continue; }
    }
    const w = isWide(char.codePointAt(0)) ? 2 : 1;
    pushChar(char, w);
    index += 1;
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}
const layout = { visibleWidth, wrap: wrapCells };
const colorLevel = detectColorLevel({ COLORTERM: "truecolor" });

// The production renderers, driven through the same entry points Pi calls.
const makeTextComponent = (text) => ({
  text,
  render: (width) => text.split("\n").flatMap((line) => wrapCells(line, width)),
  setText: (next) => { text = next; },
});
const transcript = new TranscriptState();
const renderers = makeRenderers(
  makeTextComponent,
  () => "ctrl+o to expand",
  null, // no external highlighter: shell rows use the built-in Mocha lexer
  // Width-aware diff component factory — the same lazy-render shape index.ts
  // hands to the live adapter, so diff width follows the preview width.
  (input) => ({
    render: (width) => renderDiffLines({
      rows: input.rows, width, layout, colorLevel,
      language: languageForPath(input.filePath), paint: undefined,
      expanded: input.options.expanded === true, expandHint: input.expandHint ?? "ctrl+o to expand",
    }),
  }),
  // Width-aware shell factories — the SAME SGR-DIM output path as the live
  // host (index.ts → CodexShellCall/ResultComponent → renderShellResult).
  {
    makeShellCall: (input) => ({
      render: (width) => renderShellCall({
        row: {
          title: input.title, isError: false, isPartial: input.options.isPartial === true,
          command: String(input.args.command ?? ""),
          language: input.name === "powershell" ? "powershell" : "bash",
          output: "", expanded: input.options.expanded === true, expandHint: "",
        },
        width, layout, colorLevel: input.colorLevel, bullet: input.bullet,
        titlePainter: (t) => t,
      }),
    }),
    makeShellResult: (input) => ({
      render: (width) => {
        const result = input.result ?? null;
        const content = Array.isArray(result?.content) ? result.content : [];
        const output = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
        return renderShellResult({
          row: {
            title: "", isError: input.context.isError === true, isPartial: input.options.isPartial === true,
            command: "", language: input.name === "powershell" ? "powershell" : "bash",
            output, expanded: input.options.expanded === true, expandHint: input.expandHint,
          },
          width, layout, colorLevel: input.colorLevel, bullet: input.bullet,
          titlePainter: (t) => t,
        });
      },
    }),
  },
  // Live write-args preview — the same module the live CodexWritePreview
  // component renders (bounded rolling tail, dim stage label).
  (input) => ({
    render: (width) => renderWritePreview(input.contentPrefix, {
      width: Math.max(1, Math.floor(width) - 2),
      stage: input.stage, expanded: input.expanded === true, theme,
      colorLevel: input.colorLevel, layout, gutter: "  │ ",
    }),
  }),
  { colorLevel, transcript, writeChanges: new Map() },
  layout,
);
const WIDTH = 112;
const SEPARATOR_LINE = `─`.repeat(WIDTH); // light rule (dim in ANSI render)

/** ToolLifecycleRenderer pair, exactly as the Pi adapter invokes them. */
function lifecycle(name, args, value, context = {}) {
  const plan = transcript.explorationPlan?.(context.toolCallId ?? "");
  const callCtx = { args, state: {}, isPartial: context.isPartial ?? false, explorationPlan: plan, ...context };
  const call = renderers[name].renderCall(args, theme, callCtx);
  const callLines = call ? call.render(WIDTH) : [];
  const resultCtx = { args, state: {}, isPartial: false, explorationPlan: plan, ...context };
  const res = renderers[name].renderResult(value, { expanded: context.expanded === true }, theme, resultCtx);
  const resultLines = res ? res.render(WIDTH) : [];
  return [...callLines, ...resultLines].filter((line) => line.length > 0).join("\n");
}

const longOld = "来源摘要必须由 Domain、Engine、jobs、Store、projections 等模块共同确认，旧实现保留重复路径并把推断混入事实。";
const longNew = "来源摘要必须由 Domain、Engine、jobs、Store、projections 等模块共同确认，不复制 provider 或调度逻辑，保持单一事实来源。";
const testOutput = [
  "> @rycen7822/metis-pi@0.4.0 test", "Running unit tests...",
  "fixture 1", "fixture 2", "fixture 3", "fixture 4", "fixture 5", "fixture 6",
  "tests 93", "pass 93", "fail 0",
].join("\n");
// --- 0.6.0: serial exploration grouping - 8 image reads across separate
// tool-call-only assistant messages, replayed through TranscriptState.
const GROUP_IMAGES = [
"all_results.png.png", "shampoo_results.png.png", "EMA_KL_results.png.png",
"ema_results.png.png", "frob_results.png.png", "larger.png.png",
"trace_results.png.png", "trace_comparison_results.png.png"
];
for (let gi = 0; gi < GROUP_IMAGES.length; gi++) {
transcript.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: `img${gi}` }] } });
transcript.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `img${gi}` }] } });
transcript.apply({ type: "tool_execution_start", toolCallId: `img${gi}`, toolName: "read" });
transcript.apply({ type: "tool_execution_end", toolCallId: `img${gi}`, toolName: "read", isError: false, imageCount: 1 });
}

const groupRows = [];
for (let gi = 0; gi < GROUP_IMAGES.length; gi++) {
  groupRows.push(lifecycle("read", { path: `figures/${GROUP_IMAGES[gi]}` }, { content: [{ type: "image", data: "omitted", mimeType: "image/png" }] }, { toolCallId: `img${gi}` }));
}
// Boundary text after the group (stable plan query — non-consuming, 0.7.0).
transcript.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "compare" }] } });
const sep1 = transcript.textRunPlan(`0:9:open`)?.separatorBefore ? SEPARATOR_LINE : "";
// bash segment
transcript.apply({ type: "tool_execution_start", toolCallId: "pvbash", toolName: "bash" });
transcript.apply({ type: "tool_execution_end", toolCallId: "pvbash", toolName: "bash", isError: false });
transcript.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "next" }] } });
const sep2 = (() => {
  // The bash text is a NEW logical message after tool activity: resolve it the
  // way the coordinator does — the most recent open assistant plan.
  for (let seq = 10; seq >= 1; seq--) {
    const plan = transcript.textRunPlan(`0:${seq}:open`);
    if (plan) return plan.separatorBefore ? SEPARATOR_LINE : "";
  }
  return "";
})();
const examples = [
  groupRows.join("\n"),
  // Exploration rows (Codex: cyan titles, dim " in ").
  lifecycle("read", { path: "src/server.ts", offset: 1, limit: 120 }, result("This source text is folded, not removed from model context.")),
  lifecycle("grep", { pattern: "createServer|listen", path: "src" }, result("src/server.ts:12:createServer(...)")),
  // Golden command 1: rtk git diff --numstat -- ...
  lifecycle("bash", { command: "rtk git diff --numstat -- src/renderers.ts" }, result(["src/renderers.ts | 42 ++++++---", "1 file changed, 30 insertions(+), 12 deletions(-)"].join("\n"), { details: { aggregatedOutput: "src/renderers.ts | 42 ++++++---\n1 file changed, 30 insertions(+), 12 deletions(-)" } })),
  // Golden command 2: CJK + options.
  lifecycle("bash", { command: "grep -n -e '略过' src/*.ts" }, result("src/adapter.ts:73:  // 略过 non-builtin tool rows\n1 match", { details: { aggregatedOutput: "src/adapter.ts:73:  // 略过 non-builtin tool rows\n1 match" } })),
  // Regular test run.
  lifecycle("bash", { command: "npm test" }, result(testOutput, { details: { aggregatedOutput: testOutput } })),
  // Golden command 3: python3 heredoc.
  lifecycle("bash", { command: "python3 - <<'EOF'\nprint(1)\nEOF" }, result("1", { details: { aggregatedOutput: "1" } })),
  // Golden command 4: pipes.
  lifecycle("bash", { command: "bash script.sh 2>&1 | tail -50" }, result(["script output line one", "script output line two"].join("\n"), { details: { aggregatedOutput: "script output line one\nscript output line two" } })),
  // Edit diff with Codex full-row surfaces.
  lifecycle("edit", { path: ".work/EverTrace_development_plan.md" }, result("Successfully replaced text.", { details: { diff: [
    "  2029 ", `- 2030 ${longOld}`, `+ 2030 ${longNew}`, "  2031 ",
  ].join("\n") } })),
  // Write lifecycle: new file (Added) — rows from the tracker's structured diff.
  lifecycle("write", { path: "docs/new-guide.md", content: "# Guide\n\nContent lines.\nFinal.\n" }, result("File created successfully: /tmp/project/docs/new-guide.md"), {
    writeChanges: {
      path: "docs/new-guide.md", kind: "add", added: 4, removed: 0,
      rows: [
        { kind: "add", number: 1, content: "# Guide" },
        { kind: "add", number: 2, content: "" },
        { kind: "add", number: 3, content: "Content lines." },
        { kind: "add", number: 4, content: "Final." },
      ],
    },
  }),
  // Write lifecycle: unchanged content (expandable full text, not empty).
  lifecycle("write", { path: "docs/same.md", content: "Same text.\n" }, result("File written successfully."), {
    writeChanges: { path: "docs/same.md", kind: "unchanged", added: 0, removed: 0, lines: 1 },
  }),
  // Write lifecycle: unavailable snapshot (preview from args, no fake +N/-0).
  lifecycle("write", { path: "docs/legacy.md", content: "Recovered content line.\n" }, result("File written successfully."), {
    writeChanges: { path: "docs/legacy.md", kind: "unavailable", reason: "no pre-image snapshot" },
  }),
  // Failed write.
  lifecycle("write", { path: "/protected/config.json", content: "{}\n" }, result("Permission denied", { isError: true }), { isError: true }),
  // Image preview disabled.
  lifecycle("read", { path: "figures/teaser.png" }, { content: [{ type: "image", data: "never-written-to-preview", mimeType: "image/png" }] }),
  // Write LIVE frames: the model is still streaming args.content (call slot
  // only — no result exists yet). Three stages of the same call, exactly what
  // host updateArgs → renderCall produces while receiving.
  [Array.from({ length: 3 }, (_, fi) => {
    const contents = [
      "# 草稿：实验记录\n",
      "# 草稿：实验记录\n\n## 方法\n样本在室温下静置 30 分钟，随后\n",
      "# 草稿：实验记录\n\n## 方法\n样本在室温下静置 30 分钟，随后记录初始质量。\n\n## 观察\n",
    ];
    const callCtx = { args: { path: `notes/draft-${fi + 1}.md`, content: contents[fi] }, state: {}, isPartial: true, argsComplete: fi === 2, executionStarted: false, hasResult: false };
    const call = renderers.write.renderCall(callCtx.args, theme, callCtx);
    const rendered = call ? call.render(112).join("\n") : "";
    console.error("LIVEFRAME", fi, "len", rendered.length, JSON.stringify(rendered.slice(0, 60)));
    return rendered;
  }).filter(Boolean).join("\n\n")],
  // Running + error rows.
  lifecycle("bash", { command: "npm run check" }, result("Checking TypeScript..."), { isPartial: true }),
  lifecycle("bash", { command: "cat /protected/config.json" }, result("cat: /protected/config.json: Permission denied\nCommand exited with code 1", { isError: true }), { isError: true }),
];
const transcriptOut = [examples[0], ...examples.slice(1).flatMap((e, i) => {
  const isGroupTail = i === GROUP_IMAGES.length - 2; // last grouped read → group boundary
  const isBashTail = i === 3; // bash segment → second tool→text boundary
  return isGroupTail ? [e, sep1] : isBashTail ? [e, sep2] : [e];
})].join("\n\n") + "\n";
const escaped = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function ansiHtml(text) {
  let html = "", last = 0;
  let bold = false, dim = false, color = "#e5e7eb", bg = "transparent";
  const span = (raw) => {
    if (!raw) return "";
    const shown = dim ? `color-mix(in srgb, ${color} 58%, ${bg === "transparent" ? "#0c0c0c" : bg})` : color;
    return `<span style="color:${shown};background:${bg};font-weight:${bold ? 600 : 400}">${escaped(raw)}</span>`;
  };
  for (const match of text.matchAll(ansiRE)) {
    html += span(text.slice(last, match.index));
    const codes = match[0].slice(2, -1).split(";").filter(Boolean).map(Number);
    if (codes.length === 0) codes.push(0);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) { bold = false; dim = false; color = "#e5e7eb"; bg = "transparent"; }
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) { bold = false; dim = false; }
      else if (code === 39) color = "#e5e7eb";
      else if (code === 49) bg = "transparent";
      else if (code === 38 && codes[i + 1] === 2) { color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      else if (code === 48 && codes[i + 1] === 2) { bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
    }
    last = match.index + match[0].length;
  }
  return html + span(text.slice(last));
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex appearance 0.5 — renderer snapshot</title>
<style>body{margin:0;background:#0c0c0c;color:#e5e7eb;font:14px/1.55 ui-monospace,"DejaVu Sans Mono",Consolas,monospace}.label{padding:18px 28px;border-bottom:1px solid #27272a;color:#a1a1aa;font:12px/1.5 system-ui,sans-serif;letter-spacing:.03em}pre{white-space:pre;margin:0;padding:26px 28px 32px;tab-size:3;overflow:hidden}.note{padding:0 28px 24px;color:#888;font:12px/1.5 system-ui,sans-serif}</style>
<div class="label">metis-pi 0.5.0 · GENERATED FORMATTER/LAYOUT SNAPSHOT · NOT A LIVE PI SESSION</div>
<pre>${ansiHtml(transcriptOut)}</pre><div class="note">Every row above goes through the production two-slot combination (renderCall = header, renderResult = body) — the same entry points the Pi adapter invokes. Shell rows use the width-aware Codex exec-cell layout (Mocha bash palette, "  │ " continuation, "  └ " output with middle truncation); write rows exercise Added/unchanged/unavailable/failed; the edit block uses the single diff renderer.</div></html>`;
mkdirSync(new URL("docs/", root), { recursive: true });
writeFileSync(new URL("docs/transcript.ansi", root), transcriptOut);
writeFileSync(new URL("docs/transcript.txt", root), stripVTControlCharacters(transcriptOut));
writeFileSync(new URL("docs/preview.html", root), html);
console.log("Wrote docs/transcript.ansi, docs/transcript.txt and docs/preview.html through the production two-slot renderers.");
