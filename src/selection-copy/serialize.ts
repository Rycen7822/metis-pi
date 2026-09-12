// Selection → logical text. Resolves the committed layout frame's boxes to
// copy products (keyed by render-array identity), splits selection columns
// across the boxes painting each row (later paints win, like the compositor),
// and joins fragments by boundary semantics: soft joins within one logical
// line (with the wrapper's bridge whitespace), hard line breaks otherwise,
// native per-row extraction for anything unmapped.

import { productFor } from "./model.ts";
import type { CopyProduct, CopyRow } from "./model.ts";

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutBoxLike {
  component: unknown;
  rect: LayoutRect;
  clip: LayoutRect;
  children: LayoutBoxLike[];
  lines?: readonly string[];
  lineOffset?: number;
  scrollView?: unknown;
  scrollContentLines?: readonly string[];
}

export interface LayoutFrameLike {
  root: LayoutBoxLike;
}

export interface SerializeHostFns {
  visibleWidth(text: string): number;
  sliceByColumn(line: string, start: number, width: number, preserveAnsi: boolean): string;
  stripTerminalSequences(line: string): string;
}

export interface SelectionSpec {
  scrollView: unknown;
  startRow: number;
  endRow: number;
  sourceLines: readonly string[];
  /** Host-native column snapping for a row (grapheme/boundary aware). */
  columnsFor(row: number): { start: number; end: number };
}

interface LeafHit {
  box: LayoutBoxLike;
  lineIndex: number;
}

interface ResolvedPiece {
  row: CopyRow;
  colShift: number;
}

const MAX_CHAIN_DEPTH = 32;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface SerializeResult {
  text: string;
  /** Rows fully resolved through provenance products. */
  mappedRows: number;
  /** Rows (or runs) extracted natively — mixed mode when >0 with mapped rows. */
  nativeRows: number;
}

export class SelectionSerializer {
  readonly #fns: SerializeHostFns;

  constructor(fns: SerializeHostFns) {
    this.#fns = fns;
  }

  /** Extract the selected logical text. Returns "" when the selection covers
   * no copyable content — distinct from "no selection", which callers decide
   * via the host's own getSelectionBounds. */
  serialize(frame: LayoutFrameLike, selection: SelectionSpec): SerializeResult {
    const anchor = this.#anchorFor(frame, selection.scrollView);
    if (anchor === undefined) return { text: "", mappedRows: 0, nativeRows: 1 };
    const parts: string[] = [];
    let previousHadText = false;
    let mappedRows = 0;
    let nativeRows = 0;
    for (let row = selection.startRow; row <= selection.endRow; row++) {
      const columns = selection.columnsFor(row);
      const { pieces, soft, bridge, mapped, native } = this.#rowPieces(frame, row, columns, selection, anchor);
      const text = pieces.join("");
      if (text.length > 0) {
        // Soft join decided by THIS row's product; the bridge is the
        // whitespace the wrapper consumed at that break (recorded on this row).
        if (parts.length > 0) parts.push(previousHadText && soft ? bridge : "\n");
        parts.push(text);
        previousHadText = true;
        if (native) nativeRows += 1;
        else mappedRows += 1;
      } else {
        if (parts.length > 0) parts.push("\n");
        previousHadText = false;
      }
    }
    return { text: parts.join(""), mappedRows, nativeRows };
  }

