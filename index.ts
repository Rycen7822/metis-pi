import * as Pi from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { activate, type AppearanceAPI } from "./src/extension.ts";
import { renderCodexDiffLines, type DiffComponentInput } from "./src/renderers.ts";

class CodexDiffComponent implements Tui.Component {
  readonly #input: DiffComponentInput;

  constructor(input: DiffComponentInput) {
    this.#input = input;
  }

  render(width: number): string[] {
    return renderCodexDiffLines(this.#input.diff, width, this.#input.theme, {
      wrap: (text, columns) => Tui.wrapTextWithAnsi(text, columns),
      visibleWidth: (text) => Tui.visibleWidth(text),
    });
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
    expandHint: () => Pi.keyHint("app.tools.expand", "to expand"),
    highlight: (text, language) => {
      const lines = Pi.highlightCode(text, language);
      return Array.isArray(lines) ? lines.join("\n") : String(lines);
    },
  });
}
