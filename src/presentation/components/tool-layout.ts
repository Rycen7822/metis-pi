import { Text, TruncatedText, Container, type Component } from "@earendil-works/pi-tui";
import { copySourceFor, publishRows, registerProduct, releaseCopyCache } from "../../selection-copy/model.ts";
import { COMMAND_CONTINUATION_PREFIX, OUTPUT_INITIAL_PREFIX, OUTPUT_SUBSEQUENT_PREFIX,
  toolBullet, type Foreground, type ToolState } from "../terminal-text.ts";

/** Reserve the gutter before wrapping, and keep it out of exact selection copy. */
export function toolGutter(child: Component, theme: Foreground, kind: "args" | "result" = "result"): Component {
  const columns = OUTPUT_SUBSEQUENT_PREFIX.length;
  const first = theme.fg("dim", kind === "args" ? COMMAND_CONTINUATION_PREFIX : OUTPUT_INITIAL_PREFIX);
  const rest = kind === "args" ? first : OUTPUT_SUBSEQUENT_PREFIX;
  let cache: { width: number; source: string[]; rows: string[] } | undefined;
  return {
    render(width) {
      if (width < columns + 2) {
        cache = undefined;
        const rows = child.render(width);
        publishRows(this, rows);
        return rows;
      }
      const source = child.render(width - columns);
      if (cache?.width !== width || cache.source !== source) {
        const rows = source.map((line, index) => (index === 0 ? first : rest) + line);
        const product = copySourceFor(source);
        if (product) registerProduct(rows, {
          width, rows: [], children: rows.map((_, rowIndex) => ({ product, rowIndex, colShift: columns })),
        });
        cache = { width, source, rows };
      }
      publishRows(this, cache.rows);
      return cache.rows;
    },
    invalidate() {
      cache = undefined;
      releaseCopyCache(this);
      child.invalidate();
    },
  };
}

export function toolCall(title: string, details: readonly string[], theme: Foreground, context?: ToolState): Component {
  const heading = new TruncatedText(`${toolBullet(context, theme)} ${title}`, 0, 0);
  if (!details.length) return heading;
  const call = new Container();
  call.addChild(heading);
  call.addChild(toolGutter(new Text(details.join("\n"), 0, 0), theme, "args"));
  return call;
}

export function toolResultBody(text: string, theme: Foreground): Component {
  return toolGutter(new Text(text, 0, 0), theme);
}
