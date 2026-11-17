import { cellWidth, wrapStyledContent } from "../segments.ts";
import { stripAnsi } from "../../selection-copy/wrap.ts";
import { registerProduct, publishRows, releaseCopyCache, type CopyRow } from "../../selection-copy/model.ts";

/** Host updates create new tool regions. One cache owns both displayed rows
 * and copy provenance; invalidation releases them together. */
export function cachedRowsComponent(renderRows: (width: number, copyOut: CopyRow[]) => string[]) {
  let cache: { width: number; rows: string[] } | undefined;
  return {
    render(width: number) {
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

/** Fill the first row before adding display-only indentation to continuations. */
export function createHangingText(text: string) {
  const component = cachedRowsComponent((width, copyOut) => {
    const indent = Math.max(0, Math.min(4, Math.floor(width) - 2));
    const rows: string[] = [];
    for (const line of text.replace(/\t/g, "   ").split("\n")) {
      for (const [index, chunk] of wrapStyledContent(line, width, indent).entries()) {
        const plain = stripAnsi(chunk), start = index === 0 ? 0 : indent;
        rows.push(chunk);
        copyOut.push({
          breakBefore: index === 0 ? "hard" : "soft",
          spans: [
            { colStart: 0, colEnd: start, kind: "decoration" },
            { colStart: start, colEnd: cellWidth(plain), kind: "content", text: plain.slice(start) },
          ],
        });
      }
    }
    return rows;
  });
  return Object.assign(component, {
    setText(next: string) {
      if (next === text) return;
      text = next;
      component.invalidate();
    },
  });
}
