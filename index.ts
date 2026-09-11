import { readFileSync } from "node:fs";
import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { activate, type AppearanceAPI } from "./src/extension.ts";
import { renderCodexDiffComponent, type DiffComponentInput } from "./src/diff-component.ts";
import { renderShellCall, renderShellResult, type LayoutOps } from "./src/shell.ts";
import { resolveColorContext } from "./src/palette.ts";
import { renderWritePreview } from "./src/write-preview.ts";
import { loadConfig } from "./src/config.ts";
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
    this.#cache = renderCodexDiffComponent(this.#input, width, layoutOps());
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
    return renderShellCall({
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
    });
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
    return renderShellResult({
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
    });
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
 * bounded rolling tail of the real args.content prefix (0.8.1). The header
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

  update(next: WritePreviewInput & { headerText: string; layout: import("./src/tool-names.ts").DiffLayoutOps; maxRows?: number }): void {
    const prev = this.#input;
    this.#input = next;
    // Bump the revision only when VISIBLE state changed (content, stage,
    // header, expansion, colors) — identical repeated snapshots keep the
    // old frame without a re-layout.
    if (prev.contentPrefix !== next.contentPrefix
        || prev.stage !== next.stage
        || prev.headerText !== next.headerText
        || prev.expanded !== next.expanded
        || prev.colorLevel.kind !== next.colorLevel.kind) {
      this.#revision += 1;
    }
  }

  render(width: number): string[] {
    const expanded = this.#input.expanded === true;
    if (this.#cache && this.#lastWidth === width && this.#lastRevision === this.#revision && this.#lastExpanded === expanded) {
      return this.#cache;
    }
    const header = this.#input.headerText;
    const out: string[] = [header];
    // Live body: bounded tail with the full gutter accounted for. The body
    // renderer owns its own physical-row budget; header width is independent.
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
    });
    for (const line of body) out.push(line);
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
    // 0.8.1: pi-zentui is uninstalled; the Zentui registry probe is removed.
    // Unknown third-party owners still back off through the adapter's
    // ownsMethods/sourceInfo checks — no dedicated Zentui detection remains.
    makeWriteCall: (input) => {
      // Config-driven body budget (0.8.1): rows from codex-appearance.json;
      // enabled=false collapses the live body to the header only.
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
    // ---- 0.8.0 chrome wiring ----
    api: pi,
    getAgentDir: () => {
      // Public host config dir (PI_AGENT_DIR override respected by Pi itself;
      // we only need the PATH, never auth contents).
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
