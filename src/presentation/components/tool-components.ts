import { renderCodexDiffComponent, type DiffComponentInput } from "../diff-component.ts";
import { renderShellCall, renderShellResult, type LayoutOps } from "../shell.ts";
import { asRecord } from "../tool-names.ts";
import type { Component, Highlight, Palette, ShellFactories } from "../contracts.ts";
import { cachedRowsComponent } from "./rows.ts";

const DIFF_PAINT_BYTES = 4 * 1024 * 1024;

/** Syntax is independent of width/expansion. This activation-owned cache keeps
 * only bounded, detached strings, never result/receipt objects or copy rows. */
export function createDiffPainter(highlight: Highlight) {
  const entries = new Map<string, { key: string; value: string; bytes: number }>();
  let palette: unknown, bytes = 0;
  const clear = () => { entries.clear(); bytes = 0; palette = undefined; };
  return {
    clear,
    paint(text: string, language: string, theme: Palette): string {
      const colors = asRecord(theme).colors;
      // Only the native revision-bearing palette earns reuse. Opaque painters
      // retain their original behavior, including explicit invalidation.
      if (!colors || typeof colors !== "object") return highlight(text, language);
      if (palette !== colors) { clear(); palette = colors; }
      const key = `${language.length}:${language}${text}`;
      const found = entries.get(key);
      if (found) {
        entries.delete(key); entries.set(found.key, found);
        return found.value;
      }
      const value = highlight(text, language);
      // Pi's deferred-grammar fallback colors even empty input. A ready grammar
      // does not, so genuine same-color syntax is still preserved and cached.
      if (value !== text && value === theme.fg("mdCodeBlock", text)
          && highlight("", language) === theme.fg("mdCodeBlock", "")) return text;
      // The host's safe painter returns the input on failure. Do not turn a
      // transient syntax fallback into a persistent cached decision.
      if (typeof value !== "string" || value === text || palette !== colors) return value;
      const replaced = entries.get(key);
      if (replaced) { entries.delete(key); bytes -= replaced.bytes; }
      const cost = (key.length + value.length) * 2 + 64;
      if (cost <= DIFF_PAINT_BYTES) {
        while (bytes + cost > DIFF_PAINT_BYTES) {
          const oldest = entries.values().next().value!;
          entries.delete(oldest.key); bytes -= oldest.bytes;
        }
        // UTF-16 copies preserve even unpaired code units and detach slices
        // from large source buffers; the byte budget must count what we own.
        const copy = (s: string) => Buffer.from(s, "utf16le").toString("utf16le");
        const entry = { key: copy(key), value: copy(value), bytes: cost };
        entries.set(entry.key, entry); bytes += cost;
      }
      return value;
    },
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
