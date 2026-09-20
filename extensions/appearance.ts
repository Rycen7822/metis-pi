import { readFileSync } from "node:fs";
import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { activate, type AppearanceAPI } from "../src/extension.ts";
import { renderCodexDiffComponent, type DiffComponentInput } from "../src/diff-component.ts";
import { renderShellCall, renderShellResult, type LayoutOps } from "../src/shell.ts";
import { CODEX_CYAN_RGB, resolveColorContext } from "../src/palette.ts";
import { makeSurfaceOps } from "../src/surface.ts";
import { renderWritePreview } from "../src/write-preview.ts";
import { loadConfig } from "../src/config.ts";
import { thoughtSummaryText } from "../src/thinking-summary.ts";
import { peekHintText, type PeekWindow, type ThinkingView, type ThinkingViewControl } from "../src/thinking-view.ts";
import { registerProduct, productFor, publishRows, releaseCopyCache } from "../src/selection-copy/model.ts";
import type { CopyRow } from "../src/selection-copy/model.ts";
import type { WritePreviewInput } from "../src/renderers.ts";
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

/** Separator before assistant text that follows tool activity: a light
 * horizontal rule sized to the live layout width (never a fixed column count). */
class CodexSeparatorComponent implements Tui.Component {
  render(width: number): string[] {
    const usable = Math.max(1, Math.floor(width));
    const level = colorLevelOnce();
    const line = "─".repeat(usable);
    return [level.kind === "none" ? "-".repeat(usable) : `\x1b[2m${line}\x1b[22m`];
  }
  invalidate(): void {}
}

/** Live write call: structured header (• Writing <path>) + stage line +
 * bounded rolling tail of the real args.content prefix. The header
 * is part of THIS component and can never be bypassed by the preview body.
 * `update()` refreshes inputs in place so the host's lastComponent reuse
 * path keeps one stable instance per call. */
class CodexWriteCallComponent implements Tui.Component {
  #input: WritePreviewInput & { headerText: string; layout: import("../src/tool-names.ts").DiffLayoutOps; maxRows?: number };
  #revision = 0;
  #lastWidth = -1;
  #lastRevision = -1;
  #lastExpanded = false;
  #cache: string[] | undefined;

  constructor(input: WritePreviewInput & { headerText: string; layout: import("../src/tool-names.ts").DiffLayoutOps; maxRows?: number }) {
    this.#input = input;
  }

  update(next: WritePreviewInput & { headerText?: string; layout?: import("../src/tool-names.ts").DiffLayoutOps; maxRows?: number }): void {
    // The renderers' reuse path builds a PARTIAL input (no layout/maxRows -
    // those are component-owned). Merge instead of replacing: a full replace
    // dropped `layout` and crashed render on the next frame.
    this.#input = {
      ...next,
      headerText: next.headerText ?? this.#input.headerText,
      layout: next.layout ?? this.#input.layout,
      maxRows: next.maxRows ?? this.#input.maxRows,
    };
    // Bump the revision only when VISIBLE state changed (content, stage,
    // header, expansion, colors) - identical repeated snapshots keep the
    // old frame without a re-layout.
    const prev = this.#prevVisible;
    if (prev.contentPrefix !== next.contentPrefix
        || prev.stage !== next.stage
        || (next.headerText ?? "") !== prev.headerText
        || next.expanded !== prev.expanded
        || next.colorLevel.kind !== prev.colorKind) {
      this.#revision += 1;
    }
    this.#prevVisible = {
      contentPrefix: next.contentPrefix,
      stage: next.stage,
      headerText: next.headerText ?? "",
      expanded: next.expanded,
      colorKind: next.colorLevel.kind,
    };
  }

  #prevVisible: {
    contentPrefix: string; stage: string; headerText: string;
    expanded: boolean; colorKind: string;
  } = { contentPrefix: "", stage: "", headerText: "", expanded: false, colorKind: "" };

  render(width: number): string[] {
    const expanded = this.#input.expanded === true;
    if (this.#cache && this.#lastWidth === width && this.#lastRevision === this.#revision && this.#lastExpanded === expanded) {
      return this.#cache;
    }
    const header = this.#input.headerText;
    const out: string[] = [header];
    const copyOut: CopyRow[] = [{ spans: [{ colStart: 0, colEnd: width, kind: "decoration" }], breakBefore: "hard" }];
    // Live body: bounded tail; the body renderer owns its own physical-row
    // budget, header width is independent.
    const body = renderWritePreview(this.#input.contentPrefix, {
      width: Math.max(1, Math.floor(width)),
      stage: this.#input.stage,
      expanded,
      theme: this.#input.theme,
      colorLevel: this.#input.colorLevel,
      layout: this.#input.layout,
      gutter: "  │ ",
      headerRows: 1, // the header line above is ours; body budget is separate
      maxRows: this.#input.maxRows, // config.writePreview.rows (0 = body off)
      copyOut,
    });
    for (const line of body) out.push(line);
    if (copyOut.length === out.length) {
      registerProduct(out, { componentId: "write-call", width, rows: copyOut });
    }
    this.#cache = out;
    this.#lastWidth = width;
    this.#lastRevision = this.#revision;
    this.#lastExpanded = expanded;
    return this.#cache;
  }

  invalidate(): void {
    this.#cache = undefined;
    this.#lastWidth = -1;
  }
}

