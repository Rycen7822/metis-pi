// Selection-copy system: prototype wrapping (provenance generation),
// instance serializer install, editor Ctrl+C hook and diagnostics. Created
// once per activation; every failure degrades to native extraction.
//
// Serializer/controller contract: replaces getActiveSelectionText on the live TuiAltScreen
// instance (instance property shadows the prototype chain — including any
// heuristic wrapper installed there by other extensions, e.g.
// pi-copy-soft-wrap — independent of load order), and gives the composer
// editor a selection-aware Ctrl+C. Selection geometry stays host-native
// (getSelectionBounds / getSelectionColumns). Clipboard transport stays behind
// the host's completion/error handling; local WSL keeps one warmed writer.
//
// Behavioral contract:
// - No geometric selection → identical to the stock implementation.
// - Selection with copyable content → exact logical text.
// - Decoration-only selection → undefined, exactly like stock (stock maps
//   empty text to undefined): hasActiveSelection() stays false and no
//   clipboard write happens. Ctrl+C is STILL consumed by the editor hook,
//   which keys off getSelectionBounds (geometry), not the text.
// - Unmapped regions → native per-row extraction mixed with exact spans,
//   separated by hard boundaries.

import {
  BOX_COPY_OWNER, CONTAINER_COPY_OWNER, MOUSE_REGION_COPY_OWNER,
  wrapBoxPrototype, wrapContainerPrototype, wrapMouseRegionPrototype,
} from "./structure.ts";
import {
  MARKDOWN_COPY_OWNER, TEXT_COPY_OWNER,
  wrapMarkdownPrototype, wrapTextPrototype, setLatexPainter, type MarkdownDiagnostics, type WrapDeps,
} from "./markdown.ts";
import { cacheStats } from "./model.ts";
import { createSelectionClipboard } from "./clipboard.ts";
import { stripAnsi } from "./wrap.ts";
import { createCopyLexer } from "./parser.ts";
import { SelectionSerializer, findScrollViewBox, type LayoutFrameLike, type SerializeHostFns, type AdapterHostFns } from "./serialize.ts";

export interface SelectionCopyHost {
  prototypes?: {
    Text: object;
    Markdown: object;
    Box: object;
    Container: object;
    MouseRegion?: object;
  };
  fns?: {
    visibleWidth(text: string): number;
    sliceByColumn(line: string, start: number, width: number, preserveAnsi: boolean): string;
    stripTerminalSequences(line: string): string;
    wrapTextWithAnsi(text: string, width: number): string[];
    renderLatex(text: string, options?: { display?: boolean }): string | null;
  };
}

export interface SelectionCopySystem {
  wrapPrototypes(): { installed: boolean; details: string };
  installOnTui(tui: unknown): boolean;
  dispose(): void;
  /** Editor input hook: consume Ctrl+C when a selection exists. */
  editorHook(): { tryConsume: (data: string, editor: unknown) => boolean } | undefined;
  diagnostics(): {
    telemetry: CopyTelemetry;
    mirrors: MarkdownDiagnostics;
    externalPatch: string | undefined;
    serializerInstalled: boolean;
    installBlocker: string;
    live: boolean;
    cache: { hits: number; misses: number };
  };
}

