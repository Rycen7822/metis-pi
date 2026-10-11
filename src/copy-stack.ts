import type { Component } from "./tool-names.ts";
import { productFor, publishRows, registerProduct, releaseCopyCache, type CopyRow, type ChildPlacement } from "./selection-copy/model.ts";

/** Shared vertical geometry; copy provenance remains an explicit caller policy. */
export function stackComponents(components: Component[], componentId: string, composition: "flat-rows" | "child-placements"): Component {
  return {
    render(width) {
      const lines: string[] = [], rows: CopyRow[] = [], children: (ChildPlacement | undefined)[] = [];
      for (const component of components) {
        const rendered = component.render(width), product = productFor(rendered);
        lines.push(...rendered);
        if (composition === "flat-rows") {
          // Fusion takes rows only, never follows a child's placement chain.
          rows.push(...(product?.rows ?? rendered.map(() => ({ spans: [{ colStart: 0, colEnd: width, kind: "unknown" as const }], breakBefore: "hard" as const }))));
        } else {
          for (let i = 0; i < rendered.length; i++) children.push(product?.children
            ? product.children[i]
            : product ? { product, rowIndex: i, colShift: 0 } : undefined);
        }
      }
      registerProduct(lines, { componentId, width, rows, ...(composition === "child-placements" ? { children } : {}) });
      publishRows(this, lines);
      return lines;
    },
    invalidate() { for (const component of components) component.invalidate(); releaseCopyCache(this); },
  };
}