/** Narrow static rail left of a thinking run. Wraps the host's thinking
 * component (Markdown inside MouseRegion) so clicks keep working. */
class CodexThinkingRailComponent implements Tui.Component {
  readonly #child: Tui.Component;
  #lastWidth = -1;
  #lastChildLines: string[] | undefined;
  #cache: string[] | undefined;

  constructor(child: Tui.Component) {
    this.#child = child;
  }

  render(width: number): string[] {
    const railCells = 2;
    const inner = Math.max(1, Math.floor(width) - railCells);
    const childLines = this.#child.render(inner);
    // Cached by BOTH width and the child's row array: a peek window that
    // scrolled in place returns a new array, so the rail must re-prefix it.
    // The child render itself is cached downstream (peek/markdown per width),
    // which is what makes this identity check cheap.
    if (this.#cache && this.#lastWidth === width && this.#lastChildLines === childLines) return this.#cache;
    const level = colorLevelOnce();
    const rail = level.kind === "none" ? "| " : `\x1b[38;2;${CODEX_CYAN_RGB}m▏\x1b[39m `;
    // Per-row shift: rows already carrying a rail pass through WITHOUT the
    // prefix, so their provenance shift is 0, not railCells.
    const shifts = childLines.map((line) => {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      return stripped.startsWith("▏") || stripped.startsWith("| ") ? 0 : railCells;
    });
    this.#cache = childLines.map((line, i) => (shifts[i] === 0 ? line : `${rail}${line}`));
    // Provenance: every rail row is the child's row shifted right by its rail
    // cells (the rail itself is decoration). Resolves through the child
    // product via array identity when one exists.
    const childProduct = productFor(childLines);
    if (childProduct) {
      registerProduct(this.#cache, {
        componentId: "thinking-rail",
        width,
        rows: [],
        children: this.#cache.map((_, i) => childProduct.children
          ? childProduct.children[i]
            ? { ...childProduct.children[i]!, colShift: childProduct.children[i]!.colShift + shifts[i]! }
            : undefined
          : { product: childProduct, rowIndex: i, colShift: shifts[i]! }),
      });
    }
    this.#lastWidth = width;
    this.#lastChildLines = childLines;
    return this.#cache;
  }

  handleMouse(event: Tui.TuiMouseEvent): Tui.TuiMouseEventResult | undefined {
    if (event.type === "click" && event.button === "left") {
      if (event.x < 2) return undefined; // rail column: not a toggle
      const child = this.#child as unknown as { handleMouse?: (e: Tui.TuiMouseEvent) => Tui.TuiMouseEventResult | undefined };
      return child.handleMouse?.({ ...event, x: event.x - 2 });
    }
    const child = this.#child as unknown as { handleMouse?: (e: Tui.TuiMouseEvent) => Tui.TuiMouseEventResult | undefined };
    return child.handleMouse?.(event);
  }

  invalidate(): void {
    this.#cache = undefined;
    this.#lastWidth = -1;
    this.#lastChildLines = undefined;
    this.#child.invalidate?.();
  }
}

/** Forward a mouse event to a wrapped component (undefined when it cannot
 * receive one). Used by every wrapper whose own interest is clicks or wheels. */
function childHandleMouse(child: unknown, event: Tui.TuiMouseEvent): Tui.TuiMouseEventResult | undefined {
  const target = child as { handleMouse?: (event: Tui.TuiMouseEvent) => Tui.TuiMouseEventResult | undefined };
  return typeof target?.handleMouse === "function" ? target.handleMouse(event) : undefined;
}

/**
 * Peek window over a thinking body: the newest `windowLines` rendered rows,
 * wheel-scrollable, plus ONE dim hint row when rows are clipped. The child's
 * own rows are sliced — never re-rendered — so markdown styling, the rail and
 * copy provenance stay exactly what the host produced; the window's rows map
 * back to the child's rows one-to-one (the hint row stays unmapped, so a copy
 * of it falls back to native extraction of the visible text).
 */
