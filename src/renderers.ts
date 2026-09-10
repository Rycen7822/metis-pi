// Derived from DanielSuhett/pi-codex-style (MIT). See LICENSE and NOTICE.
// Every transformation in this module affects a DISPLAY string/component only.
export const TOOL_NAMES = ["bash", "powershell", "read", "grep", "find", "ls", "edit", "write"] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type RecordValue = Readonly<Record<string, unknown>>;
export interface Palette { fg(color: string, text: string): string; bold(text: string): string }
export interface ViewContext {
  readonly args?: unknown;
  readonly cwd?: string;
  readonly state?: unknown;
  readonly isPartial?: boolean;
  readonly isError?: boolean;
  readonly executionStarted?: boolean;
  readonly expanded?: boolean;
  readonly showImages?: boolean;
  readonly lastComponent?: unknown;
}
export interface ViewOptions { readonly expanded?: boolean; readonly isPartial?: boolean }
export interface Component { render(width: number): string[] }
export interface TextComponent extends Component { setText(text: string): void }
export type TextFactory = (text: string) => TextComponent;
export type Highlight = (text: string, language: string) => string;
export interface Renderers {
  renderCall(args: unknown, theme: Palette, context: ViewContext): Component;
  renderResult(result: unknown, options: ViewOptions, theme: Palette, context: ViewContext): Component;
}
export interface DiffStats { added: number; removed: number }
export type DiffRowKind = "add" | "remove" | "context" | "separator" | "metadata";
export interface DiffRow {
  readonly kind: DiffRowKind;
  readonly lineNumber?: number;
  readonly content: string;
}
export interface DiffComponentInput {
  readonly diff: string;
  readonly filePath: string;
  readonly theme: Palette;
  readonly context: ViewContext;
  readonly options: ViewOptions;
}
export type DiffFactory = (input: DiffComponentInput) => Component;

