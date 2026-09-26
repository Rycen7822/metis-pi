import { renderCodexDiffComponent, type DiffComponentInput } from "../diff-component.ts";
import { renderShellCall, renderShellResult, type LayoutOps } from "../shell.ts";
import type { Component } from "../tool-names.ts";
import type { ShellFactories } from "../renderers.ts";
import { registerProduct, publishRows, releaseCopyCache, type CopyRow } from "../selection-copy/model.ts";

/** Host updates create new tool regions. One cache owns both displayed rows
 * and copy provenance; invalidation releases them together. */
function cachedRowsComponent(componentId: string, renderRows: (width: number, copyOut: CopyRow[]) => string[]): Component & { invalidate(): void } {
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

export function createDiffComponent(input: DiffComponentInput, layout: LayoutOps): Component {
  return cachedRowsComponent("diff", (width, copyOut) => renderCodexDiffComponent(input, width, layout, copyOut));
}

export function createShellFactories(layout: LayoutOps): ShellFactories {
  return {
    /** Call region: bullet + bold title + highlighted command with "  │ "
     * continuation. Never renders output — the result region owns that. */
    makeShellCall(input) {
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
        layout,
        colorLevel: input.colorLevel,
        bullet: input.bullet,
        titlePainter: (title) => title,
        copyOut,
      }));
    },

    /**
     * Result region: output block with "  └ "/"    " prefixes and the 5-screen-row
     * budget. Never renders a command head.
     */
    makeShellResult(input) {
      const isError = input.context.isError === true;
      const bullet = input.theme.fg(input.context.isError ? "error" : input.options.isPartial ? "dim" : "success", "•");
      return cachedRowsComponent("shell-result", (width, copyOut) => {
        const result = input.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | null;
        const output = Array.isArray(result?.content)
          ? result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
          : "";
        return renderShellResult({
          row: {
            title: "",
            isError,
            isPartial: input.options.isPartial === true,
            command: "",
            language: input.name === "powershell" ? "powershell" : "bash",
            output,
            expanded: input.options.expanded === true,
            expandHint: input.expandHint,
          },
          width,
          layout,
          colorLevel: input.colorLevel,
          bullet,
          titlePainter: (title) => title,
          copyOut,
        });
      });
    },
  };
}
