// Thinking view state (display-only): which shape one reasoning run renders in,
// where its peek window sits, and how a click moves between the shapes.
//
//  collapsed  the host's own hidden label (our duration summary inside it)
//  peek       the newest `peekLines` rendered rows, wheel-scrollable
//  full       the whole rendered body
//
// Click gestures are ONE rule set for streaming and completed runs:
//  single click  collapsed ↔ peek, full → collapsed
//  double click  peek ↔ full, collapsed → full
//
// The single action is DELAYED by DOUBLE_CLICK_MS for one reason: the host
// recognizes a double click by COMPONENT IDENTITY, and every rebuild makes a
// new wrapper (streaming rebuilds on every chunk). Acting on the first click
// would both reset that identity and shrink the block before the second click
// lands. Holding the single action keeps the geometry and the gesture intact;
// the pending click is cancelled by the second click (double), by dispose, and
// by a session reset (no timers outlive their transcript).

export type ThinkingView = "collapsed" | "peek" | "full";

/** A lone click waits this long for a possible second one (Pi's own
 * double-click window is 500ms; 300ms keeps single clicks responsive). */
export const DOUBLE_CLICK_MS = 300;

export function singleClickTarget(from: ThinkingView): ThinkingView {
  return from === "collapsed" ? "peek" : "collapsed";
}

export function doubleClickTarget(from: ThinkingView): ThinkingView {
  return from === "full" ? "peek" : "full";
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
 * both ways out (wheel / double click); never claims a count it cannot see. */
export function peekHintText(above: number, below: number, total: number): string {
  const hidden: string[] = [];
  if (above > 0) hidden.push(`${above} above`);
  if (below > 0) hidden.push(`${below} below`);
  const clipped = hidden.length > 0 ? `${hidden.join(", ")} of ${total}` : `${total}`;
  return `… ${clipped} lines (scroll · double-click for all)`;
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
  /** One left click. A lone click applies singleClickTarget() after
   * DOUBLE_CLICK_MS; a second click within the window applies
   * doubleClickTarget() immediately. `apply` is called on the next frame the
   * gesture needs a rebuild for. */
  handleClick(
    click: { at: number; x: number; y: number },
    context: { fallback: ThinkingView; apply: (next: ThinkingView) => void },
  ): void;
  /** Drop a pending single click (dispose, session reset). */
  cancel(): void;
  readonly scroll: PeekScroll;
}

export function createThinkingViewControl(): ThinkingViewControl {
  const scroll = new PeekScroll();
  let userView: ThinkingView | undefined;
  let folded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { at: number; x: number; y: number; from: ThinkingView } | undefined;

  const clearPending = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  const applyView = (next: ThinkingView, apply: (next: ThinkingView) => void): void => {
    if (userView === next) return;
    userView = next;
    apply(next);
  };

  return {
    userView: () => userView,
    foldOnEnd: () => {
      if (folded) return;
      folded = true;
      userView = undefined;
    },
    handleClick: (click, context) => {
      const previous = pending;
      if (previous) {
        const doubled = click.at - previous.at <= DOUBLE_CLICK_MS
          && Math.abs(click.x - previous.x) <= 1
          && Math.abs(click.y - previous.y) <= 1;
        clearPending();
        if (doubled) {
          applyView(doubleClickTarget(previous.from), context.apply);
          return;
        }
        // Two independent clicks: land the first one NOW — through this
        // render's apply, which belongs to the same run's live component —
        // so no click is ever dropped just because the next one arrived.
        applyView(singleClickTarget(previous.from), context.apply);
      }
      const from = userView ?? context.fallback;
      pending = { at: click.at, x: click.x, y: click.y, from };
      timer = setTimeout(() => {
        const held = pending;
        pending = undefined;
        timer = undefined;
        if (held) applyView(singleClickTarget(held.from), context.apply);
      }, DOUBLE_CLICK_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    cancel: clearPending,
    get scroll() {
      return scroll;
    },
  };
}
