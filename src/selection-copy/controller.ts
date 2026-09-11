// Copy controller: replaces getActiveSelectionText on the live TuiAltScreen
// instance (instance property shadows the prototype chain — including any
// heuristic wrapper installed there by other extensions, e.g.
// pi-copy-soft-wrap — independent of load order), and gives the composer
// editor a selection-aware Ctrl+C. Selection geometry stays host-native
// (getSelectionBounds / getSelectionColumns); only serialization changes.
//
// Behavioral contract:
// - No geometric selection → identical to the stock implementation.
// - Selection with copyable content → exact logical text.
// - Decoration-only selection → "" (never writes the clipboard, never
//   triggers editor clear); hasActiveSelection() stays true because the
//   geometry exists.
// - Unmapped regions → native per-row extraction mixed with exact spans,
//   separated by hard boundaries.

import { SelectionSerializer, type LayoutFrameLike } from "./serialize.ts";
import type { SerializeHostFns } from "./serialize.ts";

export interface CopyTelemetry {
  /** Raw replacement invocations (diagnostics: is the patch live at all). */
  calls?: number;
  exact: number;
  mixed: number;
  nativeFallback: number;
  emptyDecoration: number;
  failed: number;
  lastMode: "exact" | "mixed" | "native-fallback" | "empty-decoration" | "failed" | "none";
  lastCharCount: number;
  lastDurationMs: number;
  lastReason: string;
}

export interface AltScreenLike {
  getSelectionBounds?: () => { start: { row: number; col: number; scrollView?: unknown; boundary?: boolean }; end: { row: number; col: number; scrollView?: unknown; boundary?: boolean } } | undefined;
  getSelectionColumns?: (line: string, row: number, selection: unknown, minColumn?: number, maxColumn?: number) => { start: number; end: number };
  getActiveSelectionText?: () => string | undefined;
  copyTextToClipboard?: (text: string) => Promise<boolean>;
  currentLayout?: LayoutFrameLike & { primaryScrollView?: { scrollTop: number } } | undefined;
  previousScreen?: readonly string[];
  [key: string]: unknown;
}

export interface CopyControllerDeps {
  fns: SerializeHostFns;
  telemetry: CopyTelemetry;
  /** pi-copy-soft-wrap / unknown owner detection (diagnostics only). */
  prototypePatchedByOther(): string | undefined;
}

const OWNER = Symbol.for("Rycen7822.pi-codex-appearance.selection-serializer");

/** Install the exact serializer on the TuiAltScreen PROTOTYPE. The host hands
 * extensions a Proxy facade (createInteractiveTuiReference) whose target is an
 * empty object, so instance-level property assignment is invisible to the real
 * TUI; the prototype is reachable through the proxy's getPrototypeOf and is
 * the one seam that all internal callers (hasActiveSelection,
 * copySelectionToClipboard, copy-on-select, Ctrl+X) dispatch through. */
