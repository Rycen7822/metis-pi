// Click-to-toggle for the host's folded `[skill] …` entries.
//
// The skill entry is a HOST component: interactive-mode parses a user message
// with parseSkillBlock and renders `SkillInvocationMessageComponent` (a Box
// with `expanded` + `setExpanded`, collapsed to one line by default). No
// extension API reaches it, so this module patches the class prototype —
// legitimate here because pi's extension loader aliases
// `@earendil-works/pi-coding-agent` onto the host's own module instance
// (verified live: wrapped updateDisplay fired for every entry the host built),
// so the patched class IS the one the session instantiates. In our compact
// transcript the click arrives through HistoryWindow.handleMouse, which maps a
// row back to the component that rendered it and forwards the event.
//
// Mouse dispatch makes the rest work without any further coupling: the alt
// screen hit-tests the component tree (Container/Box forward to children by
// their rendered height), so a click on the entry's row reaches this handler;
// Box's own handleMouse only forwards to the Text/Markdown children, which
// never claim anything, so overriding it changes no other behavior.
//
// Gesture contract (see pi-tui `tui-alt-screen.js`): a `click` is only ever
// dispatched to the component that claimed the matching `press`, so a plain
// left press is claimed (`{ handled: true }`) and the toggle happens on the
// synthesized click — a swallowed release (some terminals eat right releases)
// can therefore never toggle by accident. Clicks with a modifier key are left
// to the host's selection logic, and `click`/`press` default to `render: true`
// in the dispatcher, so toggling needs no TUI handle: `invalidate()` drops the
// Box's cached lines and the host repaints.

/** The slice of the host component this patch relies on. */
export interface SkillFoldComponent {
  expanded: boolean;
  setExpanded(expanded: boolean): void;
  invalidate?(): void;
}

/** The slice of a pi-tui mouse event this patch inspects. */
export interface SkillFoldMouseEvent {
  type?: string;
  button?: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

export type SkillFoldMouseResult = { handled: true } | undefined;

type MouseHandler = (this: SkillFoldComponent, event?: SkillFoldMouseEvent) => SkillFoldMouseResult;

/** What happened when the click handler was installed. */
export type SkillFoldInstall = "patched" | "already" | "missing";

/** Prototypes already carrying the handler (re-install must be a no-op). */
const patched = new WeakSet<object>();

/** True when the event should toggle rather than select text. */
const isToggleGesture = (event?: SkillFoldMouseEvent): boolean =>
  event?.button === "left" && event.shift !== true && event.ctrl !== true && event.alt !== true;

/**
 * Patch a component class (not an instance) so a left click on it flips
 * `expanded`. Uses the class the host actually instantiates; returns `missing`
 * for anything without a prototype so a host refactor degrades to "no click
 * toggle" instead of throwing.
 */
export function installSkillFoldClick(component: unknown): SkillFoldInstall {
  const prototype = (component as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (!prototype || typeof prototype !== "object") return "missing";
  if (patched.has(prototype)) return "already";

  const original = prototype.handleMouse as MouseHandler | undefined;
  prototype.handleMouse = function handleMouse(
    this: SkillFoldComponent,
    event?: SkillFoldMouseEvent,
  ): SkillFoldMouseResult {
    if (event?.type === "press" && isToggleGesture(event)) {
      // Claim the press so pi-tui remembers this component as the gesture
      // target and synthesizes `click` on release.
      return { handled: true };
    }
    if (event?.type === "click" && isToggleGesture(event)) {
      this.setExpanded(!this.expanded);
      // setExpanded swaps the children; invalidate drops the cached render.
      this.invalidate?.();
      return { handled: true };
    }
    // Everything else (right/middle press, wheel, move, modified clicks) keeps
    // Box's own child forwarding — the behavior this class had before.
    return original ? original.call(this, event) : undefined;
  };

  patched.add(prototype);
  return "patched";
}
