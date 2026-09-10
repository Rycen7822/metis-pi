import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { activate, type AppearanceAPI } from "./src/extension.ts";
import { renderCodexDiffLines, type DiffComponentInput, type ShellComponentInput } from "./src/renderers.ts";
import { renderShellRow, type LayoutOps } from "./src/shell.ts";

function layoutOps(): LayoutOps {
  return {
    wrap: (text: string, columns: number) => Tui.wrapTextWithAnsi(text, columns),
    visibleWidth: (text: string) => Tui.visibleWidth(text),
  };
}

class CodexDiffComponent implements Tui.Component {
  readonly #input: DiffComponentInput;

  constructor(input: DiffComponentInput) {
    this.#input = input;
  }

  render(width: number): string[] {
    return renderCodexDiffLines(this.#input.diff, width, this.#input.theme, layoutOps());
  }

  invalidate(): void {
    // Stateless renderer: nothing cached.
  }
}

class CodexExecShellComponent implements Tui.Component {
  readonly #input: ShellComponentInput;

  constructor(input: ShellComponentInput) {
    this.#input = input;
  }

  render(width: number): string[] {
    const result = this.#input.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | null;
    const output = Array.isArray(result?.content)
      ? result!.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
      : "";
    const bullet = this.#input.context.isError
      ? this.#input.theme.fg("error", "•")
      : this.#input.options.isPartial
        ? this.#input.theme.fg("dim", "•")
        : this.#input.theme.fg("success", "•");
    return renderShellRow({
      row: {
        title: this.#input.options.isPartial ? "Running" : "Ran",
        isError: this.#input.context.isError === true,
        isPartial: this.#input.options.isPartial === true,
        command: String(this.#input.args.command ?? ""),
        language: this.#input.name === "powershell" ? "powershell" : "bash",
        output,
        expanded: this.#input.options.expanded === true,
        expandHint: this.#input.expandHint,
      },
      width,
      layout: layoutOps(),
      colorLevel: this.#input.colorLevel,
      bullet,
      titlePainter: (title) => this.#input.theme.bold(title),
    });
  }

  invalidate(): void {
    // Stateless renderer: nothing cached.
  }
}

/** Default entry: compact Codex-style transcript, without changing tool data. */
export default function codexAppearance(pi: AppearanceAPI): void {
  const prototype = Pi.ToolExecutionComponent?.prototype;
  if (!prototype || typeof Tui.Text !== "function" || typeof Pi.keyHint !== "function"
      || typeof Tui.wrapTextWithAnsi !== "function" || typeof Tui.visibleWidth !== "function") {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("pi-codex-appearance: unsupported Pi UI exports; compact transcript was not installed.", "warning");
    });
    return;
  }
  activate(pi, {
    prototype,
    makeText: (text) => new Tui.Text(text, 0, 0),
    makeDiff: (input) => new CodexDiffComponent(input),
    makeShell: (input) => new CodexExecShellComponent(input),
    expandHint: () => Pi.keyHint("app.tools.expand", "to expand"),
    highlight: (text, language) => {
      const lines = Pi.highlightCode(text, language);
      return Array.isArray(lines) ? lines.join("\n") : String(lines);
    },
  });
}
