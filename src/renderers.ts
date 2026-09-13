// Display-only renderer registration for Pi's native two slots (call region = title/command, result region = output/diff body; never modifies tool data).

import { renderExplorationHeader, renderExplorationMember, renderExplorationImages, renderExplorationLines, explorationVerb, type ExplorationRow } from "./explore.ts";
import type { ExplorationPlan, TranscriptState } from "./transcript-state.ts";
import { asRecord, safeText, TOOL_NAMES, type ToolName, type Palette, type ViewContext, type ViewOptions, type TextFactory, type Highlight, type Renderers, type DiffFactory, type Component, type TextComponent, type DiffLayoutOps } from "./tool-names.ts";
import { parseDisplayDiff, diffStatsFromRows, renderDiffLines, type DiffStats } from "./diff.ts";
import type { WriteDiff } from "./write-tracker.ts";
import { resolveWriteStage, type WriteStage } from "./write-preview.ts";

export { asRecord, safeText, TOOL_NAMES } from "./tool-names.ts";
export type {
  ToolName, RecordValue, Palette, ViewContext, ViewOptions, Component, TextComponent,
  TextFactory, Highlight, Renderers, DiffComponentInput, DiffFactory, DiffLayoutOps,
} from "./tool-names.ts";
export { parseDisplayDiff, renderDiffLines } from "./diff.ts";
export type { DiffRow, DiffRowKind, DiffStats } from "./diff.ts";
export type { FileChange, FileChangeKind } from "./file-change.ts";

const PREVIEW_LINES = 5;
const COMMAND_LINES = 2;
const MAX_PREVIEW_LINE_CHARS = 1200;
const EXPLORATION = new Set<ToolName>(["read", "grep", "find", "ls"]);
const SHELL = new Set<ToolName>(["bash", "powershell"]);

function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function path(args: Record<string, unknown>, ctx: ViewContext): string {
  let value = string(args.path) || string(args.file_path);
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

export function languageForPath(filePath: string): string | undefined {
  const match = /\.([A-Za-z0-9]+)$/.exec(filePath);
  if (!match) return undefined;
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", md: "markdown", json: "json",
    sh: "bash", bash: "bash", ps1: "powershell", yaml: "yaml", yml: "yaml",
    toml: "toml", css: "css", html: "html", rb: "ruby", java: "java", c: "c",
    h: "c", cpp: "cpp", hpp: "cpp", sql: "sql",
  };
  return map[match[1]!.toLowerCase()];
}

/** Exploration title (call region): the FIRST grouped member owns the group header; later members render only their own row. */
export function explorationTitle(name: ToolName, ctx: ViewContext, theme: Palette, colorLevel: import("./palette.ts").ColorLevel = { kind: "ansi16" }): string {
  const args = asRecord(ctx.args);
  const done = ctx.isPartial === false;
  const verb = explorationVerb(name);
  const target = typeof args.pattern === "string" ? JSON.stringify(args.pattern) : path(args, ctx);
  const inPath = typeof args.pattern === "string" ? path(args, ctx) : undefined;
  let suffix = "";
  if (name === "read" && typeof args.offset === "number" && Number.isFinite(args.offset)) {
    const end = typeof args.limit === "number" && Number.isFinite(args.limit) ? `–${args.offset + args.limit - 1}` : " onward";
    suffix = ` (lines ${args.offset}${end})`;
  }
  const rows: ExplorationRow[] = [{ verb, target: `${target}${suffix}`, inPath }];
  const level = ctx.colorLevel ?? colorLevel;
  const plan: ExplorationPlan | undefined = ctx.explorationPlan as ExplorationPlan | undefined;
  if (!plan) {
    return renderExplorationLines(
      { running: !done, isError: ctx.isError === true, rows },
      level,
      theme,
    ).join("\n");
  }
  const header = plan.isHeaderOwner
    ? `${renderExplorationHeader({ running: plan.running, isError: ctx.isError === true }, level, theme)}\n`
    : "";
  const memberLine = renderExplorationMember(rows[0]!, { first: plan.isFirstMember }, level);
  // Aggregated image notice lives on the LAST member (once per group).
  const images = plan.isLastMember && !plan.running
    ? renderExplorationImages(plan.groupImages, level, ctx.showImages)
    : undefined;
  return [header + memberLine, images].filter(Boolean).join("\n");
}

