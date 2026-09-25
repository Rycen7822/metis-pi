// Codex chrome lifecycle: the install state machine for the editor, footer,
// header and Working widgets, plus the shutdown restore.
//
// Install goes through PUBLIC host APIs only. Every step degrades to the
// native host surface on failure, and the whole path is best-effort: a chrome
// install must never take the session down. The five chrome modules are
// preloaded on construction so session_start rarely waits for the imports.

import { diffSignFg } from "../diff.ts";
import type { SegmentTone } from "../segments.ts";
import type { ColorLevel } from "../palette.ts";
import type { AppearanceConfig } from "../config.ts";
import type { HostData, UiAvailable } from "../host-data.ts";
import type { CodexSurfaceOps } from "./editor.ts";
import { WORKING_WIDGET_KEY, type WorkingComponent } from "./working.ts";
import type { SnapshotSource } from "./snapshots.ts";

/** Agent-dir status slot used by the transient settled-summary line. */
export const SUMMARY_STATUS_KEY = "metis-pi:summary";

type ChromeMods = typeof import("./editor.ts") & typeof import("./footer.ts") & typeof import("./header.ts")
  & typeof import("./working.ts");

/** Which chrome widgets are installed on the live UI right now. */
export interface ChromeState {
  /** Invalidates late async installs: a preload resolving after shutdown or a
   * new session must not touch the new UI. */
  generation: number;
  editorFactory: object | undefined;
  editorInstalled: boolean;
  surfaceApplied: boolean;
  prefixApplied: boolean;
  footerInstalled: boolean;
  headerInstalled: boolean;
  widgetInstalled: boolean;
  widgetFactory: unknown;
  workingComponent: WorkingComponent | undefined;
  nativeLoaderHidden: boolean;
  fallbackMessage: boolean;
  /** Our captured renderer handle (`requestRender` source). */
  tui: { requestRender?: () => void } | undefined;
}

/** Explicit dependencies of the chrome lifecycle — one named field each. */
export interface ChromeDeps {
  config: AppearanceConfig;
  hostData: HostData;
  /** Terminal color capability, resolved once at boot. */
  colorLevel: ColorLevel;
  editorHost: { CustomEditor: unknown; visibleWidth?: (text: string) => number } | undefined;
  surface: CodexSurfaceOps | undefined;
  /** Real versions for the header identity line. */
  appearanceVersion: string | undefined;
  piVersion: string | undefined;
  /** Snapshot source; read lazily (built after this lifecycle). */
  getSnapshots(): SnapshotSource;
  /** Repaint request (the captured renderer, when there is one). */
  requestRender(): void;
  /** Adopt the renderer every chrome factory receives. */
  captureTui(tui: unknown): void;
  /** Selection-copy Ctrl+C hook for the editor (undefined when disabled). */
  selectionCopyHook(): { tryConsume: (data: string, editor: unknown) => boolean } | undefined;
  /** A Working interaction is in flight (agent_start fired, not yet settled). */
  isInteractionActive(): boolean;
}

export interface ChromeLifecycle {
  /** Mutable install state (diagnostics reads it; events write `tui`). */
  readonly state: ChromeState;
  /** Install everything public-API-installable for this session. */
  install(available: UiAvailable, generation: number): Promise<void>;
  /** Drop late installs from a previous session (preload in flight). */
  invalidate(): void;
  /** Remove OUR factories only (identity checked) — a successor's stay. */
  restore(): void;
  /** Show/hide the above-editor Working widget (undefined = hide). */
  setWidgetVisible(visible: boolean): void;
}

/** Tone painter for footer text (the theme may be an unbound proxy
 * early on — degrade to plain text instead of crashing). */
function makeTonePainter(theme: { fg?: (key: string, text: string) => string } | undefined, colorLevel: ColorLevel) {
  return (text: string, tone: SegmentTone): string => {
    if (tone === "normal" || !text) return text;
    if (tone === "add" || tone === "del") {
      // Same green/red as the diff renderer — Codex has no theme key for them.
      const fg = diffSignFg(tone === "add" ? "add" : "remove", colorLevel);
      return fg ? `${fg}${text}\x1b[39m` : text;
    }
    const key = tone === "warning" ? "warning" : tone;
    try {
      return typeof theme?.fg === "function" ? theme.fg(key as never, text) : text;
    } catch {
      return text;
    }
  };
}

