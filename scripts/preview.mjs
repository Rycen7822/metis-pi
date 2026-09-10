// Render the actual formatter/layout functions to ANSI/plain/HTML snapshots. No model calls.
// The HTML is a renderer preview, not a screenshot of a running Pi installation.
// 0.4.0 fixture: command structures from the user's Codex CLI reference screenshot.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { formatCall, formatResult, diffStats, renderCodexDiffLines } from "../src/renderers.ts";
import { renderShellRow } from "../src/shell.ts";
import { detectColorLevel } from "../src/palette.ts";
const root = new URL("../", import.meta.url);
const palette = JSON.parse(readFileSync(new URL("themes/codex-appearance.json", root), "utf8"));
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
      const match = /^\x1b\[[0-9;]*m/.exec(text.slice(index));
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

/** Width-aware shell row (CodexExecComponent path). */
function shellRow(command, outputText, { isPartial = false, isError = false, width = 112 } = {}) {
  return renderShellRow({
    row: {
      title: isPartial ? "Running" : "Ran",
      isError, isPartial,
      command, language: "bash",
      output: outputText ?? "",
      expanded: false, expandHint: "ctrl+o to expand",
    },
    width, layout, colorLevel,
    bullet: isError ? theme.fg("error", "•") : isPartial ? theme.fg("dim", "•") : theme.fg("success", "•"),
    titlePainter: (title) => theme.bold(title),
  }).join("\n");
}
function row(name, args, value, context = {}) {
  const ctx = { args, isPartial: false, showImages: false, ...context };
  const call = formatCall(name, args, theme, ctx, diffStats(value));
  let body;
  if (name === "edit" && value?.details?.diff && !ctx.isError) {
    body = renderCodexDiffLines(value.details.diff, 112, theme, layout).join("\n");
  } else {
    body = formatResult(name, value, { isPartial: ctx.isPartial, expanded: ctx.expanded }, theme, ctx, "ctrl+o to expand");
  }
  return [call, body].filter(Boolean).join("\n");
}
const longOld = "来源摘要必须由 Domain、Engine、jobs、Store、projections 等模块共同确认，旧实现保留重复路径并把推断混入事实。";
const longNew = "来源摘要必须由 Domain、Engine、jobs、Store、projections 等模块共同确认，不复制 provider 或调度逻辑，保持单一事实来源。";
const testOutput = [
  "> pi-codex-appearance@0.4.0 test", "Running unit tests...",
  "fixture 1", "fixture 2", "fixture 3", "fixture 4", "fixture 5", "fixture 6",
  "tests 74", "pass 74", "fail 0",
].join("\n");
const examples = [
  // Exploration rows (Codex: cyan titles, dim " in ").
  row("read", { path: "src/server.ts", offset: 1, limit: 120 }, result("This source text is folded, not removed from model context.")),
  row("grep", { pattern: "createServer|listen", path: "src" }, result("src/server.ts:12:createServer(...)")),
  // Golden command 1: rtk git diff --numstat -- ...
  shellRow("rtk git diff --numstat -- src/renderers.ts", ["src/renderers.ts | 42 ++++++---", "1 file changed, 30 insertions(+), 12 deletions(-)"].join("\n")),
  // Golden command 2: grep -n -e '略过' ... (CJK + options)
  shellRow("grep -n -e '略过' src/*.ts", ["src/adapter.ts:73:  // 略过 non-builtin tool rows", "1 match"].join("\n")),
  // Regular test run.
  shellRow("npm test", testOutput),
  // Golden command 3: python3 heredoc.
  shellRow("python3 - <<'EOF'\nprint(1)\nEOF", ["1"].join("\n")),
  // Golden command 4: bash script.sh 2>&1 | tail -50.
  shellRow("bash script.sh 2>&1 | tail -50", ["script output line one", "script output line two"].join("\n")),
  // Edit diff with Codex full-row surfaces.
  row("edit", { path: ".work/EverTrace_development_plan.md" }, result("Successfully replaced text.", { details: { diff: [
    "  2029 ", `- 2030 ${longOld}`, `+ 2030 ${longNew}`, "  2031 ",
  ].join("\n") } })),
  // Image preview disabled.
  row("read", { path: "figures/teaser.png" }, { content: [{ type: "image", data: "never-written-to-preview", mimeType: "image/png" }] }),
  // Running + error rows.
  shellRow("npm run check", "Checking TypeScript...", { isPartial: true }),
  shellRow("cat /protected/config.json", "cat: /protected/config.json: Permission denied\nCommand exited with code 1", { isError: true }),
];
const transcript = examples.join("\n\n") + "\n";
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
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex appearance 0.4 — renderer snapshot</title>
<style>body{margin:0;background:#0c0c0c;color:#e5e7eb;font:14px/1.55 ui-monospace,"DejaVu Sans Mono",Consolas,monospace}.label{padding:18px 28px;border-bottom:1px solid #27272a;color:#a1a1aa;font:12px/1.5 system-ui,sans-serif;letter-spacing:.03em}pre{white-space:pre;margin:0;padding:26px 28px 32px;tab-size:3;overflow:hidden}.note{padding:0 28px 24px;color:#888;font:12px/1.5 system-ui,sans-serif}</style>
<div class="label">pi-codex-appearance 0.4.0 · GENERATED FORMATTER/LAYOUT SNAPSHOT · NOT A LIVE PI SESSION</div>
<pre>${ansiHtml(transcript)}</pre><div class="note">Shell rows use the width-aware Codex exec-cell layout (Catppuccin Mocha bash palette, "  │ " continuation, "  └ " output with middle truncation). The edit block uses the same width-aware diff layout function as the Pi runtime adapter.</div></html>`;
mkdirSync(new URL("docs/", root), { recursive: true });
writeFileSync(new URL("docs/transcript.ansi", root), transcript);
writeFileSync(new URL("docs/transcript.txt", root), stripVTControlCharacters(transcript));
writeFileSync(new URL("docs/preview.html", root), html);
console.log("Wrote docs/transcript.ansi, docs/transcript.txt and docs/preview.html from the actual formatter/layout functions.");
