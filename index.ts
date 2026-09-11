import { readFileSync } from "node:fs";
import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { activate, type AppearanceAPI } from "./src/extension.ts";
import { renderCodexDiffComponent, type DiffComponentInput } from "./src/diff-component.ts";
import { renderShellCall, renderShellResult, type LayoutOps } from "./src/shell.ts";
import { resolveColorContext } from "./src/palette.ts";
import { makeSurfaceOps } from "./src/surface.ts";
import { renderWritePreview } from "./src/write-preview.ts";
import { loadConfig } from "./src/config.ts";
import { registerProduct, productFor } from "./src/selection-copy/model.ts";
import type { CopyRow } from "./src/selection-copy/model.ts";
import type { WritePreviewInput } from "./src/renderers.ts";
import type { ToolName } from "./src/tool-names.ts";

function layoutOps(): LayoutOps {
  return {
    wrap: (text: string, columns: number) => Tui.wrapTextWithAnsi(text, columns),
    visibleWidth: (text: string) => Tui.visibleWidth(text),
  };
}

/** Result region of an edit/write diff: rows -> width-aware Codex renderer. */
class CodexDiffComponent implements Tui.Component {
  readonly #input: DiffComponentInput;
  #lastWidth = -1;
  #cache: string[] | undefined;

  constructor(input: DiffComponentInput) {
    this.#input = input;
  }

  render(width: number): string[] {
    if (this.#cache && this.#lastWidth === width) return this.#cache;
    const copyOut: CopyRow[] = [];
    const rows = renderCodexDiffComponent(this.#input, width, layoutOps(), copyOut);
    if (copyOut.length === rows.length) {
      registerProduct(rows, { componentId: "diff", width, rows: copyOut });
    }
    this.#cache = rows;
    this.#lastWidth = width;
    return this.#cache;
  }

  invalidate(): void {
    this.#cache = undefined;
    this.#lastWidth = -1;
  }
}

/** Call region: bullet + bold title + highlighted command with "  │ "
 * continuation. Never renders output — the result region owns that. */
interface ShellCallInput {
  name: ToolName; bullet: string; title: string; args: Record<string, unknown>;
  options: { expanded?: boolean; isPartial?: boolean };
  colorLevel: import("./src/palette.ts").ColorLevel;
}
class CodexShellCallComponent implements Tui.Component {
  readonly #input: ShellCallInput;

  constructor(input: ShellCallInput) {
    this.#input = input;
  }

  render(width: number): string[] {
    const copyOut: CopyRow[] = [];
    const rows = renderShellCall({
      row: {
        title: this.#input.title,
        isError: false,
        isPartial: this.#input.options.isPartial === true,
        command: String(this.#input.args.command ?? ""),
        language: this.#input.name === "powershell" ? "powershell" : "bash",
        output: "",
        expanded: this.#input.options.expanded === true,
        expandHint: "",
      },
      width,
      layout: layoutOps(),
      colorLevel: this.#input.colorLevel,
      bullet: this.#input.bullet,
      titlePainter: (title) => title,
      copyOut,
    });
    if (copyOut.length === rows.length) {
      registerProduct(rows, { componentId: "shell-call", width, rows: copyOut });
    }
    return rows;
  }

  invalidate(): void {
    // Stateless: recomputed per render.
  }
}

/**
 * Result region: output block with "  └ "/"    " prefixes and the 5-screen-row
 * budget. Never renders a command head.
 */
class CodexShellResultComponent implements Tui.Component {
  readonly #input: {
    name: ToolName; args: Record<string, unknown>; result: unknown;
    options: { expanded?: boolean; isPartial?: boolean }; isError: boolean;
    expandHint: string;
    colorLevel: import("./src/palette.ts").ColorLevel;
  };
  #bullet = "";

  constructor(input: {
    name: ToolName; args: Record<string, unknown>; result: unknown;
    options: { expanded?: boolean; isPartial?: boolean }; isError: boolean;
    bullet: string;
    expandHint: string;
    colorLevel: import("./src/palette.ts").ColorLevel;
  }) {
    this.#input = input;
    this.#bullet = input.bullet;
  }

  render(width: number): string[] {
    const result = this.#input.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | null;
    const output = Array.isArray(result?.content)
      ? result!.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
      : "";
    const copyOut: CopyRow[] = [];
    const rows = renderShellResult({
      row: {
        title: "",
        isError: this.#input.isError,
        isPartial: this.#input.options.isPartial === true,
        command: "",
        language: this.#input.name === "powershell" ? "powershell" : "bash",
        output,
        expanded: this.#input.options.expanded === true,
        expandHint: this.#input.expandHint,
      },
      width,
      layout: layoutOps(),
      colorLevel: this.#input.colorLevel,
      bullet: this.#bullet,
      titlePainter: (title) => title,
      copyOut,
    });
    if (copyOut.length === rows.length) {
      registerProduct(rows, { componentId: "shell-result", width, rows: copyOut });
    }
    return rows;
  }

  invalidate(): void {
    // Stateless: recomputed per render.
  }
}

/** Separator before assistant text that follows tool activity: a light
 * horizontal rule sized to the live layout width (never a fixed column count). */
class CodexSeparatorComponent implements Tui.Component {
  render(width: number): string[] {
    const usable = Math.max(1, Math.floor(width));
    const level = resolveColorContext({ terminalTrueColor: Tui.getCapabilities?.()?.trueColor === true });
    const line = "─".repeat(usable);
    return [level.kind === "none" ? "-".repeat(usable) : `\x1b[2m${line}\x1b[22m`];
  }
  invalidate(): void {
    // Stateless: recomputed per render.
  }
}

/** Live write call: structured header (• Writing <path>) + stage line +
 * bounded rolling tail of the real args.content prefix. The header
 * is part of THIS component and can never be bypassed by the preview body.
 * `update()` refreshes inputs in place so the host's lastComponent reuse
 * path keeps one stable instance per call. */
class CodexWriteCallComponent implements Tui.Component {
  #input: WritePreviewInput & { headerText: string; layout: import("./src/tool-names.ts").DiffLayoutOps; maxRows?: number };
  #revision = 0;
  #lastWidth = -1;
  #lastRevision = -1;
  #lastExpanded = false;
  #cache: string[] | undefined;

  constructor(input: WritePreviewInput & { headerText: string; layout: import("./src/tool-names.ts").DiffLayoutOps; maxRows?: number }) {
    this.#input = input;
  }

  update(next: WritePreviewInput & { headerText?: string; layout?: import("./src/tool-names.ts").DiffLayoutOps; maxRows?: number }): void {
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
  #cache: string[] | undefined;

  constructor(child: Tui.Component) {
    this.#child = child;
  }

  render(width: number): string[] {
    if (this.#cache && this.#lastWidth === width) return this.#cache;
    const level = resolveColorContext({ terminalTrueColor: Tui.getCapabilities?.()?.trueColor === true });
    const rail = level.kind === "none" ? "| " : `\x1b[38;2;148;226;213m▏\x1b[39m `;
    const railCells = 2;
    const inner = Math.max(1, Math.floor(width) - railCells);
    const childLines = this.#child.render(inner);
    this.#cache = childLines.map((line) => {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      return stripped.startsWith("▏") || stripped.startsWith("| ") ? line : `${rail}${line}`;
    });
    // Provenance: every rail row is the child's row shifted right by the 2
    // rail cells (the rail itself is decoration). Resolves through the child
    // product via array identity when one exists.
    const childProduct = productFor(childLines);
    if (childProduct) {
      registerProduct(this.#cache, {
        componentId: "thinking-rail",
        width,
        rows: [],
        children: this.#cache.map((_, i) => childProduct.children
          ? childProduct.children[i]
            ? { ...childProduct.children[i]!, colShift: childProduct.children[i]!.colShift + railCells }
            : undefined
          : { product: childProduct, rowIndex: i, colShift: railCells }),
      });
    }
    this.#lastWidth = width;
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
    this.#child.invalidate?.();
  }
}