export function createChromeLifecycle(deps: ChromeDeps): ChromeLifecycle {
  const { config, hostData } = deps;
  const state: ChromeState = {
    generation: 0,
    editorFactory: undefined,
    editorInstalled: false,
    surfaceApplied: false,
    prefixApplied: false,
    footerInstalled: false,
    headerInstalled: false,
    widgetInstalled: false,
    widgetFactory: undefined,
    workingComponent: undefined,
    nativeLoaderHidden: false,
    fallbackMessage: false,
    tui: undefined,
  };

  /** The ctx.ui slice chrome installs into (public API only). */
  const uiOf = () => hostData.ui as Partial<{
    setEditorComponent: (factory: unknown) => void;
    getEditorComponent: () => unknown;
    setFooter: (factory: unknown) => void;
    setHeader: (factory: unknown) => void;
    setWidget: (key: string, content: unknown, options?: unknown) => void;
    setWorkingVisible: (visible: boolean) => void;
    setWorkingIndicator: (options?: unknown) => void;
    setWorkingMessage: (message?: string) => void;
    setStatus: (key: string, text: string | undefined) => void;
  }>;

  let chromeMods: Promise<ChromeMods | undefined> | undefined;
  const preloadChrome = (): Promise<ChromeMods | undefined> => {
    chromeMods ??= Promise.all([
      import("./editor.ts"),
      import("./footer.ts"),
      import("./header.ts"),
      import("./working.ts"),
    ]).then(([editor, footer, header, working]) => ({ ...editor, ...footer, ...header, ...working }))
      .catch(() => undefined);
    return chromeMods;
  };
  // Start the preload immediately so session_start rarely waits.
  void preloadChrome();

  const setWidgetVisible = (visible: boolean): void => {
    const ui = uiOf();
    if (typeof ui.setWidget !== "function") return;
    try {
      if (visible && state.widgetInstalled && state.widgetFactory) {
        ui.setWidget(WORKING_WIDGET_KEY, state.widgetFactory, { placement: "aboveEditor" });
      } else if (!visible) {
        ui.setWidget(WORKING_WIDGET_KEY, undefined);
      }
    } catch { /* widget slot is best-effort */ }
  };

  /** Install the Codex-style chrome through PUBLIC host APIs only. Preloaded
   * modules install synchronously when ready; a preload resolving after the
   * generation changed (shutdown/new session) is dropped. */
  const install = async (available: UiAvailable, generation: number): Promise<void> => {
    const ui = uiOf();
    const snapshots = deps.getSnapshots();
    const mods = await preloadChrome();
    if (!mods || generation !== state.generation) return;

    // Editor factory: Codex surface composer. The gray surface (when the
    // terminal can carry it and surface ops were injected) replaces the
    // accent borders; embedWorkingStatus is OFF — the Working line lives in
    // the above-editor widget.
    if (available.setEditorComponent && !ui.getEditorComponent?.() && deps.editorHost?.CustomEditor) {
      try {
        const surface = config.composer.surface ? deps.surface : undefined;
        const factory = mods.makeCodexEditorFactory({
          host: deps.editorHost as never,
          paddingX: 2,
          embedWorkingStatus: false,
          surface,
          promptPrefix: config.composer.promptPrefix,
          placeholder: "Ask anything...",
          selectionCopy: deps.selectionCopyHook(),
          // The host auto-triggers "/" only at line start; without this the
          // second skill trigger (`/skill:a /`) never queries the provider.
          skillTrigger: true,
        });
        state.editorFactory = factory;
        state.surfaceApplied = surface !== undefined;
        state.prefixApplied = surface !== undefined && config.composer.promptPrefix;
        ui.setEditorComponent?.(factory as never);
        state.editorInstalled = true;
      } catch { /* editor stays native */ }
    }

    // Footer: model/effort/provider · cwd/branch · context · I/O · cache · speed.
    if (available.setFooter && config.footer.enabled) {
      try {
        ui.setFooter?.((tui: unknown, theme: { fg?: (k: string, t: string) => string }, footerData: unknown) => {
          deps.captureTui(tui);
          return mods.createFooterComponent(
            { getSnapshot: snapshots.getFooterSnapshot, requestRender: deps.requestRender, show: snapshots.footerShow() },
            footerData as never,
            makeTonePainter(theme, deps.colorLevel),
          );
        });
        state.footerInstalled = true;
      } catch { /* footer stays native */ }
    }

    // Header: real identity line with real versions.
    if (available.setHeader) {
      try {
        ui.setHeader?.((_tui: unknown, theme: { fg?: (k: string, t: string) => string } | undefined) =>
          mods.createHeaderComponent(
            {
              appearanceVersion: deps.appearanceVersion ?? "unknown",
              piVersion: deps.piVersion ?? "unknown",
              getModel: () => hostData.getModel(),
              getCwd: () => hostData.getCwd(),
            },
            theme,
          ));
        state.headerInstalled = true;
      } catch { /* header stays native */ }
    }

    // Working: the standalone above-editor widget with the Codex rhythm.
    // The native loader row is hidden ONLY after the widget installed; without
    // setWidget the old message-based fallback stays (never two Working rows).
    if (available.setWidget) {
      try {
        const factory = (tui: unknown, theme: { fg?: (k: string, t: string) => string } | undefined) => {
          deps.captureTui(tui);
          const paint = (text: string, tone: "accent" | "dim" | "normal"): string => {
            if (!text || tone === "normal") return text;
            try {
              return typeof theme?.fg === "function" ? theme.fg(tone as never, text) : text;
            } catch {
              return text;
            }
          };
          const component = mods.createWorkingComponent({
            getSnapshot: snapshots.getWorkingSnapshot,
            getShow: snapshots.workingShow,
            getAnimation: snapshots.workingAnimation,
            requestRender: deps.requestRender,
            colorKind: deps.colorLevel.kind,
            paint,
          });
          state.workingComponent = component;
          return component;
        };
        state.widgetFactory = factory;
        state.widgetInstalled = true;
        // agent_start may have fired while the preload resolved — if an
        // interaction is already active, show the widget immediately.
        setWidgetVisible(deps.isInteractionActive());
        ui.setWorkingVisible?.(false);
        state.nativeLoaderHidden = true;
      } catch {
        state.widgetInstalled = false;
      }
    }
    if (!state.widgetInstalled && available.setWorkingIndicator) {
      try {
        ui.setWorkingIndicator?.({ frames: ["●"], intervalMs: 1000 });
        state.fallbackMessage = true;
      } catch { /* native spinner keeps its default */ }
    }
  };

  const restore = (): void => {
    const ui = uiOf();
    try {
      if (state.editorFactory && ui.getEditorComponent?.() === state.editorFactory) {
        ui.setEditorComponent?.(undefined);
      }
    } catch { /* keep current editor */ }
    state.editorFactory = undefined;
    state.editorInstalled = false;
    state.surfaceApplied = false;
    state.prefixApplied = false;
    try {
      if (state.footerInstalled) ui.setFooter?.(undefined);
    } catch { /* keep current footer */ }
    state.footerInstalled = false;
    try {
      if (state.headerInstalled) ui.setHeader?.(undefined);
    } catch { /* keep current header */ }
    state.headerInstalled = false;
    try {
      if (state.widgetInstalled) ui.setWidget?.(WORKING_WIDGET_KEY, undefined);
    } catch { /* keep widget slot */ }
    state.widgetInstalled = false;
    state.widgetFactory = undefined;
    state.workingComponent?.stopAnimation();
    state.workingComponent = undefined;
    if (state.nativeLoaderHidden) {
      try {
        ui.setWorkingVisible?.(true);
      } catch { /* native loader state is the host's */ }
      state.nativeLoaderHidden = false;
    }
    state.fallbackMessage = false;
    try {
      ui.setWorkingMessage?.();
      ui.setStatus?.(SUMMARY_STATUS_KEY, undefined);
    } catch { /* status slot is best-effort */ }
    state.tui = undefined;
  };

  return {
    state,
    install,
    invalidate: () => { state.generation += 1; },
    restore,
    setWidgetVisible,
  };
}
