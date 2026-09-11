// Layout-level provenance: Box and Container are layout LEAVES in pi-tui
// (only ScrollView/Stack register layout nodes), so their render output IS
// the composited row array. Their products are alignment tables: per row, a
// placement chain into the child product that owns the row's cells. Fidelity
// is structural (child heights must match the host's own mouseLayout), and
// any mismatch simply leaves rows unmapped → native extraction.

import { productFor, registerProduct } from "./model.ts";
import type { ChildPlacement, CopyProduct } from "./model.ts";

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

function alignmentProduct(componentId: string, width: number, placements: (ChildPlacement | undefined)[]): CopyProduct {
  return { componentId, width, rows: [], children: placements };
}

function childRowsOf(component: unknown, width: number): readonly string[] | undefined {
  const rows = (component as { render?: (w: number) => string[] }).render?.(width);
  return Array.isArray(rows) ? rows : undefined;
}

/** Wrap Box.prototype.render: children render at width - 2*paddingX and are
 * stacked vertically between paddingY bg rows; each child line is prefixed
 * with paddingX cells. */
export function wrapBoxPrototype(prototype: object): boolean {
  const key = Symbol.for("Rycen7822.pi-codex-appearance.copy-box");
  if (Object.prototype.hasOwnProperty.call(prototype, key)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return false;
  }
  const original = descriptor.value as RenderFn<BoxLike, string[]>;
  const wrapper = function (this: BoxLike, width: number): string[] {
    const rows = original.call(this, width);
    try {
      if (rows.length === 0) return rows;
      const contentWidth = Math.max(1, width - this.paddingX * 2);
      const mouse = this.mouseLayout;
      if (!mouse || mouse.width !== contentWidth) return rows;
      const placements: (ChildPlacement | undefined)[] = new Array(rows.length).fill(undefined);
      let row = this.paddingY;
      let aligned = this.paddingY * 2 + mouse.children.reduce((sum, c) => sum + c.height, 0) === rows.length;
      if (aligned) {
        for (const child of mouse.children) {
          const childRows = childRowsOf(child.component, contentWidth);
          if (!childRows || childRows.length !== child.height) {
            aligned = false;
            break;
          }
          const product = productFor(childRows);
          for (let i = 0; i < child.height; i++) {
            placements[row + i] = product ? { product, rowIndex: i, colShift: this.paddingX } : undefined;
          }
          row += child.height;
        }
      }
      if (aligned) {
        registerProduct(rows, alignmentProduct("box", width, placements));
      }
    } catch {
      // Provenance must never break rendering.
    }
    return rows;
  };
  Object.defineProperty(prototype, "render", { ...descriptor, value: wrapper });
  return true;
}

/** Wrap Container.prototype.render: children stacked at the same width, no
 * gaps. Container.render returns a fresh array every call, so the product is
 * rebuilt per frame — child arrays come from re-rendering children, which
 * hits every leaf's internal cache. */
export function wrapContainerPrototype(prototype: object): boolean {
  const key = Symbol.for("Rycen7822.pi-codex-appearance.copy-container");
  if (Object.prototype.hasOwnProperty.call(prototype, key)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return false;
  }
  const original = descriptor.value as RenderFn<ContainerLike, string[]>;
  const wrapper = function (this: ContainerLike, width: number): string[] {
    const rows = original.call(this, width);
    try {
      if (rows.length === 0) return rows;
      const mouse = this.mouseLayout;
      if (!mouse || mouse.width !== width) return rows;
      const placements: (ChildPlacement | undefined)[] = new Array(rows.length).fill(undefined);
      let row = 0;
      let aligned = mouse.children.reduce((sum, c) => sum + c.height, 0) === rows.length;
      if (aligned) {
        for (const child of mouse.children) {
          const childRows = childRowsOf(child.component, width);
          if (!childRows || childRows.length !== child.height) {
            aligned = false;
            break;
          }
          const product = productFor(childRows);
          for (let i = 0; i < child.height; i++) {
            placements[row + i] = product ? { product, rowIndex: i, colShift: 0 } : undefined;
          }
          row += child.height;
        }
      }
      if (aligned) {
        registerProduct(rows, alignmentProduct("container", width, placements));
      }
    } catch {
      // Provenance must never break rendering.
    }
    return rows;
  };
  Object.defineProperty(prototype, "render", { ...descriptor, value: wrapper });
  return true;
}