export interface DiffLayoutOps {
  wrap(text: string, width: number): string[];
  visibleWidth(text: string): number;
}
export const CODEX_DIFF_DARK_ADD_BG = [33, 58, 43] as const; // #213A2B
export const CODEX_DIFF_DARK_DEL_BG = [74, 34, 29] as const; // #4A221D
const DIFF_LEFT_INSET = 2;
const BG_RESET = "\x1b[49m";
const DIM_ON = "\x1b[2m";
const INTENSITY_RESET = "\x1b[22m";
const PREVIEW_LINES = 5;
const COMMAND_LINES = 2;
const MAX_PREVIEW_LINE_CHARS = 1200;
const EXPLORATION = new Set<ToolName>(["read", "grep", "find", "ls"]);
const SHELL = new Set<ToolName>(["bash", "powershell"]);
export function asRecord(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
export function safeText(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function path(args: RecordValue, ctx: ViewContext): string {
  let value = string(args.path) || string(args.file_path) || ".";
  if (ctx.cwd && value.startsWith(`${ctx.cwd}/`)) value = value.slice(ctx.cwd.length + 1);
  return value;
}
function cleanLines(text: string): string[] {
  const lines = safeText(text).split("\n");
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines;
}
function shortened(line: string): string {
  return line.length > MAX_PREVIEW_LINE_CHARS
    ? `${line.slice(0, MAX_PREVIEW_LINE_CHARS).replace(/[\ud800-\udbff]$/, "")} … [line shortened in preview]` : line;
}
function preview(lines: string[], limit: number, expanded: boolean, hint: string, mode: "head" | "tail" | "both" = "head"): string[] {
  if (expanded) return lines;
  let selected = lines;
  if (lines.length > limit) {
    const notice = `… +${lines.length - limit} lines (${hint})`;
    if (mode === "tail") selected = [notice, ...lines.slice(-limit)];
    else if (mode === "both") {
      const head = Math.floor(limit / 2);
      selected = [...lines.slice(0, head), notice, ...lines.slice(-(limit - head))];
    } else selected = [...lines.slice(0, limit), notice];
  }
  const shortenedLines = selected.map(shortened);
  if (shortenedLines.some((line) => line.endsWith("[line shortened in preview]"))) shortenedLines.push(`(${hint} for the complete text)`);
  return shortenedLines;
}
function gutter(lines: readonly string[], theme: Palette, color = "toolOutput"): string {
  return lines.map((line, i) => `${theme.fg("dim", i === 0 ? "  └ " : "    ")}${theme.fg(color, line)}`).join("\n");
}
function highlight(text: string, language: string, theme: Palette, paint?: Highlight): string {
  try { if (paint) return paint(text, language); } catch { /* Syntax colouring is optional. */ }
  return theme.fg("toolTitle", text);
}
export function parseDisplayDiff(diffText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const raw of safeText(diffText).split("\n")) {
    if (/^\s*\.\.\.\s*$/.test(raw)) {
      rows.push({ kind: "separator", content: "…" });
      continue;
    }
    // Pi 0.85.x EditToolDetails.diff is display-oriented:
    //   "- 2030 old", "+ 2030 new", "  2029 context".
    // Keep the parser deliberately narrow so arbitrary tool text is never
    // reinterpreted as a diff.
    const match = raw.match(/^([+\- ])(\s*\d*)\s(.*)$/);
    if (match) {
      const lineNumberText = match[2].trim();
      const lineNumber = lineNumberText ? Number(lineNumberText) : undefined;
      rows.push({
        kind: match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "context",
        lineNumber: Number.isFinite(lineNumber) ? lineNumber : undefined,
        content: match[3].replace(/\t/g, "    "),
      });
      continue;
    }
    if (raw.length) rows.push({ kind: "metadata", content: raw.replace(/\t/g, "    ") });
  }
  return rows;
}

export function diffStats(value: unknown): DiffStats | undefined {
  const diff = asRecord(asRecord(value).details).diff;
  if (typeof diff !== "string") return undefined;
  const rows = parseDisplayDiff(diff);
  return {
    added: rows.filter((row) => row.kind === "add").length,
    removed: rows.filter((row) => row.kind === "remove").length,
  };
}

/** Plain fallback used by tests/non-rich hosts. The live Pi adapter supplies a
 * width-aware component that adds Codex's full-row diff backgrounds. */
export function formatDisplayDiff(diffText: string, theme: Palette): string {
  const rows = parseDisplayDiff(diffText);
  const width = Math.max(1, ...rows.map((row) => row.lineNumber === undefined ? 0 : String(row.lineNumber).length));
  return rows.map((row) => {
    if (row.kind === "separator") return theme.fg("dim", `${" ".repeat(width + 4)}…`);
    if (row.kind === "metadata") return theme.fg("dim", `  ${row.content}`);
    const number = row.lineNumber === undefined ? " ".repeat(width) : String(row.lineNumber).padStart(width);
    const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
    const signColor = row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : "dim";
    const contentColor = row.kind === "remove" ? "muted" : row.kind === "add" ? "toolTitle" : "toolDiffContext";
    return `  ${theme.fg("dim", number)} ${theme.fg(signColor, sign)}${theme.fg(contentColor, row.content)}`.trimEnd();
  }).join("\n");
}
export function renderCodexDiffLines(
  diffText: string,
  width: number,
  theme: Palette,
  layout: DiffLayoutOps,
): string[] {
  const usableWidth = Math.max(1, Math.floor(width));
  const rows = parseDisplayDiff(diffText);
  const numberWidth = Math.max(
    1,
    ...rows.map((row) => row.lineNumber === undefined ? 0 : String(row.lineNumber).length),
  );
  const prefixWidth = DIFF_LEFT_INSET + numberWidth + 2; // number + space + sign
  const contentWidth = Math.max(1, usableWidth - prefixWidth);
  const out: string[] = [];

  const fillBackground = (line: string, rgb: readonly [number, number, number]): string => {
    const visible = layout.visibleWidth(line);
    const padded = `${line}${" ".repeat(Math.max(0, usableWidth - visible))}`;
    return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${padded}${BG_RESET}`;
  };

  for (const row of rows) {
    if (row.kind === "separator") {
      out.push(theme.fg("dim", `${" ".repeat(prefixWidth)}…`));
      continue;
    }
    if (row.kind === "metadata") {
      const chunks = layout.wrap(row.content, Math.max(1, usableWidth - DIFF_LEFT_INSET));
      for (const chunk of chunks.length ? chunks : [""]) {
        out.push(theme.fg("dim", `${" ".repeat(DIFF_LEFT_INSET)}${chunk}`));
      }
      continue;
    }

    const number = row.lineNumber === undefined ? " ".repeat(numberWidth) : String(row.lineNumber).padStart(numberWidth);
    const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
    const signColor = row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : "dim";
    const chunks = layout.wrap(row.content, contentWidth);
    const physical = chunks.length ? chunks : [""];

    for (let i = 0; i < physical.length; i++) {
      const prefix = i === 0
        ? `${" ".repeat(DIFF_LEFT_INSET)}${theme.fg("dim", number)} ${theme.fg(signColor, sign)}`
        : " ".repeat(prefixWidth);
      let content = "";
      if (physical[i]) {
        if (row.kind === "remove") content = `${DIM_ON}${theme.fg("toolTitle", physical[i])}${INTENSITY_RESET}`;
        else if (row.kind === "add") content = theme.fg("toolTitle", physical[i]);
        else content = theme.fg("toolDiffContext", physical[i]);
      }
      const line = `${prefix}${content}`;
      if (row.kind === "add") out.push(fillBackground(line, CODEX_DIFF_DARK_ADD_BG));
      else if (row.kind === "remove") out.push(fillBackground(line, CODEX_DIFF_DARK_DEL_BG));
      else out.push(line.trimEnd());
    }
  }
  return out;
}

export function formatCall(name: ToolName, input: unknown, theme: Palette, ctx: ViewContext, stats?: DiffStats, paint?: Highlight): string {
  const args = asRecord(input);
  const done = ctx.isPartial === false;
  const marker = theme.fg(ctx.isError ? "error" : "dim", "•");
  if (EXPLORATION.has(name)) {
    const title = ctx.isError ? "Exploration failed" : done ? "Explored" : "Exploring";
    const verbs = { read: "Read", grep: "Search", find: "Find", ls: "List" } as const;
    let description = `${verbs[name as keyof typeof verbs]} ${path(args, ctx)}`;
    if (name === "grep" || name === "find") description = `${verbs[name]} ${JSON.stringify(string(args.pattern))} in ${path(args, ctx)}`;
    if (name === "read" && typeof args.offset === "number" && Number.isFinite(args.offset)) {
      const end = typeof args.limit === "number" && Number.isFinite(args.limit) ? `–${args.offset + args.limit - 1}` : " onward";
      description += ` (lines ${args.offset}${end})`;
    }
    return `${marker} ${theme.bold(title)}\n${gutter([shortened(safeText(description))], theme, "toolTitle")}`;
  }
  if (SHELL.has(name)) {
    const value = string(args.command) || "…";
    const all = cleanLines(value);
    const visible = ctx.expanded ? all : all.slice(0, COMMAND_LINES).map(shortened);
    if (!ctx.expanded && all.length > COMMAND_LINES) visible.push(`… +${all.length - COMMAND_LINES} command lines`);
    const [head = "…", ...rest] = visible;
    const language = name === "powershell" ? "powershell" : "bash";
    const label = done ? "Ran" : "Running";
    const shellMarker = theme.fg(ctx.isError ? "error" : done ? "success" : "dim", "•");
    return `${shellMarker} ${theme.bold(label)} ${highlight(head, language, theme, paint)}`
      + rest.map((line) => `\n${theme.fg("dim", "  │ ")}${highlight(line, language, theme, paint)}`).join("");
  }
  const label = ctx.isError ? "Failed" : name === "edit" ? (done ? "Edited" : "Editing") : (done ? "Wrote" : "Writing");
  let suffix = "";
  if (name === "edit" && stats && !ctx.isError) suffix = ` (${theme.fg("toolDiffAdded", `+${stats.added}`)} ${theme.fg("toolDiffRemoved", `-${stats.removed}`)})`;
  return `${marker} ${theme.bold(label)} ${theme.fg("toolTitle", shortened(safeText(path(args, ctx))))}${suffix}`;
}
export function formatResult(name: ToolName, value: unknown, options: ViewOptions, theme: Palette, ctx: ViewContext, hint = "expand tool output"): string {
  const result = asRecord(value);
  const blocks = Array.isArray(result.content) ? result.content.map(asRecord) : [];
  const text = blocks.filter((block) => block.type === "text").map((block) => string(block.text)).join("\n");
  const lines = cleanLines(text);
  const expanded = options.expanded === true;
  const error = ctx.isError === true || result.isError === true;
  const details = asRecord(result.details);
  const sections: string[] = [];
  const isDiff = name === "edit" && !error && typeof details.diff === "string";
  if (isDiff) {
    // EditToolDetails.diff already contains a compact context window. Codex
    // displays that window in full instead of applying a second arbitrary
    // line-count truncation.
    sections.push(formatDisplayDiff(details.diff as string, theme));
  }
  if (name === "write" && !error && !options.isPartial && typeof asRecord(ctx.args).content === "string") {
    // A write can overwrite an existing file: show written content, not a fabricated +N/-0 diff.
    const written = cleanLines(asRecord(ctx.args).content as string);
    sections.push(gutter([`Written content (${written.length} lines)`], theme, "muted"));
    const code = written.map((line, i) => `${String(i + 1).padStart(4)} ${line}`);
    sections.push(gutter(preview(code, 12, expanded, hint), theme));
  }
  // Codex-like exploration rows are compact when completed. The native click/
  // expand action still reveals ALL original text. Errors are never hidden.
  const foldedExploration = EXPLORATION.has(name) && !expanded && !error && !options.isPartial;
  if (lines.length && !foldedExploration && (!isDiff || expanded || !/^(Successfully replaced text|Successfully wrote)/.test(text.trim()))) {
    sections.push(gutter(preview(lines, PREVIEW_LINES, expanded, hint,
      SHELL.has(name) ? (options.isPartial ? "tail" : "both") : "head"), theme, error ? "error" : "toolOutput"));
  }
  if (!lines.length && error) sections.push(gutter(["Tool failed (no text output)"], theme, "error"));
  if (!lines.length && !error && options.isPartial) sections.push(gutter(["Running…"], theme, "dim"));
  if (SHELL.has(name) && !lines.length && !error && !options.isPartial) sections.push(gutter(["(no output)"], theme, "dim"));
  const images = blocks.filter((block) => block.type === "image").length;
  if (images) sections.push(gutter([`${images} image${images === 1 ? "" : "s"}${ctx.showImages === false ? " (TUI preview disabled)" : ""}`], theme, "dim"));
  const other = blocks.filter((block) => block.type !== "text" && block.type !== "image");
  if (other.length) sections.push(gutter([`${other.length} additional non-text content block(s)`], theme, "dim"));
  return sections.filter(Boolean).join("\n");
}
export function makeRenderers(makeText: TextFactory, expandHint: () => string, paint?: Highlight, makeDiff?: DiffFactory): Record<ToolName, Renderers> {
  const ownComponents = new WeakSet<object>();
  const views = new WeakMap<object, { call?: TextComponent; stats?: DiffStats }>();
  function view(ctx: ViewContext) {
    if (!ctx.state || typeof ctx.state !== "object") return undefined;
    let state = views.get(ctx.state);
    if (!state) { state = {}; views.set(ctx.state, state); }
    return state;
  }
  function component(text: string, ctx: ViewContext): TextComponent {
    const previous = ctx.lastComponent;
    if (previous && typeof previous === "object" && ownComponents.has(previous)) {
      (previous as TextComponent).setText(text);
      return previous as TextComponent;
    }
    const created = makeText(text);
    ownComponents.add(created);
    return created;
  }
  return Object.fromEntries<Renderers>(TOOL_NAMES.map((name) => [name, {
    renderCall(args: unknown, theme: Palette, ctx: ViewContext) {
      const state = view(ctx);
      const call = component(formatCall(name, args, theme, ctx, state?.stats, paint), ctx);
      if (state) state.call = call;
      return call;
    },
    renderResult(result: unknown, options: ViewOptions, theme: Palette, ctx: ViewContext) {
      const state = view(ctx);
      if (state && name === "edit") {
        state.stats = diffStats(result);
        // Update only our own Text component, never ctx.state or a tool definition.
        state.call?.setText(formatCall(name, ctx.args, theme, ctx, state.stats, paint));
      }
      if (name === "edit" && makeDiff && ctx.isError !== true) {
        const details = asRecord(asRecord(result).details);
        if (typeof details.diff === "string") {
          return makeDiff({
            diff: details.diff, filePath: path(asRecord(ctx.args), ctx),
            theme, context: ctx, options,
          });
        }
      }
      return component(formatResult(name, result, options, theme, ctx, expandHint()), ctx);
    },
  }])) as Record<ToolName, Renderers>;
}