export function createSelectionCopySystem(host: SelectionCopyHost, externalPatch: string | undefined = undefined): SelectionCopySystem {
  const telemetry: CopyTelemetry = {
    exact: 0,
    mixed: 0,
    nativeFallback: 0,
    emptyDecoration: 0,
    failed: 0,
    lastMode: "none",
    lastCharCount: 0,
    lastDurationMs: 0,
    lastReason: "",
  calls: 0,
  };
  const mirrors: MarkdownDiagnostics = {
    markdownBuilt: 0,
    markdownDegraded: 0,
    textBuilt: 0,
    textDegraded: 0,
    markdownThrottled: 0,
    textThrottled: 0,
    lastDegradedReason: "",
  };
  const fns = host.fns;
  let serializerInstalled = false;
  let installBlocker = "not attempted (no live TUI captured)";
  let installedTui: AltScreenLike | undefined;
  const copyState = { inFlight: false, queued: 0 };
  const clipboard = createSelectionClipboard();

  // ONE host-fns adapter per activation: the prototype wrappers (via deps) and
  // the instance serializer (via controllerDeps) read the same object, so the
  // two install paths can never disagree about the host primitives.
  const hostFns: AdapterHostFns | undefined = fns
    ? {
        visibleWidth: fns.visibleWidth,
        sliceByColumn: fns.sliceByColumn,
        stripTerminalSequences: fns.stripTerminalSequences,
        stripAnsi,
      }
    : undefined;
  const deps: WrapDeps | undefined = hostFns && fns
    ? { fns: hostFns, lexer: createCopyLexer(), hostWrap: fns.wrapTextWithAnsi, diagnostics: mirrors }
    : undefined;

  return {
    wrapPrototypes(): { installed: boolean; details: string } {
      if (!deps || !host.prototypes) {
        return { installed: false, details: "host bindings unavailable" };
      }
      setLatexPainter(fns!.renderLatex);
      // The owners are Symbol.for keys, so a SECOND activation of this
      // extension in the same process (a subagent's session) sees the parent
      // session's marks: "self" entries are already producing copy metadata
      // and must stay silent. Only genuinely blocked entries (sealed, or a
      // foreign render replacement) fail the install.
      const entries: [name: string, prototype: object, owner: symbol, wrapped: boolean][] = [
        ["markdown", host.prototypes.Markdown, MARKDOWN_COPY_OWNER, wrapMarkdownPrototype(host.prototypes.Markdown, deps)],
        ["text", host.prototypes.Text, TEXT_COPY_OWNER, wrapTextPrototype(host.prototypes.Text, deps)],
        ["box", host.prototypes.Box, BOX_COPY_OWNER, wrapBoxPrototype(host.prototypes.Box)],
        ["container", host.prototypes.Container, CONTAINER_COPY_OWNER, wrapContainerPrototype(host.prototypes.Container)],
      ];
      if (host.prototypes.MouseRegion) {
        entries.push(["mouse-region", host.prototypes.MouseRegion, MOUSE_REGION_COPY_OWNER, wrapMouseRegionPrototype(host.prototypes.MouseRegion)]);
      }
      const selfOwned = (prototype: object, owner: symbol): boolean =>
        Object.prototype.hasOwnProperty.call(prototype, owner);
      return {
        installed: entries.every(([, prototype, owner, wrapped]) => wrapped || selfOwned(prototype, owner)),
        details: entries
          .map(([name, prototype, owner, wrapped]) => `${name}=${wrapped ? "on" : selfOwned(prototype, owner) ? "self" : "blocked"}`)
          .join(" "),
      };
    },

    installOnTui(tui: unknown): boolean {
      if (hostFns) clipboard.install(tui);
      if (serializerInstalled) return true;
      if (!hostFns) { installBlocker = "host bindings unavailable"; return false; }
      if (!tui || typeof tui !== "object") { installBlocker = "invalid tui"; return false; }
      externalPatch ??= detectExternalSerializerPatch(Object.getPrototypeOf(tui));
      const controllerDeps: CopyControllerDeps = { fns: hostFns, telemetry, prototypePatchedByOther: () => externalPatch };
      serializerInstalled = installInstanceSerializer(tui as AltScreenLike, controllerDeps);
      if (serializerInstalled) installedTui = tui as AltScreenLike;
      installBlocker = serializerIsLive(tui as AltScreenLike) ? "live" : installBlocker;
      if (!serializerInstalled) {
        const missing = ["getActiveSelectionText", "getSelectionBounds", "getSelectionColumns"]
          .filter((name) => typeof (tui as AltScreenLike)[name] !== "function");
        const kind = (tui as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
        installBlocker = missing.length > 0
          ? `${kind}: missing ${missing.join(",")}`
          : `${kind}: already owned`;
      }
      return serializerInstalled;
    },

    dispose(): void {
      copyState.queued = 0;
      clipboard.dispose();
    },

    editorHook() {
      if (!fns) return undefined;
      return {
        tryConsume: (data: string, editor: unknown): boolean => {
          const editorHost = editor as { keybindings?: { matches?: (data: string, action: string) => boolean }; tui?: unknown };
          const tui = editorHost.tui as (AltScreenLike & { copyTextToClipboard?: (text: string) => Promise<boolean> }) | undefined;
          if (!tui) return false;
          return tryConsumeCopyKey(data, { keybindings: editorHost.keybindings, tui }, {
            clipboard: (text) => {
              const copy = tui.copyTextToClipboard;
              if (typeof copy !== "function") return Promise.resolve(false);
              return copy.call(tui, text);
            },
            state: copyState,
            onError: (message) => {
              telemetry.failed += 1;
              telemetry.lastMode = "failed";
              telemetry.lastReason = message;
            },
          });
        },
      };
    },

    diagnostics() {
      return { telemetry, mirrors, externalPatch, serializerInstalled, installBlocker, live: installedTui ? serializerIsLive(installedTui) : false, cache: cacheStats() };
    },
  };
}

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
  currentLayout?: LayoutFrameLike | undefined;
  previousScreen?: readonly string[];
  [key: string]: unknown;
}

