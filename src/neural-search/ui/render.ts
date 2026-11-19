import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { toolGutter, toolResultBody } from "../../presentation/components/tool-layout.ts";
import { safeText } from "../../presentation/terminal-text.ts";

export class CollapsedText implements Component {
  constructor(private readonly preview: string, private readonly suffix = "", private readonly marker = "...") {}
  render(width: number): string[] {
    const available = Math.max(1, width);
    if (!this.suffix) return [truncateToWidth(this.preview, available, this.marker)];
    const suffixWidth = visibleWidth(this.suffix);
    if (suffixWidth >= available) return [truncateToWidth(this.suffix, available, "")];
    return [truncateToWidth(`${truncateToWidth(this.preview, Math.max(0, available - suffixWidth - 1), this.marker)} ${this.suffix}`, available, "")];
  }
  invalidate(): void {}
}

export function renderTextResult(
  result: { content?: { type: string; text?: string }[] },
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { isError: boolean },
): Component {
  const output = safeText(result.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n") ?? "");
  if (!output.trim()) return toolResultBody(theme.fg("muted", "No output"), theme);
  const color = context.isError ? "error" : "toolOutput";
  if (options.expanded) return toolResultBody(theme.fg(color, output), theme);
  const lines = output.split("\n");
  const preview = new CollapsedText(theme.fg(color, lines[0]!),
    lines.length > 1 ? theme.fg("muted", `... (${lines.length - 1} more lines)`) : "", theme.fg("muted", "..."));
  return toolGutter(preview, theme);
}
