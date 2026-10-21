import { Container, MouseRegion } from "@earendil-works/pi-tui";
import type { Component } from "../presentation/contracts.ts";
import { productFor, publishRows, registerProduct, releaseCopyCache, type CopyRow, type ChildPlacement } from "./model.ts";

/** Native stacking owns mouse geometry; copy provenance remains an explicit caller policy. */
export function stackComponents(components: Component[], composition: "flat-rows" | "child-placements"): Component {
  const container = new Container(), snapshots: string[][] = [];
  for (const [index, component] of components.entries()) {
    const region = new MouseRegion(component, () => undefined);
    region.render = width => {
      const rows = (snapshots[index] = component.render(width));
      // This instance override bypasses the prototype's copy publication hook.
      publishRows(region, rows);
      return rows;
    };
    container.addChild(region);
  }
  return {
    render(width) {
      const lines = container.render(width), rows: CopyRow[] = [], children: (ChildPlacement | undefined)[] = [];
      for (const rendered of snapshots) {
        const product = productFor(rendered);
        if (composition === "flat-rows") {
          // Fusion takes rows only, never follows a child's placement chain.
          rows.push(
            ...(product?.rows ??
              rendered.map(() => ({
                spans: [{ colStart: 0, colEnd: width, kind: "unknown" as const }],
                breakBefore: "hard" as const,
              }))),
          );
        } else {
          for (let i = 0; i < rendered.length; i++) children.push(product?.children
            ? product.children[i]
            : product ? { product, rowIndex: i, colShift: 0 } : undefined);
        }
      }
      registerProduct(lines, { width, rows, ...(composition === "child-placements" ? { children } : {}) });
      publishRows(this, lines);
      return lines;
    },
    handleMouse(event) { return container.handleMouse(event); },
    invalidate() { container.invalidate(); releaseCopyCache(this); },
  };
}
