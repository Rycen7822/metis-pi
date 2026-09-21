import { readFileSync } from "node:fs";
import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { activate, type AppearanceAPI } from "../src/extension.ts";
import { renderCodexDiffComponent, type DiffComponentInput } from "../src/diff-component.ts";
import { renderShellCall, renderShellResult, type LayoutOps } from "../src/shell.ts";
import { CODEX_CYAN_RGB, resolveColorContext } from "../src/palette.ts";
import { makeSurfaceOps } from "../src/surface.ts";
import { loadConfig } from "../src/config.ts";
import { thoughtSummaryText } from "../src/thinking-summary.ts";
import { registerProduct, publishRows, releaseCopyCache } from "../src/selection-copy/model.ts";
import {
  CodexSeparatorComponent, CodexWriteCallComponent, CodexThinkingRailComponent,
  CodexThinkingPeekComponent, CodexThinkingClickableComponent,
} from "../src/chrome/transcript-components.ts";
import type { CopyRow } from "../src/selection-copy/model.ts";
import type { ToolName } from "../src/tool-names.ts";

function layoutOps(): LayoutOps {
  return {
    wrap: (text: string, columns: number) => Tui.wrapTextWithAnsi(text, columns),
    visibleWidth: (text: string) => Tui.visibleWidth(text),
  };
}

/** Host updates create new tool regions. One cache owns both displayed rows
 * and copy provenance; invalidation releases them together. */
function cachedRowsComponent(componentId: string, renderRows: (width: number, copyOut: CopyRow[]) => string[]): Tui.Component {
  let cache: { width: number; rows: string[] } | undefined;
  return {
    render(width) {
      if (!cache || cache.width !== width) {
        const copyOut: CopyRow[] = [];
        const rows = renderRows(width, copyOut);
        if (copyOut.length === rows.length) registerProduct(rows, { componentId, width, rows: copyOut });
        cache = { width, rows };
      }
      publishRows(this, cache.rows);
      return cache.rows;
    },
    invalidate() { cache = undefined; releaseCopyCache(this); },
  };
}

function createDiffComponent(input: DiffComponentInput): Tui.Component {
  return cachedRowsComponent("diff", (width, copyOut) => renderCodexDiffComponent(input, width, layoutOps(), copyOut));
}

/** Call region: bullet + bold title + highlighted command with "  │ "
 * continuation. Never renders output — the result region owns that. */
interface ShellCallInput {
  name: ToolName; bullet: string; title: string; args: Record<string, unknown>;
  options: { expanded?: boolean; isPartial?: boolean };
  colorLevel: import("../src/palette.ts").ColorLevel;
}
function createShellCallComponent(input: ShellCallInput): Tui.Component {
  return cachedRowsComponent("shell-call", (width, copyOut) => renderShellCall({
    row: {
      title: input.title,
      isError: false,
      isPartial: input.options.isPartial === true,
      command: String(input.args.command ?? ""),
      language: input.name === "powershell" ? "powershell" : "bash",
      output: "",
      expanded: input.options.expanded === true,
      expandHint: "",
    },
    width,
    layout: layoutOps(),
    colorLevel: input.colorLevel,
    bullet: input.bullet,
    titlePainter: (title) => title,
    copyOut,
  }));
}

/**
 * The terminal's color capability cannot change mid-session, so resolve it once
 * per process: every render path (separator, thinking rail, thought summary
 * painter, composer surface) then shares one context instead of re-probing the
 * host on each frame.
 */
let cachedColorLevel: ReturnType<typeof resolveColorContext> | undefined;
function colorLevelOnce(): ReturnType<typeof resolveColorContext> {
  return (cachedColorLevel ??= resolveColorContext({ terminalTrueColor: Tui.getCapabilities?.()?.trueColor === true }));
}

/**
 * Result region: output block with "  └ "/"    " prefixes and the 5-screen-row
 * budget. Never renders a command head.
 */