/** Real package version, read once from package.json next to this entry —
 * never hardcoded (diagnostics and the header show this value). */
function appearanceVersion(): string {
  try {
    const raw = readFileSync(new URL("./package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}

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
  const colorLevel = resolveColorContext({ terminalTrueColor: Tui.getCapabilities?.()?.trueColor === true });
  const highlight = (text: string, language: string): string => {
    const lines = Pi.highlightCode(text, language);
    return Array.isArray(lines) ? lines.join("\n") : String(lines);
  };
  // Gray composer surface painters, built from the REAL Tui helpers so src/
  // keeps its no-host-import rule.
  const surface = makeSurfaceOps(
    colorLevel,
    (text) => `\x1b[38;2;148;226;213m${text}\x1b[39m`,
    (text) => `\x1b[2m${text}\x1b[22m`,
  );
  activate(pi, {
    prototype,
    makeText: (text) => new Tui.Text(text, 0, 0),
    makeDiff: (input) => new CodexDiffComponent({
      rows: input.rows, filePath: input.filePath, paint: highlight,
      colorLevel, expanded: input.options.expanded === true,
      expandHint: input.expandHint ?? "",
    }),
    makeShell: {
      makeShellCall: (input) => new CodexShellCallComponent({
        name: input.name, bullet: input.bullet, title: input.title, args: input.args,
        options: input.options, colorLevel: input.colorLevel,
      }),
      makeShellResult: (input) => new CodexShellResultComponent({
        name: input.name, args: input.args, result: input.result,
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
    makeWriteCall: (input) => {
      // Body budget from codex-appearance.json; enabled=false collapses the
      // live body to the header only.
      let maxRows: number | undefined;
      try {
        const dir = (Pi as unknown as { getAgentDir?: () => string }).getAgentDir?.();
        if (dir) {
          const { config } = loadConfig(dir, (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } });
          maxRows = config.writePreview.enabled ? config.writePreview.rows : 0;
        }
      } catch { maxRows = undefined; }
      return new CodexWriteCallComponent({ ...input, layout: layoutOps(), maxRows });
    },
    editorHost: { CustomEditor: Pi.CustomEditor as unknown },
    selectionCopyHost: {
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
    },
    surface,
    api: pi,
    appearanceVersion: appearanceVersion(),
    piVersion: typeof (Pi as unknown as { VERSION?: unknown }).VERSION === "string"
      ? (Pi as unknown as { VERSION: string }).VERSION
      : "unknown",
    getAgentDir: () => {
      // PI_AGENT_DIR override is respected by Pi itself; we only need the PATH, never auth contents.
      const fromEnv = process.env.PI_AGENT_DIR;
      if (fromEnv) return fromEnv;
      const fromOs = (Pi as unknown as { getAgentDir?: () => string }).getAgentDir?.();
      return fromOs ?? `${process.env.HOME ?? ""}/.pi/agent`;
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  });
}
