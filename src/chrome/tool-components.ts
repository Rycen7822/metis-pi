import { renderCodexDiffComponent, type DiffComponentInput } from "../diff-component.ts";
import { renderShellCall, renderShellResult, type LayoutOps } from "../shell.ts";
import type { Component } from "../tool-names.ts";
import type { ShellFactories } from "../renderers.ts";
import { registerProduct, publishRows, releaseCopyCache, type CopyRow } from "../selection-copy/model.ts";

/** Host updates create new tool regions. One cache owns both displayed rows
 * and copy provenance; invalidation releases them together. */
function cachedRowsComponent(renderRows: (width: number, copyOut: CopyRow[]) => string[]): Component & { invalidate(): void } {
  let cache: { width: number; rows: string[] } | undefined;
  return {
    render(width) {
      if (!cache || cache.width !== width) {
        const copyOut: CopyRow[] = [];
        const rows = renderRows(width, copyOut);
        if (copyOut.length === rows.length) registerProduct(rows, { width, rows: copyOut });
        cache = { width, rows };
      }
      publishRows(this, cache.rows);
      return cache.rows;
    },
    invalidate() { cache = undefined; releaseCopyCache(this); },
  };
}

export function createDiffComponent(input: DiffComponentInput, layout: LayoutOps): Component {
  return cachedRowsComponent((width, copyOut) => renderCodexDiffComponent(input, width, layout, copyOut));
}

export function createShellFactories(layout: LayoutOps): ShellFactories {
  return {
    /** Call region: bullet + bold title + highlighted command with "  │ "
     * continuation. Never renders output — the result region owns that. */
    makeShellCall(input) {
      const { title, options, name, colorLevel, bullet, theme } = input;
      const command = String(input.args.command ?? "");
      return cachedRowsComponent((width, copyOut) => renderShellCall({
        row: {
          title,
          isError: false,
          isPartial: options.isPartial === true,
          command,
          language: name === "powershell" ? "powershell" : "bash",
          output: "",
          expanded: options.expanded === true,
          expandHint: "",
        },
        width,
        layout,
        colorLevel,
        bullet,
        titlePainter: (title) => theme.fg("toolTitle", theme.bold(title)),
        copyOut,
      }));
    },

    /**
     * Result region: output block with "  └ "/"    " prefixes and the 5-screen-row
     * budget. Never renders a command head.
     */
    makeShellResult(input) {
      // A retained component must not capture context.lastComponent: that
      // otherwise keeps every earlier component and streaming result alive.
      const { result: value, options, name, colorLevel, expandHint } = input;
      const isError = input.context.isError === true;
      const bullet = input.theme.fg(input.context.isError ? "error" : options.isPartial ? "dim" : "success", "•");
      return cachedRowsComponent((width, copyOut) => {
        const result = value as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | null;
        const output = Array.isArray(result?.content)
          ? result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
          : "";
        return renderShellResult({
          row: {
            title: "",
            isError,
            isPartial: options.isPartial === true,
            command: "",
            language: name === "powershell" ? "powershell" : "bash",
            output,
            expanded: options.expanded === true,
            expandHint,
          },
          width,
          layout,
          colorLevel,
          bullet,
          titlePainter: (title) => title,
          copyOut,
        });
      });
    },
  };
}
