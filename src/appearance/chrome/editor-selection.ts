import { Box, Container, getKeybindings, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { AltScreenLike } from "../../selection-copy/index.ts";
import type { LayoutBoxLike } from "../../selection-copy/serialize.ts";
import { productFor, publishRows, registerProduct, type CopyProduct } from "../../selection-copy/model.ts";
import { wrapBoxPrototype, wrapContainerPrototype } from "../../selection-copy/structure.ts";

interface VisualLine { logicalLine: number; startCol: number; length: number; }
interface NativeEditor {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  lastWidth: number;
  scrollOffset: number;
  renderedVisibleLineCount: number;
  lastAction: unknown;
  getPaddingX(): number;
  getText(): string;
  buildVisualLineMap(width: number): VisualLine[];
  segment(text: string, granularity: "grapheme"): Iterable<{ index: number; segment: string }>;
  cancelAutocomplete(): void;
  exitHistoryBrowsing(): void;
  pushUndoSnapshot(): void;
  setCursorCol(col: number): void;
  onChange?: (text: string) => void;
}
interface EditorFrame {
  lines: readonly string[];
  width: number;
  scrollOffset: number;
  visibleLines: number;
  padding: number;
}
interface EditorRow { frame: EditorFrame; row: number; left: number; width: number; }
type SelectionPoint = { row: number; col: number; boundary?: boolean };
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Pi 1.5 has no public range edit. Isolate the adapter here and reuse native
// wrapping, paste segmentation and undo rather than duplicating the editor.
function nativeEditor(value: unknown): NativeEditor | undefined {
  if (!value || typeof value !== "object") return;
  const editor = value as Partial<NativeEditor>;
  if (!Array.isArray(editor.state?.lines)) return;
  const methods = [
    "getPaddingX", "getText", "buildVisualLineMap", "segment", "cancelAutocomplete",
    "exitHistoryBrowsing", "pushUndoSnapshot", "setCursorCol",
  ] as const;
  if (methods.some(name => typeof editor[name] !== "function")) return;
  return editor as NativeEditor;
}

function offsetAtColumn(line: string, visual: VisualLine, column: number, edge: "start" | "end"): number {
  const chunk = line.slice(visual.startCol, visual.startCol + visual.length);
  let offset = visual.startCol, width = 0;
  for (const part of GRAPHEMES.segment(chunk)) {
    const nextWidth = width + visibleWidth(part.segment);
    if (column < nextWidth) {
      offset = visual.startCol + part.index;
      if (edge === "end" && column > width) offset += part.segment.length;
      break;
    }
    width = nextWidth;
    offset = visual.startCol + part.index + part.segment.length;
  }
  return offset;
}

// A paste marker may wrap into fragments but is still one editable atom.
function snapToSegment(editor: NativeEditor, line: string, offset: number, edge: "start" | "end"): number {
  for (const part of editor.segment(line, "grapheme")) {
    if (offset > part.index && offset < part.index + part.segment.length) {
      return edge === "start" ? part.index : part.index + part.segment.length;
    }
  }
  return offset;
}

/** Map the committed fullscreen selection to one composer edit. The existing
 * copy alignment products bridge opaque Box/Container layout leaves too. */
export class EditorSelection {
  private readonly editor: NativeEditor | undefined;
  private readonly tui: AltScreenLike;
  private readonly frames = new WeakMap<CopyProduct, EditorFrame>();

  constructor(editor: unknown, tui: unknown) {
    this.editor = nativeEditor(editor);
    this.tui = tui as AltScreenLike;
    if (this.editor) {
      // Shared, idempotent provenance wrappers; no new TUI/editor prototype
      // patch. Range deletion must also work when selection-copy is disabled.
      wrapContainerPrototype(Container.prototype);
      wrapBoxPrototype(Box.prototype);
    }
  }

  capture(rows: readonly string[], width: number): void {
    const editor = this.editor;
    if (!editor || typeof this.tui.getSelectionBounds !== "function") return;
    // Unknown copy rows retain native extraction. Only the edit adapter owns
    // the logical snapshot, tied to the exact products kept by a committed frame.
    const product: CopyProduct = { width, rows: [] };
    registerProduct(rows, product);
    publishRows(editor, rows);
    this.frames.set(product, {
      lines: editor.state.lines.slice(), width: editor.lastWidth, scrollOffset: editor.scrollOffset,
      visibleLines: editor.renderedVisibleLineCount, padding: editor.getPaddingX(),
    });
  }

  private resolveRow(box: LayoutBoxLike, point: SelectionPoint): EditorRow | undefined {
    const atRightBoundary = point.boundary && point.col === box.clip.x + box.clip.width;
    if (point.row < box.clip.y || point.row >= box.clip.y + box.clip.height
        || point.col < box.clip.x || (point.col >= box.clip.x + box.clip.width && !atRightBoundary)) return;
    for (const child of box.children) {
      const row = this.resolveRow(child, point);
      if (row) return row;
    }
    let product = productFor(box.lines);
    let row = point.row - box.rect.y + (box.lineOffset ?? 0), left = box.rect.x;
    const visited = new Set<CopyProduct>();
    while (product && !visited.has(product)) {
      visited.add(product);
      const frame = this.frames.get(product);
      if (frame) {
        const insideRight = point.col < left + product.width || (point.boundary && point.col === left + product.width);
        if (row >= 1 && row <= frame.visibleLines && point.col >= left && insideRight) {
          return { frame, row, left, width: product.width };
        }
        return;
      }
      const child = product.children?.[row];
      if (!child) return;
      row = child.rowIndex; left += child.colShift; product = child.product;
    }
  }

  tryDelete(data: string): boolean {
    const kb = getKeybindings();
    if (!kb.matches(data, "tui.editor.deleteCharBackward") && !kb.matches(data, "tui.editor.deleteCharForward")
        && !matchesKey(data, "shift+backspace") && !matchesKey(data, "shift+delete")) return false;
    const editor = this.editor, tui = this.tui;
    const columnsFor = tui?.getSelectionColumns;
    if (!editor || typeof tui.getSelectionBounds !== "function" || typeof columnsFor !== "function"
        || typeof tui.resetTextSelection !== "function") return false;
    const bounds = tui.getSelectionBounds();
    if (!bounds || bounds.start.scrollView || bounds.end.scrollView || !tui.currentLayout) return false;
    const first = this.resolveRow(tui.currentLayout.root, bounds.start), last = this.resolveRow(tui.currentLayout.root, bounds.end);
    if (!first || !last || first.frame !== last.frame || first.left !== last.left
        || bounds.start.row - first.row !== bounds.end.row - last.row) return false;
    const frame = first.frame;
    if (frame.lines.length !== editor.state.lines.length
        || frame.lines.some((line, index) => line !== editor.state.lines[index])) return false;
    const visualLines = editor.buildVisualLineMap(frame.width);
    const endpoint = (point: SelectionPoint, row: EditorRow, edge: "start" | "end") => {
      const visual = visualLines[frame.scrollOffset + row.row - 1], screenLine = tui.previousScreen?.[point.row];
      const line = visual && frame.lines[visual.logicalLine];
      if (!visual || line === undefined || screenLine === undefined) return;
      // Same padding clamp as native render/mouse input in narrow terminals.
      const padding = Math.min(frame.padding, Math.max(0, Math.floor((row.width - 1) / 2)));
      const left = row.left + padding;
      const columns = columnsFor.call(tui, screenLine, point.row, bounds, left, row.left + row.width - padding);
      return { line: visual.logicalLine, text: line,
        col: offsetAtColumn(line, visual, Math.max(0, columns[edge] - left), edge) };
    };
    const start = endpoint(bounds.start, first, "start"), end = endpoint(bounds.end, last, "end");
    if (!start || !end) return false;
    tui.resetTextSelection();
    if (start.line === end.line && start.col === end.col) return true; // Padding-only selection.
    const startCol = snapToSegment(editor, start.text, start.col, "start");
    const endCol = snapToSegment(editor, end.text, end.col, "end");
    editor.cancelAutocomplete();
    editor.exitHistoryBrowsing();
    editor.pushUndoSnapshot();
    editor.state.lines.splice(start.line, end.line - start.line + 1, start.text.slice(0, startCol) + end.text.slice(endCol));
    editor.state.cursorLine = start.line;
    editor.setCursorCol(startCol);
    editor.lastAction = null;
    editor.onChange?.(editor.getText());
    return true;
  }
}
