// Copy-provenance model: products annotate the exact render-product arrays
// they describe. The layout's box.lines arrays are the keys, so frame binding
// (§ committed frame, not a newer re-render) falls out of object identity —
// a newer render produces a new array and cannot be resolved from an older
// committed frame.

import type { SpanKind } from "./wrap.ts";

export type BreakBefore = "hard" | "soft" | "paragraph" | "gap" | "unknown";

export interface CopySpan {
  colStart: number;
  colEnd: number;
  kind: SpanKind | "gap" | "unknown";
  /** Visible text contributed when selected (content/semantic spans only). */
  text?: string;
}

export interface CopyRow {
  spans: readonly CopySpan[];
  breakBefore: BreakBefore;
  /** Whitespace consumed by the wrapper at the soft boundary before this row;
   * inserted only when both sides of the boundary are selected. */
  bridge?: string;
}

export interface CopyProduct {
  componentId: string;
  width: number;
  /** Rows indexed exactly like the annotated render array. */
  rows: readonly CopyRow[];
  /** For container products: per-row child resolution chain. */
  children?: readonly (ChildPlacement | undefined)[];
}

export interface ChildPlacement {
  product: CopyProduct;
  rowIndex: number;
  colShift: number;
}

export function decorationRow(cols: number): CopyRow {
  return { spans: [{ colStart: 0, colEnd: cols, kind: "decoration" }], breakBefore: "hard" };
}

const byArray = new WeakMap<object, CopyProduct>();
let hits = 0;
let misses = 0;

export function registerProduct(lines: readonly string[], product: CopyProduct): void {
  byArray.set(lines, product);
}

/**
 * Instance slot where every wrapped render prototype publishes the row array
 * it JUST returned. Container/Box alignment resolves child products by array
 * identity from this slot instead of re-rendering each child (a re-render per
 * child per frame compounds across nested containers: 2^depth leaf renders).
 * The slot always holds the CURRENT render pass's array, so a product lookup
 * either resolves the product built for exactly these rows or misses (native
 * extraction) — a stale product can never attach to new rows.
 */
export const LAST_ROWS = Symbol.for("Rycen7822.pi-codex-appearance.last-rendered-rows");

export function publishRows(component: object, rows: readonly string[]): void {
  (component as Record<symbol, unknown>)[LAST_ROWS] = rows;
}

export function publishedRowsOf(component: unknown): readonly string[] | undefined {
  if (!component || typeof component !== "object") return undefined;
  const rows = (component as Record<symbol, unknown>)[LAST_ROWS];
  return Array.isArray(rows) ? (rows as readonly string[]) : undefined;
}

export function productFor(lines: unknown): CopyProduct | undefined {
  if (typeof lines !== "object" || lines === null) return undefined;
  const found = byArray.get(lines);
  if (found) hits += 1;
  else misses += 1;
  return found;
}

export function cacheStats(): { hits: number; misses: number } {
  return { hits, misses };
}
