import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

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
  const output = result.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n").trim() ?? "";
  if (!output) return new Text(theme.fg("muted", "No output"), 0, 0);
  const color = context.isError ? "error" : "toolOutput";
  const lines = output.split("\n");
  if (options.expanded) return new Text(lines.map(line => theme.fg(color, line)).join("\n"), 0, 0);
  return new CollapsedText(theme.fg(color, lines[0]!),
    lines.length > 1 ? theme.fg("muted", `... (${lines.length - 1} more lines)`) : "", theme.fg("muted", "..."));
}