interface ShellResultInput {
  name: ToolName; result: unknown;
  options: { expanded?: boolean; isPartial?: boolean }; isError: boolean;
  bullet: string;
  expandHint: string;
  colorLevel: import("../src/palette.ts").ColorLevel;
}

function createShellResultComponent(input: ShellResultInput): Tui.Component {
  return cachedRowsComponent("shell-result", (width, copyOut) => {
    const result = input.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | null;
    const output = Array.isArray(result?.content)
      ? result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
      : "";
    return renderShellResult({
      row: {
        title: "",
        isError: input.isError,
        isPartial: input.options.isPartial === true,
        command: "",
        language: input.name === "powershell" ? "powershell" : "bash",
        output,
        expanded: input.options.expanded === true,
        expandHint: input.expandHint,
      },
      width,
      layout: layoutOps(),
      colorLevel: input.colorLevel,
      bullet: input.bullet,
      titlePainter: (title) => title,
      copyOut,
    });
  });
}

/** Real package version, read once from the repo-root package.json —
 * never hardcoded (diagnostics and the header show this value). */
function appearanceVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Painter for the collapsed thought summary: italic + the active theme's
 * `thinkingText` when the host exposes `getResolvedThemeColors` (deep theme
 * imports are blocked by the package exports map and pi 0.85.1 does not
 * re-export the resolver), otherwise this theme's muted #a3a3a3. No-color
 * terminals get plain text.
 */
