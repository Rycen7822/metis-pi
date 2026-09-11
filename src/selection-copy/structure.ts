// Layout-level provenance: Box and Container are layout LEAVES in pi-tui
// (only ScrollView/Stack register layout nodes), so their render output IS
// the composited row array. Their products are alignment tables: per row, a
// placement chain into the child product that owns the row's cells. Fidelity
// is structural (child heights must match the host's own mouseLayout), and
// any mismatch simply leaves rows unmapped → native extraction.

import { productFor, registerProduct } from "./model.ts";
import type { ChildPlacement } from "./model.ts";

interface MouseChild {
  component: unknown;
  height: number;
}

interface MouseLayout {
  width: number;
  children: MouseChild[];
}

interface BoxLike {
  paddingX: number;
  paddingY: number;
  mouseLayout?: MouseLayout;
}

interface ContainerLike {
  mouseLayout?: MouseLayout;
}

type RenderFn<W, R> = (this: W, width: number) => R;

function childRowsOf(component: unknown, width: number): readonly string[] | undefined {
  const rows = (component as { render?: (w: number) => string[] }).render?.(width);
  return Array.isArray(rows) ? rows : undefined;
}

/** Shared alignment wrapper for Box/Container.render: children render at the
 * content width and stack vertically between padY bg rows, each prefixed by
 * colShift cells. The product is a per-row placement chain into child
 * products; any structural mismatch (child heights vs the host's own
 * mouseLayout, re-render width drift) leaves rows unmapped → native. */
function wrapAlignmentPrototype<SELF extends { mouseLayout?: MouseLayout }>(
  prototype: object,
  key: symbol,
  componentId: string,
  /** Box: contentWidth = width − 2·paddingX, padY = paddingY, colShift = paddingX.
   * Container: contentWidth = width, padY = 0, colShift = 0. */
  metrics: (self: SELF, width: number) => { contentWidth: number; padY: number; colShift: number },
): boolean {
  if (Object.prototype.hasOwnProperty.call(prototype, key)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return false;
  }
  const original = descriptor.value as RenderFn<SELF, string[]>;
  const wrapper = function (this: SELF, width: number): string[] {
    const rows = original.call(this, width);
    try {
      if (rows.length === 0) return rows;
      const { contentWidth, padY, colShift } = metrics(this, width);
      const mouse = this.mouseLayout;
      if (!mouse || mouse.width !== contentWidth) return rows;
      const placements: (ChildPlacement | undefined)[] = new Array(rows.length).fill(undefined);
      let row = padY;
      let aligned = padY * 2 + mouse.children.reduce((sum, c) => sum + c.height, 0) === rows.length;
      if (aligned) {
        for (const child of mouse.children) {
          const childRows = childRowsOf(child.component, contentWidth);
          if (!childRows || childRows.length !== child.height) {
            aligned = false;
            break;
          }
          const product = productFor(childRows);
          for (let i = 0; i < child.height; i++) {
            placements[row + i] = product ? { product, rowIndex: i, colShift } : undefined;
          }
          row += child.height;
        }
      }
      if (aligned) {
        registerProduct(rows, { componentId, width, rows: [], children: placements });
      }
    } catch {
      // Provenance must never break rendering.
    }
    return rows;
  };
  Object.defineProperty(prototype, "render", { ...descriptor, value: wrapper });
  return true;
}

/** Wrap Box.prototype.render: children render at width - 2*paddingX and are
 * stacked vertically between paddingY bg rows; each child line is prefixed
 * with paddingX cells. */
export function wrapBoxPrototype(prototype: object): boolean {
  return wrapAlignmentPrototype<BoxLike>(prototype, Symbol.for("Rycen7822.pi-codex-appearance.copy-box"), "box",
    (self, width) => ({ contentWidth: Math.max(1, width - self.paddingX * 2), padY: self.paddingY, colShift: self.paddingX }));
}

/** Wrap Container.prototype.render: children stacked at the same width, no
 * gaps. Container.render returns a fresh array every call, so the product is
 * rebuilt per frame — child arrays come from re-rendering children, which
 * hits every leaf's internal cache. */
export function wrapContainerPrototype(prototype: object): boolean {
  return wrapAlignmentPrototype<ContainerLike>(prototype, Symbol.for("Rycen7822.pi-codex-appearance.copy-container"), "container",
    (_self, width) => ({ contentWidth: width, padY: 0, colShift: 0 }));
}