/** Shell title (call region); errors keep "Ran" with a red bullet — failure surfaces in color, not the verb. */
export function shellTitle(ctx: ViewContext, theme: Palette): { bullet: string; title: string } {
  const done = ctx.isPartial === false;
  const bullet = theme.fg(ctx.isError ? "error" : done ? "success" : "dim", "•");
  const title = done ? "Ran" : "Running";
  return { bullet, title };
}

export function writeTitle(ctx: ViewContext, theme: Palette, change: WriteDiff | undefined): string {
  const args = asRecord(ctx.args);
  const done = ctx.isPartial === false;
  // While args stream the path may not have arrived yet (content-first providers): show a dim placeholder until the path frame lands.
  const rawPath = shortened(safeText(path(args, ctx)));
  const target = rawPath
    ? theme.fg("toolTitle", rawPath)
    : theme.fg("dim", "(path pending…)");
  if (!done) {
    return `${theme.fg("dim", "•")} ${theme.bold("Writing")} ${target}`;
  }
  if (ctx.isError === true) {
    return `${theme.fg("error", "•")} ${theme.bold("Failed")} ${target}`;
  }
  const bullet = theme.fg("success", "•");
  if (!change || change.kind === "unavailable") {
    const reason = change?.reason ? ` ${theme.fg("muted", `(${change.reason}; diff unavailable)`)}` : "";
    return `${bullet} ${theme.bold("Wrote")} ${target}${reason}`;
  }
  if (change.kind === "add") {
    return `${bullet} ${theme.bold("Added")} ${target} ${theme.fg("toolDiffAdded", `+${change.added}`)} ${theme.fg("toolDiffRemoved", "-0")}`;
  }
  if (change.kind === "update") {
    return `${bullet} ${theme.bold("Edited")} ${target} ${theme.fg("toolDiffAdded", `+${change.added}`)} ${theme.fg("toolDiffRemoved", `-${change.removed}`)}`;
  }
  if (change.kind === "unchanged") {
    return `${bullet} ${theme.bold("Wrote")} ${target} ${theme.fg("muted", "(unchanged)")}`;
  }
  return `${bullet} ${theme.bold("Failed")} ${target}`;
}

export function diffStats(value: unknown): DiffStats | undefined {
  const diff = asRecord(asRecord(value).details).diff;
  if (typeof diff !== "string") return undefined;
  return diffStatsFromRows(parseDisplayDiff(diff));
}

/** Shell call text for non-component hosts (title + command, never output). */
export function shellCallText(bullet: string, title: string, args: Record<string, unknown>, ctx: ViewContext, theme: Palette, paint?: Highlight): string {
  const value = string(args.command) || "…";
  const all = cleanLines(value);
  const expanded = ctx.expanded === true;
  const visible = expanded ? all : all.slice(0, COMMAND_LINES).map(shortened);
  if (!expanded && all.length > COMMAND_LINES) visible.push(`… +${all.length - COMMAND_LINES} command lines`);
  const [head = "…", ...rest] = visible;
  return `${bullet} ${theme.bold(title)} ${highlight(head, "bash", theme, paint)}`
    + rest.map((line) => `\n${theme.fg("dim", "  │ ")}${highlight(line, "bash", theme, paint)}`).join("");
}