function thoughtPainter(): (text: string) => string {
  const level = colorLevelOnce();
  if (level.kind === "none") return (text) => text;
  let hex = "#a3a3a3"; // this theme's thinkingText (muted) — the fallback
  try {
    const colors = (Pi as unknown as { getResolvedThemeColors?: () => Record<string, string> }).getResolvedThemeColors?.();
    if (colors && typeof colors.thinkingText === "string" && /^#[0-9a-f]{6}$/i.test(colors.thinkingText)) hex = colors.thinkingText;
  } catch { /* fall back to the muted default */ }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (text) => `\x1b[3m\x1b[38;2;${r};${g};${b}m${text}\x1b[39m\x1b[23m`;
}

let thoughtPaint: ((text: string) => string) | undefined;

/** Default entry: compact Codex-style transcript, without changing tool data. */
export default function codexAppearance(pi: AppearanceAPI): void {
  const prototype = Pi.ToolExecutionComponent?.prototype;
  const assistantComponent = Pi.AssistantMessageComponent as unknown as { prototype: object } | undefined;
  if (!prototype || typeof Tui.Text !== "function" || typeof Pi.keyHint !== "function"
      || typeof Tui.wrapTextWithAnsi !== "function" || typeof Tui.visibleWidth !== "function") {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("metis-pi: unsupported Pi UI exports; compact transcript was not installed.", "warning");
    });
    return;
  }
  const colorLevel = colorLevelOnce();
  const highlight = (text: string, language: string): string => {
    const lines = Pi.highlightCode(text, language);
    return Array.isArray(lines) ? lines.join("\n") : String(lines);
  };
  // Gray composer surface painters, built from the REAL Tui helpers so src/
  // keeps its no-host-import rule.
  const surface = makeSurfaceOps(
    colorLevel,
    (text) => `\x1b[38;2;${CODEX_CYAN_RGB}m${text}\x1b[39m`,
    (text) => `\x1b[2m${text}\x1b[22m`,
  );
  // Config access shared by activate() and the write-preview budget below.
  // PI_AGENT_DIR override is respected by Pi itself; we only need the PATH,
  // never auth contents.
  const getAgentDir = (): string => {
    const fromEnv = process.env.PI_AGENT_DIR;
    if (fromEnv) return fromEnv;
    const fromOs = (Pi as unknown as { getAgentDir?: () => string }).getAgentDir?.();
    return fromOs ?? `${process.env.HOME ?? ""}/.pi/agent`;
  };
  const readFile = (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  // One boot-time read from the same path activate() resolves.
  const bootWritePreview = loadConfig(getAgentDir(), readFile).config.writePreview;

  activate(pi, {
    getAgentDir,
    readFile,
    prototype,
    makeText: (text) => new Tui.Text(text, 0, 0),
    makeDiff: (input) => createDiffComponent({
      rows: input.rows, filePath: input.filePath, paint: highlight,
      colorLevel, expanded: input.options.expanded === true,
      expandHint: input.expandHint ?? "",
    }),
    makeShell: {
      makeShellCall: (input) => createShellCallComponent({
        name: input.name, bullet: input.bullet, title: input.title, args: input.args,
        options: input.options, colorLevel: input.colorLevel,
      }),
      makeShellResult: (input) => createShellResultComponent({
        name: input.name, result: input.result,
        options: input.options, isError: input.context.isError === true,
        bullet: input.theme.fg(input.context.isError ? "error" : input.options.isPartial ? "dim" : "success", "•"),
        expandHint: input.expandHint, colorLevel: input.colorLevel,
      }),
    },
    expandHint: () => Pi.keyHint("app.tools.expand", "to expand"),
    highlight,
    colorLevel,
    layoutOps: layoutOps(),
    assistantPrototype: assistantComponent?.prototype,
    makeSeparator: () => new CodexSeparatorComponent(colorLevel),
    makeSpacer: () => new Tui.Spacer(1),
    makeRail: (child) => new CodexThinkingRailComponent(child as Tui.Component, colorLevel),
    makePeek: (input) => new CodexThinkingPeekComponent(
      input.inner as Tui.Component,
      input.control,
      input.windowLines,
      (text) => surface.paintGlyph(text, "dim"),
      input.onScroll,
    ),
    makeClickable: (input) => new CodexThinkingClickableComponent(
      input.inner as Tui.Component,
      input.control,
      input.fallback,
      input.apply,
    ),
    // Collapsed thinking run: a real Tui.Text so selection-copy mirrors it
    // like any other host label (the hidden reasoning body is not rendered
    // anywhere and can never be copied). Painter memoized — label building
    // must stay O(1).
    makeThoughtSummary: (input) => {
      thoughtPaint ??= thoughtPainter();
      return new Tui.Text(thoughtPaint(thoughtSummaryText(input.durationMs)), input.paddingX, 0);
    },
    isCollapsedLabel: (node) => node instanceof Tui.Text,
    makeWriteCall: (input) => {
      // Read ONCE at boot from the same path activate() uses: a per-write-call
      // reload could disagree with the startup config (and made the host's
      // getAgentDir the only resolution path, dropping the PI_AGENT_DIR
      // override the startup read honors).
      const maxRows = bootWritePreview.enabled ? bootWritePreview.rows : 0;
      return new CodexWriteCallComponent({ ...input, layout: layoutOps(), maxRows });
    },
    editorHost: { CustomEditor: Pi.CustomEditor as unknown },
    marginHost: {
      HStack: typeof Tui.HStack === "function" ? Tui.HStack : undefined,
      Spacer: typeof Tui.Spacer === "function" ? Tui.Spacer : undefined,
    },
    historyWindowHost: { Container: Tui.Container, ScrollView: Tui.ScrollView, matchesKey: Tui.matchesKey },
    selectionCopyHost: {
      prototypes: {
        Text: Tui.Text.prototype,
        Markdown: Tui.Markdown.prototype,
        Box: Tui.Box.prototype,
        Container: Tui.Container.prototype,
        MouseRegion: Tui.MouseRegion?.prototype,
      },
      fns: {
        visibleWidth: Tui.visibleWidth,
        sliceByColumn: Tui.sliceByColumn,
        stripTerminalSequences: Tui.stripTerminalSequences,
        wrapTextWithAnsi: Tui.wrapTextWithAnsi,
        renderLatex: (text, options) => Tui.renderLatex(text, options) ?? null,
      },
    },
    surface,
    api: pi,
    appearanceVersion: appearanceVersion(),
    piVersion: typeof (Pi as unknown as { VERSION?: unknown }).VERSION === "string"
      ? (Pi as unknown as { VERSION: string }).VERSION
      : "unknown",
  });
}
