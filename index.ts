import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { activate, type AppearanceAPI } from "./src/extension.ts";
import { renderCodexDiffComponent, type DiffComponentInput } from "./src/diff-component.ts";
import { renderShellCall, renderShellResult, type LayoutOps } from "./src/shell.ts";
import { resolveColorContext } from "./src/palette.ts";
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
  });
}
