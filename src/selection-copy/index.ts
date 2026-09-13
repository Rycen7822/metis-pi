// Selection-copy system barrel: prototype wrapping (provenance generation),
// instance serializer install, editor Ctrl+C hook and diagnostics. Created
// once per activation; every failure degrades to native extraction.

import { wrapBoxPrototype, wrapContainerPrototype, wrapMouseRegionPrototype } from "./structure.ts";
import { wrapMarkdownPrototype, wrapTextPrototype, setLatexPainter, type MarkdownDiagnostics, type WrapDeps } from "./markdown.ts";
import { installInstanceSerializer, serializerIsLive, tryConsumeCopyKey, type AltScreenLike, type CopyTelemetry, type CopyControllerDeps } from "./controller.ts";
import { cacheStats } from "./model.ts";
import type { AdapterHostFns } from "./shared.ts";
import { stripAnsi } from "./wrap.ts";
import { createCopyLexer } from "./parser.ts";

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

  const deps: WrapDeps | undefined = fns
    ? {
        fns: {
          visibleWidth: fns.visibleWidth,
          sliceByColumn: fns.sliceByColumn,
          stripTerminalSequences: fns.stripTerminalSequences,
          stripAnsi,
        } satisfies AdapterHostFns,
        lexer: createCopyLexer(),
        hostWrap: fns.wrapTextWithAnsi,
        diagnostics: mirrors,
      }
    : undefined;

  return {
    wrapPrototypes(): { installed: boolean; details: string } {
      if (!deps || !host.prototypes) {
        return { installed: false, details: "host bindings unavailable" };
      }
      setLatexPainter(fns!.renderLatex);
      const wraps: [string, boolean][] = [
        ["markdown", wrapMarkdownPrototype(host.prototypes.Markdown, deps)],
        ["text", wrapTextPrototype(host.prototypes.Text, deps)],
        ["box", wrapBoxPrototype(host.prototypes.Box)],
        ["container", wrapContainerPrototype(host.prototypes.Container)],
      ];
      if (host.prototypes.MouseRegion) wraps.push(["mouse-region", wrapMouseRegionPrototype(host.prototypes.MouseRegion)]);
      return {
        installed: wraps.every(([, ok]) => ok),
        details: wraps.map(([name, ok]) => `${name}=${ok ? "on" : "already-owned"}`).join(" "),
      };
    },

    installOnTui(tui: unknown): boolean {
      if (serializerInstalled) return true;
      if (!fns) { installBlocker = "host bindings unavailable"; return false; }
      if (!tui || typeof tui !== "object") { installBlocker = "invalid tui"; return false; }
      externalPatch ??= detectExternalSerializerPatch(Object.getPrototypeOf(tui));
      const controllerDeps: CopyControllerDeps = {
        fns: {
          visibleWidth: fns.visibleWidth,
          sliceByColumn: fns.sliceByColumn,
          stripTerminalSequences: fns.stripTerminalSequences,
        },
        telemetry,
        prototypePatchedByOther: () => externalPatch,
      };
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