// Legacy string formatters for non-component hosts and tests.

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
    sections.push(formatDisplayDiff(details.diff as string, theme));
  }
  if (name === "write" && !error && !options.isPartial && typeof asRecord(ctx.args).content === "string") {
    const written = cleanLines(asRecord(ctx.args).content as string);
    sections.push(gutter([`Written content (${written.length} lines)`], theme, "muted"));
    const code = written.map((line, i) => `${String(i + 1).padStart(4)} ${line}`);
    sections.push(gutter(preview(code, 12, expanded, hint), theme));
  }
  const foldedExploration = EXPLORATION.has(name) && !expanded && !error && !options.isPartial;
  if (lines.length && !foldedExploration && (!isDiff || expanded || !/^(Successfully replaced text|Successfully wrote)/.test(text.trim()))) {
    sections.push(gutter(preview(lines, PREVIEW_LINES, expanded, hint,
      SHELL.has(name) ? (options.isPartial ? "tail" : "both") : "head"), theme, error ? "error" : "toolOutput"));
  }
  if (!lines.length && error) sections.push(gutter(["Tool failed (no text output)"], theme, "error"));
  if (!lines.length && !error && options.isPartial) sections.push(gutter(["Running…"], theme, "dim"));
  if (SHELL.has(name) && !lines.length && !error && !options.isPartial) sections.push(gutter(["(no output)"], theme, "dim"));
  const images = blocks.filter((block) => block.type === "image").length;
  // Grouped members don't repeat the image notice; the group aggregates it once (call region).
  const groupedMember = EXPLORATION.has(name) && ctx.explorationPlan !== undefined;
  if (images && !groupedMember) sections.push(gutter([`${images} image${images === 1 ? "" : "s"}${ctx.showImages === false ? " (TUI preview disabled)" : ""}`], theme, "dim"));
  const other = blocks.filter((block) => block.type !== "text" && block.type !== "image");
  if (other.length) sections.push(gutter([`${other.length} additional non-text content block(s)`], theme, "dim"));
  return sections.filter(Boolean).join("\n");
}

export function formatCall(name: ToolName, input: unknown, theme: Palette, ctx: ViewContext, stats?: DiffStats, paint?: Highlight): string {
  const args = asRecord(input);
  const done = ctx.isPartial === false;
  if (EXPLORATION.has(name)) {
    return explorationTitle(name, { ...ctx, args: input }, theme);
  }
  if (SHELL.has(name)) {
    const { bullet, title } = shellTitle(ctx, theme);
    return shellCallText(bullet, title, args, ctx, theme, paint);
  }
  const marker = theme.fg(ctx.isError ? "error" : done ? "success" : "dim", "•");
  const label = ctx.isError ? "Failed" : name === "edit" ? (done ? "Edited" : "Editing") : (done ? "Wrote" : "Writing");
  let suffix = "";
  if (name === "edit" && stats && ctx.isError !== true) suffix = ` (${theme.fg("toolDiffAdded", `+${stats.added}`)} ${theme.fg("toolDiffRemoved", `-${stats.removed}`)})`;
  return `${marker} ${theme.bold(label)} ${theme.fg("toolTitle", shortened(safeText(path(args, ctx))))}${suffix}`;
}

export interface WritePreviewInput {
  name: ToolName; args: Record<string, unknown>; stage: WriteStage; contentPrefix: string;
  expanded: boolean; theme: Palette; context: ViewContext; expandHint: string;
  colorLevel: import("./palette.ts").ColorLevel;
  /** Call slot's structured header (always present above the body). */
  headerText?: string;
}

export interface ShellFactories {
  makeShellCall?: (input: {
    name: ToolName; bullet: string; title: string; args: Record<string, unknown>;
    options: ViewOptions; theme: Palette; context: ViewContext; expandHint: string;
    colorLevel: import("./palette.ts").ColorLevel;
  }) => Component;
  makeShellResult?: (input: {
    name: ToolName; args: Record<string, unknown>; result: unknown;
    options: ViewOptions; theme: Palette; context: ViewContext; expandHint: string;
    colorLevel: import("./palette.ts").ColorLevel;
  }) => Component;
}

/** Only presentation data crosses into the tool renderers. */
export interface RendererSession {
  readonly colorLevel: import("./palette.ts").ColorLevel;
  readonly writeChanges: ReadonlyMap<string, WriteDiff>;
  readonly transcript?: Pick<TranscriptState, "explorationPlan">;
}

