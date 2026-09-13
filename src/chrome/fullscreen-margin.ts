// Fullscreen side gutters: the layout root is wrapped in a pi-tui HStack
// [Spacer | root | Spacer], so the LAYOUT ENGINE offsets every frame rect —
// mouse hit-testing, cursor placement, scrollbar and selection-copy all read
// the same shifted rects and stay correct; gutter clicks hit a Spacer (no
// handleMouse) and are no-ops. The seam is the renderer PROTOTYPE's
// setLayoutRoot (owner-symbol idempotent) because the extension only holds a
// Proxy facade; install retries until the renderer is fullscreen — regular
// mode is never touched, and a root mounted before install is wrapped
// retroactively by re-dispatching it through the setter.

export const FULLSCREEN_MARGIN_OWNER = Symbol.for("Rycen7822.pi-codex-appearance.fullscreen-margin");

interface ViewportLike {
  width?: unknown;
  height?: unknown;
}

interface TuiLike {
  mode?: unknown;
  layoutRoot?: unknown;
  setLayoutRoot?: (component: unknown) => void;
}

type SetLayoutRootFn = (this: TuiLike, component: unknown) => void;

export interface FullscreenMarginHost {
  HStack?: unknown;
  Spacer?: unknown;
}

export interface FullscreenMarginOptions {
  margin: number;
  minWidth: number;
}

export interface FullscreenMarginSystem {
  /** Idempotent; safe to call on every tui capture. */
  installOnTui(tui: unknown): boolean;
  dispose(): void;
  status(): { installed: boolean; reason: string };
}

interface HStackCtor {
  new (children: unknown[], options?: Record<string, unknown>): object;
}
interface SpacerCtor {
  new (lines?: number): { setLines(lines: number): void };
}

export function createFullscreenMargin(host: FullscreenMarginHost, options: FullscreenMarginOptions): FullscreenMarginSystem {
  let reason = "not installed";
  let wrappedProto: Record<string, unknown> | undefined;
  let original: SetLayoutRootFn | undefined;
  let liveTui: TuiLike | undefined;

  const markedRoot = (component: unknown): unknown => {
    if (!component || typeof component !== "object") return undefined;
    return (component as Record<symbol, unknown>)[FULLSCREEN_MARGIN_OWNER];
  };

  const wrapRoot = (root: unknown): object => {
    const HStack = host.HStack as HStackCtor;
    const Spacer = host.Spacer as SpacerCtor;
    // Floor: gutters only show when ≥20 content columns remain; the layout
    // engine re-evaluates `visible` every frame.
    const effectiveMinWidth = Math.max(options.minWidth, options.margin * 2 + 20);
    const side = () => {
      const spacer = new Spacer(1);
      return {
        component: spacer,
        basis: options.margin,
        grow: 0,
        shrink: 0,
        minSize: 0,
        visible(viewport: ViewportLike): boolean {
          // Stretch changes the rect, not Spacer's rendered row count. Paint
          // every gutter row so the host's auto-scrollbar ANSI composition
          // cannot carry a content background into the right-hand blank cells.
          spacer.setLines(typeof viewport?.height === "number" ? viewport.height : 1);
          return typeof viewport?.width === "number" ? viewport.width >= effectiveMinWidth : true;
        },
      };
    };
    const wrapper = new HStack(
      [side(), { component: root, basis: 0, grow: 1, shrink: 1, minSize: 1 }, side()],
      { align: "stretch" },
    );
    // The marker carries the real root so dispose can unwrap a live mount.
    Object.defineProperty(wrapper, FULLSCREEN_MARGIN_OWNER, { value: root, configurable: true });
    return wrapper;
  };

  const ensureRootWrapped = (tui: TuiLike): void => {
    try {
      const current = tui.layoutRoot;
      if (current && !markedRoot(current) && typeof tui.setLayoutRoot === "function") {
        tui.setLayoutRoot(current);
      }
    } catch { /* best-effort; the next mount intercepts */ }
  };

  return {
    installOnTui(tui: unknown): boolean {
      if (options.margin <= 0) { reason = "disabled (margin 0)"; return false; }
      if (typeof host.HStack !== "function" || typeof host.Spacer !== "function") {
        reason = "host bindings unavailable";
        return false;
      }
      if (!tui || typeof tui !== "object") { reason = "invalid tui"; return false; }
      if ((tui as TuiLike).mode !== "fullscreen") { reason = "renderer is not fullscreen"; return false; }
      liveTui = tui as TuiLike;
      const proto = Object.getPrototypeOf(tui) as Record<string, unknown>;
      const current = proto.setLayoutRoot as SetLayoutRootFn & { [FULLSCREEN_MARGIN_OWNER]?: unknown };
      if (typeof current !== "function") { reason = "setLayoutRoot unavailable"; return false; }
      if (current[FULLSCREEN_MARGIN_OWNER]) {
        wrappedProto ??= proto;
        ensureRootWrapped(tui as TuiLike);
        reason = "installed";
        return true;
      }
      const wrapped = function (this: TuiLike, component: unknown): void {
        if (component && !markedRoot(component)) component = wrapRoot(component);
        return current.call(this, component);
      } as SetLayoutRootFn & { [FULLSCREEN_MARGIN_OWNER]?: unknown };
      Object.defineProperty(wrapped, FULLSCREEN_MARGIN_OWNER, { value: true });
      Object.defineProperty(proto, "setLayoutRoot", { value: wrapped, writable: true, configurable: true });
      wrappedProto = proto;
      original = current;
      ensureRootWrapped(tui as TuiLike);
      reason = "installed";
      return true;
    },

    dispose(): void {
      const tui = liveTui;
      try {
        const root = tui?.layoutRoot;
        const real = markedRoot(root);
        if (tui && real && original) original.call(tui, real);
      } catch { /* teardown ordering is the host's */ }
      if (wrappedProto && original) {
        const current = wrappedProto.setLayoutRoot as { [FULLSCREEN_MARGIN_OWNER]?: unknown } | undefined;
        if (current && current[FULLSCREEN_MARGIN_OWNER]) {
          Object.defineProperty(wrappedProto, "setLayoutRoot", { value: original, writable: true, configurable: true });
        }
      }
      wrappedProto = undefined;
      original = undefined;
      liveTui = undefined;
      reason = "not installed";
    },

    status(): { installed: boolean; reason: string } {
      return { installed: wrappedProto !== undefined, reason };
    },
  };
}