  /** Content-space anchor (scroll content box rect; origin for screen space):
   * column c maps to screen c + anchor.x, row r to subtree r + anchor.y.
   * anchor.x is 0 unless the scroll viewport sits off the left edge (side
   * gutters). */
  #anchorFor(frame: LayoutFrameLike, scrollView: unknown): { x: number; y: number } | undefined {
    if (scrollView === undefined) return { x: 0, y: 0 };
    const content = this.#findScrollViewContent(frame.root, scrollView);
    return content ? { x: content.rect.x, y: content.rect.y } : undefined;
  }

  #findScrollViewContent(box: LayoutBoxLike, scrollView: unknown): LayoutBoxLike | undefined {
    if (box.scrollView === scrollView) return box.children[0];
    for (const child of box.children) {
      const found = this.#findScrollViewContent(child, scrollView);
      if (found) return found;
    }
    return undefined;
  }

  #rowPieces(
    frame: LayoutFrameLike,
    row: number,
    columns: { start: number; end: number },
    selection: SelectionSpec,
    anchor: { x: number; y: number },
  ): { pieces: string[]; soft: boolean; bridge: string; mapped: boolean; native: boolean } {
    const pieces: string[] = [];
    let soft = true;
    let bridge = "";
    const owners = this.#ownershipFor(frame, row, anchor, selection.scrollView !== undefined, columns.end);
    let mapped = false;
    let native = false;
    let runStart = columns.start;
    let runHit = owners[columns.start];
    for (let col = columns.start + 1; ; col++) {
      const atEnd = col >= columns.end;
      const hit = atEnd ? undefined : owners[col];
      if (atEnd || hit !== runHit) {
        this.#pushRun(runHit, runStart, col, row, selection, anchor.x, pieces, (update) => {
          if (update.soft === false) soft = false;
          if (update.bridge && !bridge) bridge = update.bridge;
          if (update.mapped) mapped = true;
          if (update.native) native = true;
        });
        runStart = col;
        runHit = hit;
        if (atEnd) break;
      }
    }
    return { pieces, soft, bridge, mapped, native };
  }

  #pushRun(
    hit: LeafHit | undefined,
    start: number,
    end: number,
    row: number,
    selection: SelectionSpec,
    anchorX: number,
    pieces: string[],
    onUpdate: (update: { soft?: boolean; bridge?: string; mapped?: boolean; native?: boolean }) => void,
  ): void {
    if (end <= start) return;
    if (!hit) {
      // Unowned cells with real text (foreign overlays, box gaps) fall back to
      // native extraction and break softness; BLANK unowned cells (side
      // gutters, spacing) contribute nothing so mapped runs decide the join.
      const slice = this.#nativeSlice(selection.sourceLines[row], start, end);
      if (slice.length > 0) {
        pieces.push(slice);
        onUpdate({ soft: false, native: true });
      }
      return;
    }
    const resolved = this.#resolveProductRow(hit);
    if (!resolved) {
      pieces.push(this.#nativeSlice(selection.sourceLines[row], start, end));
      onUpdate({ soft: false, native: true });
      return;
    }
    onUpdate({ mapped: true });
    if (resolved.row.breakBefore !== "soft") onUpdate({ soft: false });
    if (resolved.row.bridge) onUpdate({ bridge: resolved.row.bridge });
    // Box rects are screen-space; the content origin's x comes back out.
    const origin = hit.box.rect.x - anchorX + resolved.colShift;
    for (const span of resolved.row.spans) {
      const from = Math.max(span.colStart + origin, start);
      const to = Math.min(span.colEnd + origin, end);
      if (to <= from) continue;
      if (span.kind === "decoration") continue;
      if (span.kind === "gap" || span.kind === "unknown" || span.text === undefined) {
        pieces.push(this.#nativeSlice(selection.sourceLines[row], from, to));
        onUpdate({ soft: false, native: true });
        continue;
      }
      pieces.push(this.#sliceSpanText(span.text, from - (span.colStart + origin), to - (span.colStart + origin)));
    }
  }

  #resolveProductRow(hit: LeafHit): ResolvedPiece | undefined {
    const product = productFor(hit.box.lines);
    if (!product) return undefined;
    let current: CopyProduct = product;
    let index = hit.lineIndex;
    let shift = 0;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      if (current.children) {
        const placement = current.children[index];
        if (!placement) return undefined;
        shift += placement.colShift;
        current = placement.product;
        index = placement.rowIndex;
        continue;
      }
      const row = current.rows[index];
      return row ? { row, colShift: shift } : undefined;
    }
    return undefined;
  }

  /** Which leaf owns each column (compositor semantics: later paints win).
   * Box rects/clips are screen-space even inside a scrolled subtree, so the
   * content origin's x/y come out when converting the content-space row and
   * clip range. */
  #ownershipFor(frame: LayoutFrameLike, row: number, anchor: { x: number; y: number }, contentSpace: boolean, maxCol: number): (LeafHit | undefined)[] {
    const cells: (LeafHit | undefined)[] = new Array(maxCol).fill(undefined);
    const subtreeRow = contentSpace ? row + anchor.y : row;
    const visit = (box: LayoutBoxLike): void => {
      if (box.lines !== undefined
          && subtreeRow >= box.rect.y && subtreeRow < box.rect.y + box.rect.height
          && subtreeRow >= box.clip.y && subtreeRow < box.clip.y + box.clip.height) {
        const lineIndex = subtreeRow - box.rect.y + (box.lineOffset ?? 0);
        if (lineIndex >= 0 && lineIndex < box.lines.length) {
          const hit: LeafHit = { box, lineIndex };
          const from = Math.max(0, box.clip.x - anchor.x);
          const to = Math.min(maxCol, box.clip.x + box.clip.width - anchor.x);
          for (let col = from; col < to; col++) cells[col] = hit;
        }
      }
      for (const child of box.children) visit(child);
    };
    visit(frame.root);
    return cells;
  }

  #nativeSlice(line: string | undefined, start: number, end: number): string {
    const source = line ?? "";
    if (end <= start) return "";
    return this.#fns.stripTerminalSequences(this.#fns.sliceByColumn(source, start, end - start, true)).trimEnd();
  }

  /** Cut a span's visible text to the selected cell subrange. localFrom/localTo
   * come from the host's grapheme-snapped selection columns, so they align
   * with grapheme edges here. */
  #sliceSpanText(text: string, localFrom: number, localTo: number): string {
    let cum = 0;
    let charPos = 0;
    let charStart = -1;
    for (const { segment } of GRAPHEMES.segment(text)) {
      const width = this.#fns.visibleWidth(segment);
      if (charStart === -1 && cum + width > localFrom) charStart = charPos;
      if (cum + width > localTo) return text.slice(charStart, charPos);
      cum += width;
      charPos += segment.length;
    }
    return charStart === -1 ? "" : text.slice(charStart);
  }
}