export function makeRenderers(
  makeText: TextFactory,
  expandHint: () => string,
  paint?: Highlight,
  makeDiff?: DiffFactory,
  makeShell?: ShellFactories,
  makeWriteCall?: (input: WritePreviewInput & { headerText: string }) => Component | undefined,
  session?: RendererSession,
  layoutOps?: DiffLayoutOps,
): Record<ToolName, Renderers> {
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
    // Reuse only OUR Text components that have setText; the write-call composite
    // is ours but setText-less (calling it threw TypeError, host silently fell back).
    const reusable = previous && typeof previous === "object" && ownComponents.has(previous)
      && typeof (previous as { setText?: unknown }).setText === "function";
    if (reusable) {
      (previous as TextComponent).setText(text);
      return previous as TextComponent;
    }
    const created = makeText(text);
    if (created && typeof created === "object") ownComponents.add(created);
    return created;
  }
  function writeChangeFor(ctx: ViewContext): WriteDiff | undefined {
    // Injected change (tests/preview/host without tracker wiring) wins; then the tracker keyed by toolCallId.
    if (ctx.writeChanges && typeof ctx.writeChanges === "object") return ctx.writeChanges as WriteDiff;
    const toolCallId = typeof ctx.toolCallId === "string" ? ctx.toolCallId : undefined;
    return toolCallId && session ? session.writeChanges.get(toolCallId) : undefined;
  }
  function colorFor(ctx: ViewContext): import("./palette.ts").ColorLevel {
    return ctx.colorLevel ?? session?.colorLevel ?? { kind: "ansi16" };
  }
  const layout: DiffLayoutOps = layoutOps ?? { wrap: (text) => [text], visibleWidth: (text) => text.length };

  function writeBody(result: unknown, options: ViewOptions, theme: Palette, ctx: ViewContext): Component {
    const args = asRecord(ctx.args);
    const expanded = options.expanded === true;
    const error = ctx.isError === true || asRecord(result).isError === true;
    const hint = expandHint();
    const contentArg = typeof args.content === "string" ? args.content : undefined;

    if (error) {
      const blocks = Array.isArray(asRecord(result).content) ? (asRecord(result).content as unknown[]).map(asRecord) : [];
      const text = blocks.filter((block) => block.type === "text").map((block) => string(block.text)).join("\n");
      const lines = cleanLines(text);
      const head = gutter(["write failed"], theme, "error");
      const body = lines.length ? gutter(preview(lines, PREVIEW_LINES, expanded, hint), theme, "error") : "";
      const attempted = contentArg
        ? gutter(expanded
            ? ["attempted content (not written):", ...cleanLines(contentArg).map((line, i) => `${String(i + 1).padStart(4)} ${line}`)]
            : ["attempted content (not written) — expand to view"], theme, "muted")
        : "";
      return component([head, body, attempted].filter(Boolean).join("\n"), ctx);
    }

    const change = writeChangeFor(ctx);
    if (change && (change.kind === "add" || change.kind === "update") && change.rows?.length) {
      const filePath = path(args, ctx);
      if (makeDiff) {
        return makeDiff({ rows: change.rows, filePath, theme, context: ctx, options, expandHint: hint });
      }
      const rendered = renderDiffLines({
        rows: change.rows, width: 100, layout, colorLevel: colorFor(ctx),
        language: languageForPath(filePath), paint, expanded, expandHint: hint,
      });
      return component(rendered.join("\n"), ctx);
    }

    // unchanged/unavailable/no tracker: preview from the call's own args — never a fabricated +N/-0.
    if (contentArg === undefined) return component("", ctx);
    const lines = cleanLines(contentArg);
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(4)} ${line}`);
    const label = change?.kind === "unchanged"
      ? "written content (unchanged)"
      : `written content (${lines.length} lines)`;
    const head = gutter([label], theme, "muted");
    const body = gutter(preview(numbered, PREVIEW_LINES, expanded, hint), theme);
    return component([head, body].filter(Boolean).join("\n"), ctx);
  }

  return Object.fromEntries<Renderers>(TOOL_NAMES.map((name) => [name, {
    renderCall(args: unknown, theme: Palette, ctx: ViewContext) {
      // Pi passes the same args in both slots; merge so title builders can read args from either source.
      const merged: ViewContext = ctx.args === undefined ? { ...ctx, args } : ctx;
      if (SHELL.has(name)) {
        const { bullet, title } = shellTitle(merged, theme);
        if (makeShell?.makeShellCall) {
          return makeShell.makeShellCall({
            name, bullet, title, args: asRecord(args),
            options: { isPartial: merged.isPartial, expanded: merged.expanded },
            theme, context: merged, expandHint: expandHint(), colorLevel: colorFor(merged),
          });
        }
        return component(shellCallText(bullet, title, asRecord(args), merged, theme, paint), ctx);
      }
      if (name === "write") {
        // Call slot ALWAYS owns a structured header: it stays visible through
        // arg streaming and completion; the live preview is a body UNDER it,
        // never a replacement.
        const hasResult = merged.isPartial === false;
        const contentPrefix = typeof asRecord(args).content === "string" ? (asRecord(args).content as string) : "";
        const stage = resolveWriteStage({
          argsComplete: merged.argsComplete === true,
          executionStarted: merged.executionStarted === true,
          isPartial: merged.isPartial === true,
          isError: merged.isError === true,
          hasResult: merged.isPartial === false,
        });
        if (makeWriteCall && !hasResult) {
          const input: WritePreviewInput & { headerText: string } = {
            name, args: asRecord(args), stage, contentPrefix,
            headerText: writeTitle(merged, theme, writeChangeFor(merged)),
            expanded: merged.expanded === true, theme, context: merged,
            expandHint: expandHint(), colorLevel: colorFor(merged),
          };
          // Reuse our previous call component when the host hands it back (updateArgs → lastComponent); update in place, never mutate a foreign instance.
          const previous = ctx.lastComponent;
          if (previous && typeof previous === "object" && ownComponents.has(previous)
              && typeof (previous as { update?: unknown }).update === "function") {
            (previous as { update: (next: typeof input) => void }).update(input);
            return previous as Component;
          }
          const callComponent = makeWriteCall(input);
          if (callComponent && typeof callComponent === "object") {
            ownComponents.add(callComponent);
            return callComponent;
          }
        }
        return component(writeTitle(merged, theme, writeChangeFor(merged)), ctx);
      }
      if (EXPLORATION.has(name)) {
        const plan = merged.explorationPlan
          ?? session?.transcript?.explorationPlan?.(typeof merged.toolCallId === "string" ? merged.toolCallId : "");
        return component(explorationTitle(name, { ...merged, explorationPlan: plan }, theme, colorFor(merged)), ctx);
      }
      const state = view(ctx);
      const call = component(formatCall(name, args, theme, merged, state?.stats, paint), ctx);
      if (state) state.call = call;
      return call;
    },
    renderResult(result: unknown, options: ViewOptions, theme: Palette, ctx: ViewContext) {
      if (name === "edit") {
        const state = view(ctx);
        if (state) {
          state.stats = diffStats(result);
          state.call?.setText(formatCall(name, ctx.args, theme, ctx, state.stats, paint));
        }
      }
      if (name === "edit" && ctx.isError !== true) {
        const details = asRecord(asRecord(result).details);
        if (typeof details.diff === "string") {
          const rows = parseDisplayDiff(details.diff);
          const filePath = path(asRecord(ctx.args), ctx);
          if (makeDiff) {
            return makeDiff({ rows, filePath, theme, context: ctx, options, expandHint: expandHint() });
          }
          return component(renderDiffLines({
            rows, width: 100, layout, colorLevel: colorFor(ctx),
            language: languageForPath(filePath), paint,
            expanded: options.expanded === true, expandHint: expandHint(),
          }).join("\n"), ctx);
        }
      }
      if (name === "write") {
        if (options.isPartial) return component("", ctx);
        return writeBody(result, options, theme, ctx);
      }
      if (SHELL.has(name) && makeShell?.makeShellResult) {
        return makeShell.makeShellResult({
          name, args: asRecord(ctx.args), result, options, theme, context: ctx,
          expandHint: expandHint(), colorLevel: colorFor(ctx),
        });
      }
      return component(formatResult(name, result, options, theme, ctx, expandHint()), ctx);
    },
  }])) as Record<ToolName, Renderers>;
}
