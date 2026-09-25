// One layout-root interception owns gutters and the bounded history window.
// Geometry and history caching remain independent; neither installs another hook.
import { createHistoryWindowSystem, type HistoryWindowHost, type HistoryWindowTui } from "./history-window.ts";

export const FULLSCREEN_MARGIN_OWNER = Symbol.for("Rycen7822.metis-pi.fullscreen-margin");

interface TuiLike extends HistoryWindowTui {
  mode?: unknown;
  layoutRoot?: unknown;
  setLayoutRoot?: (component: unknown) => void;
}
type Setter = (this: TuiLike, component: unknown) => void;
export interface FullscreenLayoutHost extends HistoryWindowHost {
  HStack?: unknown;
  Spacer?: unknown;
}
export interface FullscreenLayoutOptions { margin: number; minWidth: number; }
export type FullscreenLayoutSystem = ReturnType<typeof createFullscreenLayout>;

const innerRoot = (root: unknown): unknown => root && typeof root === "object"
  ? (root as Record<symbol, unknown>)[FULLSCREEN_MARGIN_OWNER] : undefined;

export function createFullscreenLayout(host: FullscreenLayoutHost, options: FullscreenLayoutOptions) {
  const history = createHistoryWindowSystem(host);
  const marginReady = options.margin > 0 && typeof host.HStack === "function" && typeof host.Spacer === "function";
  const historyReady = typeof host.Container === "function" && typeof host.ScrollView === "function";
  let reason = "not installed";
  let lease: { proto: object; descriptor?: PropertyDescriptor; wrapper: Setter; tui: TuiLike } | undefined;

  const wrapRoot = (root: unknown): object => {
    const HStack = host.HStack as new (children: unknown[], options: Record<string, unknown>) => object;
    const Spacer = host.Spacer as new (lines: number) => { setLines(lines: number): void };
    const effectiveMinWidth = Math.max(options.minWidth, options.margin * 2 + 20);
    const side = () => {
      const spacer = new Spacer(1);
      return {
        component: spacer, basis: options.margin, grow: 0, shrink: 0, minSize: 0,
        visible(viewport: { width?: unknown; height?: unknown }): boolean {
          // Paint every gutter row so auto-scrollbar composition cannot carry a
          // content background into blank cells. Visibility follows each frame.
          spacer.setLines(typeof viewport?.height === "number" ? viewport.height : 1);
          return typeof viewport?.width === "number" ? viewport.width >= effectiveMinWidth : true;
        },
      };
    };
    const wrapper = new HStack([side(), { component: root, basis: 0, grow: 1, shrink: 1, minSize: 1 }, side()], { align: "stretch" });
    // Native layout offsets mouse, selection, cursor and scrollbar together.
    Object.defineProperty(wrapper, FULLSCREEN_MARGIN_OWNER, { value: root, configurable: true });
    return wrapper;
  };

  function dispose(): void {
    const previous = lease;
    lease = undefined; // Captured hooks become inert BEFORE any teardown calls.
    reason = "not installed";
    try {
      history.dispose();
    } finally {
      if (previous) {
        if (Reflect.get(previous.proto, "setLayoutRoot") === previous.wrapper) {
          if (previous.descriptor) Object.defineProperty(previous.proto, "setLayoutRoot", previous.descriptor);
          else Reflect.deleteProperty(previous.proto, "setLayoutRoot");
        }
        const root = innerRoot(previous.tui.layoutRoot);
        if (root) {
          // Honor a later extension's setter; our buried hook is now pass-through.
          try { previous.tui.setLayoutRoot?.(root); } catch { /* host may already be shutting down */ }
        }
      }
    }
  }

  return {
    installOnTui(tui: unknown): boolean {
      if (!tui || typeof tui !== "object") { reason = "invalid tui"; return false; }
      const target = tui as TuiLike;
      if (target.mode !== "fullscreen") { reason = "renderer is not fullscreen"; return false; }
      if (!marginReady && !historyReady) { reason = "host bindings unavailable"; return false; }
      const proto = Object.getPrototypeOf(target);
      if (lease && lease.proto !== proto) dispose();
      if (!lease) {
        const original: unknown = proto?.setLayoutRoot;
        if (typeof original !== "function") { reason = "setLayoutRoot unavailable"; return false; }
        const descriptor = Object.getOwnPropertyDescriptor(proto, "setLayoutRoot");
        const wrapper: Setter = function (component) {
          // Use the lease identity, not a shared boolean: reinstalling cannot
          // reactivate an older hook captured by a third-party wrapper.
          if (lease?.wrapper !== wrapper || this.mode !== "fullscreen") return original.call(this, component);
          lease.tui = this; // The host can expose a Proxy facade during capture.
          const root = innerRoot(component) ?? component;
          history.mount(this, root);
          if (!marginReady || !root) return original.call(this, root);
          return original.call(this, innerRoot(component) ? component : wrapRoot(root));
        };
        try { Object.defineProperty(proto, "setLayoutRoot", { value: wrapper, writable: true, configurable: true }); }
        catch { reason = "setLayoutRoot is not writable"; return false; }
        lease = { proto, descriptor, wrapper, tui: target };
      }
      // Retry capture/mount without stacking another hook, even if a later
      // extension has wrapped ours. Existing roots also receive both features.
      if (marginReady && target.layoutRoot && !innerRoot(target.layoutRoot)) target.setLayoutRoot?.(target.layoutRoot);
      else history.mount(target, innerRoot(target.layoutRoot) ?? target.layoutRoot);
      reason = "installed";
      return true;
    },
    dispose,
    status() {
      return {
        installed: !!lease, reason,
        margin: { installed: !!lease && marginReady, reason: options.margin <= 0 ? "disabled(config)" : marginReady ? reason : "host bindings unavailable" },
        history: history.status(),
      };
    },
  };
}
