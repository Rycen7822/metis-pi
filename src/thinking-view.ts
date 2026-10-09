// Thinking view state (display-only): which shape one reasoning run renders in,
// where its peek window sits, and how a click moves between the shapes.
//
//  collapsed  the host's own hidden label (our duration summary inside it)
//  peek       the newest `peekLines` rendered rows, wheel-scrollable
//  full       the whole rendered body
//
// Immediate gestures are identical for streaming and completed runs:
//  left click   collapsed ↔ peek; full stays full
//  right click  collapsed/peek → full; full → collapsed

export type ThinkingView = "collapsed" | "peek" | "full";

export function thinkingClickTarget(from: ThinkingView, button: "left" | "right"): ThinkingView {
  if (button === "right") return from === "full" ? "collapsed" : "full";
  return from === "full" ? "full" : from === "collapsed" ? "peek" : "collapsed";
}

/** Visible window of one run's body: `top` is the first rendered row, `above`
 * and `below` count the clipped rows. */
export interface PeekWindow {
  readonly top: number;
  readonly above: number;
  readonly below: number;
}

/** Scroll position of a peek window. Following keeps the NEWEST rows in view;
 * after a wheel-up the window is pinned to its absolute top, so rows streamed
 * in below never move the text being read. */
export class PeekScroll {
  #following = true;
  #top = 0;
  #rendered: PeekWindow = { top: 0, above: 0, below: 0 };

  /** Resolve the window for a render of `total` rows. */
  resolve(total: number, windowLines: number): PeekWindow {
    const window = Math.max(1, Math.trunc(windowLines));
    const max = Math.max(0, total - window);
    const top = this.#following ? max : Math.min(Math.max(0, this.#top), max);
    this.#following = top >= max;
    if (!this.#following) this.#top = top;
    this.#rendered = { top, above: top, below: max - top };
    return this.#rendered;
  }

  /** Wheel delta (host sign: positive scrolls toward newer rows). True when the
   * window moved — false lets the transcript scroll instead. */
  scrollBy(delta: number): boolean {
    if (!Number.isFinite(delta) || delta === 0) return false;
    const current = this.#rendered;
    const max = current.above + current.below;
    const next = Math.min(Math.max(0, current.top + Math.trunc(delta)), max);
    if (next === current.top) return false;
    this.#following = next >= max;
    this.#top = next;
    this.#rendered = { top: next, above: next, below: max - next };
    return true;
  }

  /** Newest rows again (fresh run, or after the block was collapsed). */
  reset(): void {
    this.#following = true;
    this.#top = 0;
    this.#rendered = { top: 0, above: 0, below: 0 };
  }

  get following(): boolean {
    return this.#following;
  }
}

/** One-line affordance above a clipped window. Always says what is hidden and
 * both ways out (wheel / right click); never claims a count it cannot see. */
export function peekHintText(above: number, below: number, total: number): string {
  const hidden: string[] = [];
  if (above > 0) hidden.push(`${above} above`);
  if (below > 0) hidden.push(`${below} below`);
  const clipped = hidden.length > 0 ? `${hidden.join(", ")} of ${total}` : `${total}`;
  return `… ${clipped} lines (scroll · right-click for all)`;
}

/** Display state of one reasoning run, shared across host rebuilds.
 *
 * Only a CLICK is stored. Everything else is derived per render from the run's
 * `ended` clock plus the configured policy, which is what keeps a long stream
 * honest: a stored policy default would go stale the moment the host re-shows
 * the run (a fresh component, Ctrl+T, a rebuild), and a stale "folded" record
 * would then unfold the whole body under the peek-mode policy. */
export interface ThinkingViewControl {
  /** The shape the user clicked for this run (undefined = never clicked). */
  userView(): ThinkingView | undefined;
  /** Auto-fold for the end of a run: forget a shape the user opened WHILE it
   * streamed, so the policy default (folded) applies again. Runs ONCE per run —
   * the host rebuilds the subtree many times, and a fold that re-ran on every
   * rebuild would erase a click the user made after the run finished. */
  foldOnEnd(): void;
  /** Apply a button to the visible shape immediately. `fallback` is the
   * current render, which may differ from userView after a host global toggle. */
  handleClick(
    button: "left" | "right",
    context: { fallback: ThinkingView; apply: (next: ThinkingView) => void },
  ): void;
  readonly scroll: PeekScroll;
}

export function createThinkingViewControl(): ThinkingViewControl {
  let userView: ThinkingView | undefined;
  let folded = false;
  return {
    scroll: new PeekScroll(),
    userView: () => userView,
    foldOnEnd: () => {
      if (folded) return;
      folded = true;
      userView = undefined;
    },
    handleClick: (button, context) => {
      const next = thinkingClickTarget(context.fallback, button);
      if (next === context.fallback) return;
      userView = next;
      context.apply(next);
    },
  };
}