export function installInstanceSerializer(tui: AltScreenLike, deps: CopyControllerDeps): boolean {
  const prototype = Object.getPrototypeOf(tui) as Record<string | symbol, unknown>;
  if (!prototype || typeof prototype !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(prototype, OWNER)) {
    return prototype[OWNER] === true;
  }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "getActiveSelectionText");
  if (!descriptor || typeof descriptor.value !== "function"
      || typeof prototype.getSelectionBounds !== "function"
      || typeof prototype.getSelectionColumns !== "function") {
    return false;
  }
  const serializer = new SelectionSerializer(deps.fns);
  const replacement = function (this: AltScreenLike): string | undefined {
    deps.telemetry.calls = (deps.telemetry.calls ?? 0) + 1;
    const started = Date.now();
    const bounds = this.getSelectionBounds?.();
    if (!bounds) return undefined;
    const selection = bounds;
    const sourceLines = selection.start.scrollView === undefined
      ? (this.previousScreen ?? [])
      : scrollContentLinesOf(this, selection.start.scrollView);
    if (sourceLines === undefined) return undefined;
    const layout = this.currentLayout;
    const columnsFor = (row: number): { start: number; end: number } =>
      this.getSelectionColumns!(sourceLines[row] ?? "", row, selection);
    try {
      const result = serializer.serialize(layout as LayoutFrameLike, {
        scrollView: selection.start.scrollView,
        startRow: selection.start.row,
        endRow: selection.end.row,
        sourceLines,
        columnsFor,
      });
      const telemetry = deps.telemetry;
      telemetry.lastCharCount = result.text.length;
      telemetry.lastDurationMs = Date.now() - started;
      if (result.text.length === 0) {
        telemetry.emptyDecoration += 1;
        telemetry.lastMode = "empty-decoration";
      } else if (result.nativeRows === 0) {
        telemetry.exact += 1;
        telemetry.lastMode = "exact";
      } else if (result.mappedRows > 0) {
        telemetry.mixed += 1;
        telemetry.lastMode = "mixed";
      } else {
        telemetry.nativeFallback += 1;
        telemetry.lastMode = "native-fallback";
      }
      return result.text;
    } catch (error) {
      deps.telemetry.failed += 1;
      deps.telemetry.lastMode = "failed";
      deps.telemetry.lastReason = error instanceof Error ? error.message : "serialize failed";
      // Native fallback: stock per-row extraction (without heuristics).
      const lines: string[] = [];
      const source = this.previousScreen ?? [];
      for (let row = selection.start.row; row <= selection.end.row; row++) {
        const columns = columnsFor(row);
        const line = source[row] ?? "";
        lines.push(deps.fns.stripTerminalSequences(deps.fns.sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true)).trimEnd());
      }
      return lines.join("\n");
    }
  };
  Object.defineProperty(prototype, "getActiveSelectionText", {
    value: replacement,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(replacement, "ownerMarker", { value: "pi-codex-appearance", enumerable: false });
  prototype[OWNER] = true;
  return true;
}

/** True when the prototype's active method carries our marker. */
export function serializerIsLive(tui: AltScreenLike): boolean {
  const prototype = Object.getPrototypeOf(tui) as Record<string, unknown>;
  const method = prototype?.getActiveSelectionText as { ownerMarker?: string } | undefined;
  return method?.ownerMarker === "pi-codex-appearance";
}

function scrollContentLinesOf(tui: AltScreenLike, scrollView: unknown): readonly string[] | undefined {
  const layout = tui.currentLayout;
  if (!layout) return undefined;
  const box = findScrollViewBox(layout.root, scrollView);
  return box?.scrollContentLines;
}

function findScrollViewBox(box: import("./serialize.ts").LayoutBoxLike, scrollView: unknown): import("./serialize.ts").LayoutBoxLike | undefined {
  if (box.scrollView === scrollView) return box;
  for (const child of box.children) {
    const found = findScrollViewBox(child, scrollView);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Editor Ctrl+C routing
// ---------------------------------------------------------------------------

export interface SelectionCopyEditorHost {
  /** Host keybindings manager (structural access). */
  keybindings?: { matches?: (data: string, action: string) => boolean };
  /** The live TUI instance (Editor stores it as `tui`). */
  tui?: AltScreenLike;
}

export interface CopyRequestState {
  inFlight: boolean;
  queued: number;
}

/** Try to consume a copy keypress. Returns true when the key was consumed
 * (copy started, or selection existed but was decoration-only). Never calls
 * the clipboard when the extraction is empty; never clears the editor. */
export function tryConsumeCopyKey(
  data: string,
  host: SelectionCopyEditorHost,
  deps: { clipboard: (text: string) => Promise<boolean>; state: CopyRequestState; onError: (message: string) => void },
): boolean {
  const tui = host.tui;
  if (!tui) return false;
  const matchesClear = host.keybindings?.matches?.(data, "app.clear") ?? data === "\x03";
  if (!matchesClear) return false;
  const bounds = tui.getSelectionBounds?.();
  if (!bounds) return false;
  // Selection exists: consume the key regardless of copyability.
  const text = tui.getActiveSelectionText?.() ?? "";
  if (text.length === 0) return true;
  // Bounded in-flight: snapshot is synchronous; at most one queued copy.
  const run = (): void => {
    deps.state.inFlight = true;
    void deps.clipboard(text)
      .catch((error) => {
        deps.onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        deps.state.inFlight = false;
        if (deps.state.queued > 0) {
          deps.state.queued -= 1;
          run();
        }
      });
  };
  if (deps.state.inFlight) {
    if (deps.state.queued < 1) deps.state.queued += 1;
    return true;
  }
  run();
  return true;
}