export interface CopyControllerDeps {
  fns: SerializeHostFns;
  telemetry: CopyTelemetry;
  /** pi-copy-soft-wrap / unknown owner detection (diagnostics only). */
  prototypePatchedByOther(): string | undefined;
}

const OWNER = Symbol.for("Rycen7822.metis-pi.selection-serializer");

/** Patch the native renderer prototype so internal selection/copy callers and
 * replacement renderers share the serializer. The host's live Proxy forwards
 * assignment, but own property descriptors still belong to its empty target. */
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
        // Stock parity: empty extraction maps to undefined (hasActiveSelection
        // false, no clipboard write, host Esc routing unchanged).
        return undefined;
      }
      if (result.nativeRows === 0) {
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
      // Native fallback over the same sourceLines — scrollView selections are
      // content-space; previousScreen is screen-space and would copy wrong rows.
      const lines: string[] = [];
      for (let row = selection.start.row; row <= selection.end.row; row++) {
        const columns = columnsFor(row);
        const line = sourceLines[row] ?? "";
        lines.push(deps.fns.stripTerminalSequences(deps.fns.sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true)).trimEnd());
      }
      const fallback = lines.join("\n");
      return fallback.length === 0 ? undefined : fallback;
    }
  };
  Object.defineProperty(prototype, "getActiveSelectionText", {
    value: replacement,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(replacement, "ownerMarker", { value: "metis-pi", enumerable: false });
  prototype[OWNER] = true;
  return true;
}

/** True when the prototype's active method carries our marker. */
export function serializerIsLive(tui: AltScreenLike): boolean {
  const prototype = Object.getPrototypeOf(tui) as Record<string, unknown>;
  const method = prototype?.getActiveSelectionText as { ownerMarker?: string } | undefined;
  return method?.ownerMarker === "metis-pi";
}

function scrollContentLinesOf(tui: AltScreenLike, scrollView: unknown): readonly string[] | undefined {
  const layout = tui.currentLayout;
  if (!layout) return undefined;
  const box = findScrollViewBox(layout.root, scrollView);
  return box?.scrollContentLines;
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
  // Bounded in-flight: snapshot is synchronous; at most one queued copy. A
  // drained queue copies the CURRENT selection, not the stale first snapshot.
  const run = (snapshot: string): void => {
    deps.state.inFlight = true;
    void deps.clipboard(snapshot)
      .catch((error) => {
        deps.onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        deps.state.inFlight = false;
        if (deps.state.queued > 0) {
          deps.state.queued -= 1;
          const fresh = tui.getActiveSelectionText?.() ?? "";
          if (fresh.length > 0) run(fresh);
        }
      });
  };
  if (deps.state.inFlight) {
    if (deps.state.queued < 1) deps.state.queued += 1;
    return true;
  }
  run(text);
  return true;
}

/** Detect a foreign getActiveSelectionText wrapper on the prototype (e.g.
 * pi-copy-soft-wrap). Returns a short owner label for diagnostics. */
export function detectExternalSerializerPatch(altScreenPrototype: object | undefined): string | undefined {
  if (!altScreenPrototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(altScreenPrototype, "getActiveSelectionText");
  if (!descriptor || typeof descriptor.value !== "function") return undefined;
  let source = "";
  try {
    source = Function.prototype.toString.call(descriptor.value);
  } catch {
    return "unknown wrapper";
  }
  if (/unwrapVisualLines|soft-wrap|softWrap/i.test(source)) return "pi-copy-soft-wrap (heuristic wrapper)";
  // The stock implementation builds lines with sliceByColumn+trimEnd; anything
  // structurally different is a foreign wrapper we cannot name.
  if (!/getSelectionBounds|getSelectionColumns|sliceByColumn/i.test(source)) return "unknown wrapper";
  return undefined;
}
