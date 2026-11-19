import { Container, MouseRegion } from "@earendil-works/pi-tui";
import type { Component } from "../presentation/contracts.ts";
import { copySourceFor, publishRows, registerProduct, releaseCopyCache, type ChildPlacement } from "./model.ts";

/** Preserve native mouse geometry and resolve copy from the displayed child rows. */
export function stackComponents(components: Component[]): Component {
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
      const lines = container.render(width), children: (ChildPlacement | undefined)[] = [];
      for (const rendered of snapshots) {
        const product = copySourceFor(rendered);
        for (let i = 0; i < rendered.length; i++) children.push(product ? { product, rowIndex: i, colShift: 0 } : undefined);
      }
      registerProduct(lines, { width, rows: [], children });
      publishRows(this, lines);
      return lines;
    },
    handleMouse(event) { return container.handleMouse(event); },
    invalidate() { container.invalidate(); releaseCopyCache(this); },
  };
}
