// Copy-provenance model: products annotate the exact render-product arrays
// they describe. The layout's box.lines arrays are the keys, so frame binding
// (§ committed frame, not a newer re-render) falls out of object identity —
// a newer render produces a new array and cannot be resolved from an older
// committed frame.

import type { SpanKind } from "./wrap.ts";

export type BreakBefore = "hard" | "soft" | "gap" | "unknown";

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
  width: number;
  /** Rows indexed exactly like the annotated render array. */
  rows: readonly CopyRow[];
  /** For container products: per-row child resolution chain. */
  children?: readonly (ChildPlacement | undefined)[];
}

/** Width is available during composition; leaf spans are built only on demand. */
export type CopySource = CopyProduct | {
  width: number;
  resolve(): CopyProduct | undefined;
  slice(start: number, end: number): CopySource | undefined;
};

export interface ChildPlacement {
  product: CopySource;
  rowIndex: number;
  colShift: number;
}

export function decorationRow(cols: number): CopyRow {
  return { spans: [{ colStart: 0, colEnd: cols, kind: "decoration" }], breakBefore: "hard" };
}

const byArray = new WeakMap<object, CopySource>();
const cacheReleasers = new WeakMap<object, () => void>();
let hits = 0;
let misses = 0;

export function registerProduct(lines: readonly string[], source: CopySource): void {
  byArray.set(lines, source);
}

export function deferCopyProduct(
  width: number,
  build: () => CopyProduct | undefined,
  project?: (start: number, end: number) => CopySource,
): CopySource {
  let pending: typeof build | undefined = build;
  let product: CopyProduct | undefined;
  function resolve() {
    const run = pending;
    pending = undefined;
    project = undefined;
    if (run) product = run();
    return product;
  }
  return { width, resolve, slice: (start, end) => project ? project(start, end) : sliceCopySource(resolve(), start, end) };
}

export function resolveCopyProduct(source: CopySource | undefined): CopyProduct | undefined {
  return source && ("resolve" in source ? source.resolve() : source);
}

/** Detach a history fragment without retaining the omitted display rows.
 * Group adjacent child rows so copying N rows resolves one child mirror, not N. */
export function sliceCopySource(source: CopySource | undefined, start: number, end: number): CopySource | undefined {
  if (!source) return undefined;
  if ("resolve" in source) return source.slice(start, end);
  const { width, rows, children } = source;
  const sliced = rows.slice(start, end);
  if (!children) return { width, rows: sliced };
  const placements = children.slice(start, end);
  for (let i = 0; i < placements.length;) {
    const first = placements[i];
    if (!first) { i++; continue; }
    let next = i + 1;
    while (next < placements.length) {
      const child = placements[next];
      if (child?.product !== first.product || child.rowIndex !== first.rowIndex + next - i) break;
      next++;
    }
    const product = sliceCopySource(first.product, first.rowIndex, first.rowIndex + next - i);
    for (let at = i; at < next; at++) {
      placements[at] = product && { product, rowIndex: at - i, colShift: placements[at]!.colShift };
    }
    i = next;
  }
  return { width, rows: sliced, children: placements };
}

/** Eviction drops instance-owned mirrors, not products belonging to an already
 * committed frame. Those remain collectible with their row-array keys. */
export function registerCacheReleaser(component: object, release: () => void): void {
  cacheReleasers.set(component, release);
}

export function releaseCopyCache(component: object): void {
  cacheReleasers.get(component)?.();
  cacheReleasers.delete(component);
  Reflect.deleteProperty(component, LAST_ROWS);
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
export const LAST_ROWS = Symbol.for("Rycen7822.metis-pi.last-rendered-rows");

export function publishRows(component: object, rows: readonly string[]): void {
  (component as Record<symbol, unknown>)[LAST_ROWS] = rows;
}

export function publishedRowsOf(component: unknown): readonly string[] | undefined {
  if (!component || typeof component !== "object") return undefined;
  const rows = (component as Record<symbol, unknown>)[LAST_ROWS];
  return Array.isArray(rows) ? (rows as readonly string[]) : undefined;
}

export function copySourceFor(lines: unknown): CopySource | undefined {
  return typeof lines === "object" && lines !== null ? byArray.get(lines) : undefined;
}

export function productFor(lines: unknown): CopyProduct | undefined {
  const found = resolveCopyProduct(copySourceFor(lines));
  if (found) hits += 1;
  else misses += 1;
  return found;
}

export function cacheStats(): { hits: number; misses: number } {
  return { hits, misses };
}