class CodexThinkingPeekComponent implements Tui.Component {
  readonly #child: Tui.Component;
  readonly #control: ThinkingViewControl;
  readonly #windowLines: number;
  readonly #paintHint: (text: string) => string;
  readonly #onScroll: () => void;
  #lastWidth = -1;
  #childLines: string[] | undefined;
  #window: PeekWindow | undefined;
  #rows: string[] | undefined;

  constructor(
    child: Tui.Component,
    control: ThinkingViewControl,
    windowLines: number,
    paintHint: (text: string) => string,
    onScroll: () => void,
  ) {
    this.#child = child;
    this.#control = control;
    this.#windowLines = windowLines;
    this.#paintHint = paintHint;
    this.#onScroll = onScroll;
  }

  render(width: number): string[] {
    // Child rows are cached per width; the WINDOW is rebuilt whenever it moved
    // (a wheel scroll changes it without any content change, and a stale cache
    // would freeze the visible rows).
    if (!this.#childLines || this.#lastWidth !== width) {
      this.#childLines = this.#child.render(width);
      this.#lastWidth = width;
      this.#window = undefined;
    }
    const lines = this.#childLines;
    const window = this.#control.scroll.resolve(lines.length, this.#windowLines);
    const cached = this.#window;
    if (this.#rows && cached && cached.top === window.top && cached.above === window.above && cached.below === window.below) {
      return this.#rows;
    }
    const body = lines.slice(window.top, window.top + this.#windowLines);
    const clipped = window.above > 0 || window.below > 0;
    const rows = clipped
      ? [this.#paintHint(peekHintText(window.above, window.below, lines.length)), ...body]
      : body;
    const childProduct = productFor(lines);
    if (childProduct) {
      registerProduct(rows, {
        componentId: "thinking-peek",
        width,
        rows: [],
        children: rows.map((_, index) => {
          if (clipped && index === 0) return undefined; // hint row = decoration, copied natively
          const source = window.top + index - (clipped ? 1 : 0);
          return childProduct.children
            ? childProduct.children[source]
            : { product: childProduct, rowIndex: source, colShift: 0 };
        }),
      });
    }
    this.#window = window;
    this.#rows = rows;
    return rows;
  }

  handleMouse(event: Tui.TuiMouseEvent): Tui.TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      // Scrolling inside the window wins; at either end the event falls through
      // so the transcript scrolls instead of swallowing the gesture.
      if (!this.#control.scroll.scrollBy(event.wheelDelta ?? 0)) return undefined;
      // The window moved: ask for the same host rebuild a click asks for, which
      // is the path that actually repaints this subtree.
      this.#onScroll();
      return { handled: true, render: true };
    }
    return childHandleMouse(this.#child, event);
  }

  invalidate(): void {
    this.#childLines = undefined;
    this.#rows = undefined;
    this.#window = undefined;
    this.#lastWidth = -1;
    this.#child.invalidate?.();
  }
}

/**
 * Click layer around a thinking block (rail and peek inside it). A click never
 * rewrites itself into a toggle here: the run control owns the gesture, so a
 * single click (delayed by the double-click window) folds or opens the peek
 * window while a double click switches between peek and full — the same rule
 * while streaming and after completion. Renders nothing of its own.
 */
class CodexThinkingClickableComponent implements Tui.Component {
  readonly #child: Tui.Component;
  readonly #control: ThinkingViewControl;
  readonly #fallback: ThinkingView;
  readonly #apply: (next: ThinkingView) => void;

  constructor(child: Tui.Component, control: ThinkingViewControl, fallback: ThinkingView, apply: (next: ThinkingView) => void) {
    this.#child = child;
    this.#control = control;
    this.#fallback = fallback;
    this.#apply = apply;
  }

  render(width: number): string[] {
    return this.#child.render(width);
  }

  handleMouse(event: Tui.TuiMouseEvent): Tui.TuiMouseEventResult | undefined {
    if (event.type === "click" && event.button === "left") {
      this.#control.handleClick(
        { at: Date.now(), x: event.screenX, y: event.screenY },
        { fallback: this.#fallback, apply: this.#apply },
      );
      return { handled: true };
    }
    return childHandleMouse(this.#child, event);
  }

  invalidate(): void {
    this.#child.invalidate?.();
  }
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
      if (ctx.hasUI) ctx.ui.notify("pi-codex-appearance: unsupported Pi UI exports; compact transcript was not installed.", "warning");
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
    makeSeparator: () => new CodexSeparatorComponent(),
    makeSpacer: () => new Tui.Spacer(1),
    makeRail: (child) => new CodexThinkingRailComponent(child as Tui.Component),
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
