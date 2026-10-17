import { productFor, publishRows, registerProduct, releaseCopyCache, type CopyProduct, type ChildPlacement } from "../selection-copy/model.ts";
import { safeText } from "../tool-names.ts";

export const HISTORY_ROW_BUDGET = 5000;
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

interface Component {
  render(width: number): string[];
  invalidate?(): void;
  handleMouse?(event: Record<string, any>): unknown;
  children?: Component[];
  child?: Component;
  selfRenderContainer?: Component;
}
interface Scroll extends Component {
  primary: boolean;
  child: Component;
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
  isFollowingEnd: boolean;
  scrollBy(lines: number): number;
  scrollTo(row: number, options?: { disableFollow?: boolean }): void;
  updateLayout(contentHeight: number, viewportHeight: number, requestRender?: () => void): void;
}
export interface HistoryWindowTui {
  hasActiveSelection?(): boolean;
  getSelectionBounds?(): unknown;
  clearTextSelection?(): void;
  addInputListener?(listener: (data: string) => void): () => void;
  requestRender?(): void;
}
export interface HistoryWindowHost {
  Container?: unknown;
  ScrollView?: unknown;
  VStack?: unknown;
  matchesKey?: (data: string, key: "enter") => boolean;
  UserMessageComponent?: unknown;
  SkillInvocationMessageComponent?: unknown;
  promptRow?: (summary: string, width: number) => string;
  promptTheme?: () => { fg(key: string, text: string): string; bg(key: string, text: string): string } | undefined;
}
type Cursor = { component: Component; row: number };
type RowOrigin = Cursor & { height: number; index: number };
type CachedBlock = { rows?: string[]; unwatch: () => void };
type WindowPiece = { component: Component; rows: string[]; index: number; start: number; end: number };

/** Copy only retained product rows. Referencing an unsliced parent product
 * would retain all of a giant boundary block's provenance after eviction. */
function sliceProduct(product: CopyProduct, start: number, end: number): CopyProduct {
  return {
    ...product,
    rows: product.rows.slice(start, end),
    children: product.children?.slice(start, end).map((placement) => placement && ({
      colShift: placement.colShift, rowIndex: 0,
      product: sliceProduct(placement.product, placement.rowIndex, placement.rowIndex + 1),
    })),
  };
}

function descendants(root: Component): Component[] {
  const result: Component[] = [];
  const seen = new Set<Component>();
  const visit = (node: Component) => {
    if (!node || seen.has(node)) return;
    seen.add(node); result.push(node);
    for (const child of node.children ?? []) visit(child);
    if (node.child) visit(node.child);
    if (node.selfRenderContainer) visit(node.selfRenderContainer);
  };
  visit(root);
  return result;
}

function releaseBlock(root: Component): void {
  for (const node of descendants(root)) {
    // Leaf invalidate releases native Text/Markdown and our shell/diff caches.
    // Do not rebuild parent tool trees: their mouse geometry still describes
    // the currently committed frame, including a retained boundary fragment.
    if (!node.children?.length && !node.child && !node.selfRenderContainer) node.invalidate?.();
    releaseCopyCache(node);
  }
}

function observe(component: object, methods: readonly string[], changed: () => void): () => void {
  const restores: (() => void)[] = [];
  for (const name of methods) {
    const original: unknown = Reflect.get(component, name);
    if (typeof original !== "function" || !Object.isExtensible(component)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(component, name);
    if (descriptor && (!descriptor.configurable || descriptor.writable === false)) continue;
    const wrapped = function (this: object, ...args: unknown[]) {
      try { return original.apply(this, args); } finally { changed(); }
    };
    Object.defineProperty(component, name, { value: wrapped, writable: true, configurable: true });
    restores.push(() => {
      if (Reflect.get(component, name) !== wrapped) return;
      if (descriptor) Object.defineProperty(component, name, descriptor);
      else Reflect.deleteProperty(component, name);
    });
  }
  return () => restores.forEach((restore) => restore());
}

/** A bounded display window, not a second session store. Source components
 * remain owned by Pi; only derived rows and mirrors are evicted. */
export class HistoryWindow {
  #blocks = new Map<Component, CachedBlock>();
  #structureRestores: (() => void)[] = [];
  #structureChecks: (() => boolean)[] = [];
  #items: Component[] = [];
  #structureDirty = true;
  #dirty = true;
  #width = -1;
  #rows: string[] = [];
  #origins: (RowOrigin | undefined)[] = [];
  #prompts: { component: Component; index: number }[] = [];
  #promptRows: string[] = [""];
  #promptWidth = 1;
  #pinned: Component | undefined;
  #pressedPrompt: { component: Component; dragged: boolean; x: number; y: number } | undefined;
  #promptPreview: { component: Component; width: number; summary: string } | undefined;
  #cursor: Cursor | undefined;
  #scrollTarget: number | undefined;
  #jumpQueued = false;
  #direction: "backward" | "forward" = "backward";
  #older = false;
  #newer = false;
  #renderedBlocks = 0;
  #evictedBlocks = 0;
  readonly source: Component;
  readonly scroll: Scroll;
  readonly container: unknown;
  readonly holdSelection: () => boolean;
  readonly promptHost: HistoryWindowHost | undefined;
  readonly promptHeader: Component = {
    render: width => {
      this.#promptWidth = width;
      this.#promptRows = [this.#pinned && this.#promptPreview ? this.#paintPrompt(this.#promptPreview.summary) : ""];
      return this.#promptRows;
    },
    invalidate: () => { this.#promptPreview = undefined; },
    handleMouse: event => this.#handlePromptMouse(event),
  };
  constructor(source: Component, scroll: Scroll, container: unknown, holdSelection: () => boolean = () => false, promptHost?: HistoryWindowHost) {
    this.source = source; this.scroll = scroll; this.container = container;
    this.holdSelection = holdSelection;
    this.promptHost = promptHost?.promptRow && typeof promptHost.UserMessageComponent === "function" ? promptHost : undefined;
    releaseBlock(source);
  }

  #refreshItems(): void {
    if (this.#structureChecks.some((unchanged) => !unchanged())) {
      this.#structureDirty = true;
      this.#dirty = true;
    }
    if (!this.#structureDirty) return;
    this.#structureRestores.forEach((restore) => restore());
    this.#structureRestores = [];
    this.#structureChecks = [];
    this.#items = [];
    this.#prompts = [];
    const promptTypes = [this.promptHost?.UserMessageComponent, this.promptHost?.SkillInvocationMessageComponent]
      .filter(Type => typeof Type === "function");
    const walk = (node: Component) => {
      if (node.constructor !== this.container) {
        if (promptTypes.some(Type => node instanceof Type)) this.#prompts.push({ component: node, index: this.#items.length });
        this.#items.push(node);
        return;
      }
      this.#structureRestores.push(
        observe(node, ["addChild", "removeChild", "clear", "invalidate"], () => {
          this.#structureDirty = true;
          this.#dirty = true;
        }),
      );
      const children = node.children,
        length = children?.length,
        head = children?.[0],
        tail = children?.at(-1);
      // Pi replaces its header by array-index assignment. Check container
      // boundaries and array identity without scanning every history entry.
      this.#structureChecks.push(
        () =>
          node.children === children &&
          children?.length === length &&
          children?.[0] === head &&
          children?.at(-1) === tail,
      );
      if (node.children)
        this.#structureRestores.push(
          observe(node.children, ["push", "pop", "shift", "unshift", "splice", "sort", "reverse"], () => {
            this.#structureDirty = true;
            this.#dirty = true;
          }),
        );
      for (const child of node.children ?? []) walk(child);
    };
    walk(this.source);
    this.#structureDirty = false;
    const present = new Set(this.#items);
    if (this.#cursor && !present.has(this.#cursor.component)) {
      this.#cursor = undefined; this.#direction = "backward"; this.#scrollTarget = undefined;
    }
    if (this.#promptPreview && !present.has(this.#promptPreview.component)) this.#promptPreview = undefined;
    for (const component of this.#blocks.keys()) if (!present.has(component)) this.#evict(component);
  }

  #evict(component: Component): void {
    const block = this.#blocks.get(component);
    if (!block) return;
    this.#blocks.delete(component);
    block.unwatch();
    releaseBlock(component);
    this.#evictedBlocks++;
  }

  #block(component: Component, width: number): string[] {
    const cached = this.#blocks.get(component);
    if (cached?.rows) return cached.rows;
    cached?.unwatch();
    const rows = component.render(width);
    this.#renderedBlocks++;
    this.#watch(component).rows = rows;
    return rows;
  }

  #watch(component: Component): CachedBlock {
    const block: CachedBlock = { unwatch: () => {} };
    const restores = descendants(component).map((node) => observe(node,
      ["invalidate", "updateContent", "updateDisplay", "setText", "addChild", "removeChild", "clear"], () => {
        block.rows = undefined; this.#dirty = true;
        if (this.#promptPreview?.component === component) this.#promptPreview = undefined;
      }));
    block.unwatch = () => restores.forEach((restore) => restore());
    this.#blocks.set(component, block);
    return block;
  }

  render(width: number): string[] {
    this.#jumpQueued = false;
    // Keep a selected committed window stable while new output arrives. A
    // resize is handled by Pi's normal selection reset and must still reflow.
    if (width === this.#width && this.#rows.length && this.holdSelection()) return this.#rows;
    if (width !== this.#width) {
      for (const component of this.#blocks.keys()) this.#evict(component);
      this.#width = width; this.#dirty = true;
    }
    this.#refreshItems();
    if (!this.#dirty) return this.#rows;
    if (!this.#newer && this.scroll.isFollowingEnd) {
      this.#cursor = undefined; this.#direction = "backward";
    } else if (!this.#cursor && !this.scroll.isFollowingEnd) {
      // While reading, keep this window's boundary stable. Appended output
      // belongs to the next page and must not evict the viewport's first row.
      const tail = this.#origins.at(this.#newer ? -2 : -1);
      if (tail && this.#items.includes(tail.component)) this.#cursor = { component: tail.component, row: tail.row + 1 };
    }
    const anchor = this.#scrollTarget === undefined && !this.scroll.isFollowingEnd ? this.#origins[this.scroll.scrollTop] : undefined;
    const items = this.#items;
    let index = this.#cursor ? items.indexOf(this.#cursor.component) : items.length - 1;
    const forward = this.#cursor !== undefined && this.#direction === "forward";
    const pieces: WindowPiece[] = [];
    // Reserve both paging notices inside the hard limit, not outside it.
    let remaining = HISTORY_ROW_BUDGET - 2;
    let first = true;
    while (index >= 0 && index < items.length && remaining > 0) {
      const component = items[index]!;
      const rows = this.#block(component, width);
      const edge = first && this.#cursor ? Math.min(this.#cursor.row, rows.length) : forward ? 0 : rows.length;
      const start = forward ? edge : Math.max(0, edge - remaining);
      const end = forward ? Math.min(rows.length, edge + remaining) : edge;
      pieces.push({ component, rows, index, start, end });
      remaining -= end - start;
      first = false; index += forward ? 1 : -1;
    }
    if (!forward) pieces.reverse();
    const head = pieces[0], tail = pieces.at(-1);
    this.#older = !!head && (head.index > 0 || head.start > 0);
    this.#newer = !!tail && (tail.index < items.length - 1 || tail.end < tail.rows.length);
    const rows: string[] = [];
    const placements: (ChildPlacement | undefined)[] = [];
    this.#origins = [];
    const notice = (text: string) => { rows.push(text.slice(0, Math.max(1, width))); placements.push(undefined); this.#origins.push(undefined); };
    if (this.#older) notice("[Earlier history: scroll up to load | 5000-row window]");
    for (const piece of pieces) {
      const whole = piece.start === 0 && piece.end === piece.rows.length;
      const sourceProduct = productFor(piece.rows);
      const product = sourceProduct && (whole ? sourceProduct : sliceProduct(sourceProduct, piece.start, piece.end));
      for (let row = piece.start; row < piece.end; row++) {
        rows.push(piece.rows[row]!);
        this.#origins.push({ component: piece.component, row, height: piece.rows.length, index: piece.index });
        placements.push(product ? { product, rowIndex: row - piece.start, colShift: 0 } : undefined);
      }
    }
    if (this.#newer) notice("[Later history: scroll down to load | 5000-row window]");
    const retained = new Set(pieces.filter((piece) => piece.start === 0 && piece.end === piece.rows.length).map((piece) => piece.component));
    const visible = new Set(pieces.map((piece) => piece.component));
    for (const component of [...this.#blocks.keys()]) {
      if (!retained.has(component)) {
        // Detach observers before leaf invalidation, then watch visible slices.
        this.#evict(component);
        if (visible.has(component) || component === this.#pinned) this.#watch(component);
      }
    }
    this.#rows = rows; this.#dirty = false;
    if (anchor) {
      const next = this.#origins.findIndex((origin) => origin?.component === anchor.component && origin.row === anchor.row);
      if (next >= 0) this.#scrollTarget = next;
    }
    registerProduct(rows, { width, rows: [], children: placements });
    publishRows(this, rows);
    return rows;
  }

  commitScroll(): void {
    if (this.#dirty) return;
    if (this.#scrollTarget !== undefined) {
      const target = this.#scrollTarget;
      this.#scrollTarget = undefined;
      // Native layout has measured this window and the viewport, but has not
      // positioned its child yet. Clamp against NEW sizes, not the old page.
      this.scroll.scrollTo(target, { disableFollow: true });
    }
    this.#commitPrompt();
  }

  #commitPrompt(): void {
    if (!this.promptHost || this.holdSelection()) return;
    this.#promptRows[0] = "";
    const top = this.scroll.scrollTop;
    const origin = this.#origins.slice(top, top + this.scroll.viewportHeight).find(item => item !== undefined);
    // The last prompt at/before the first visible block owns this viewport.
    const index = origin?.index ?? -1;
    let low = 0, high = this.#prompts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#prompts[mid]!.index <= index) low = mid + 1;
      else high = mid;
    }
    const candidate = this.#prompts[low - 1]?.component;
    const target = candidate !== origin?.component ? candidate : undefined;
    if (this.#promptPreview?.component !== target) this.#promptPreview = undefined;
    if (this.#pinned && this.#pinned !== target && !this.#blocks.get(this.#pinned)?.rows) this.#evict(this.#pinned);
    this.#pinned = target;
    if (!target) return; // Original is still (partly) visible.
    if (!this.#promptPreview || this.#promptPreview.width !== this.#width) {
      // Reuse the native visible rendering, including Markdown transformers.
      // An off-window prompt may render once; never retain its full row cache.
      const cached = this.#blocks.get(target)?.rows;
      let summary = "";
      try {
        for (const row of cached ?? target.render(this.#width)) {
          const text = safeText(row).trim();
          if (text) summary += `${summary ? " " : ""}${text}`;
          if (summary.length > this.#width * 3) break;
        }
      } catch { /* An optional preview must not break an otherwise usable transcript. */ }
      finally {
        if (!cached) {
          if (this.#blocks.has(target)) this.#evict(target);
          else releaseBlock(target);
        }
      }
      this.#promptPreview = { component: target, width: this.#width, summary: summary || "[User input]" };
    }
    // Retain invalidation observers, never full rows, for an evicted pinned prompt.
    if (!this.#blocks.has(target)) this.#watch(target);
    // The fixed sibling has rendered but the native frame has not painted yet.
    // Update only THIS frame's row array, never scroll content or an old frame.
    this.#promptRows[0] = this.#paintPrompt(this.#promptPreview.summary);
  }

  #paintPrompt(summary: string): string {
    // Truncation adds ANSI resets around the ellipsis; theme only plain text.
    const row = safeText(this.promptHost!.promptRow!(summary, this.#promptWidth));
    try {
      const theme = this.promptHost!.promptTheme?.();
      return theme ? theme.bg("userMessageBg", theme.fg("userMessageText", row)) : row;
    } catch { return row; }
  }

  #handlePromptMouse(event: Record<string, any>): unknown {
    if (!["press", "release", "drag", "click"].includes(event.type)) return;
    const plainLeft = event.button === "left" && !event.shift && !event.alt && !event.ctrl;
    if (event.type === "press") {
      this.#pressedPrompt = plainLeft && this.#pinned
        ? { component: this.#pinned, dragged: false, x: event.screenX, y: event.screenY } : undefined;
      return this.#pressedPrompt ? { handled: true } : undefined;
    }
    const pressed = this.#pressedPrompt;
    if (!pressed) return;
    if (event.type === "drag") pressed.dragged = true;
    if (event.type === "click") {
      this.#pressedPrompt = undefined;
      if (plainLeft && !pressed.dragged) {
        this.#jumpToPrompt(pressed.component);
        return { handled: true, render: true };
      }
    }
    if (event.type === "release" && (pressed.dragged || event.screenX !== pressed.x || event.screenY !== pressed.y))
      this.#pressedPrompt = undefined;
    return { handled: true };
  }

  #jumpToPrompt(component: Component): void {
    this.#refreshItems();
    const index = this.#items.indexOf(component);
    if (index < 0) return;
    this.#cursor = { component, row: 0 };
    this.#direction = "forward";
    this.#scrollTarget = index > 0 ? 1 : 0; // Skip the Earlier history notice.
    this.#dirty = true;
    this.scroll.scrollTo(this.scroll.scrollTop, { disableFollow: true });
  }

  page(direction: "older" | "newer"): boolean {
    if (direction === "older" ? !this.#older : !this.#newer) return false;
    const body = this.#origins.filter((origin): origin is RowOrigin => !!origin);
    const overlap = Math.max(1, Math.min(this.scroll.viewportHeight, body.length - 1));
    const origin = direction === "older" ? body[overlap - 1] : body[body.length - overlap];
    if (!origin) return false;
    this.#cursor = { component: origin.component, row: origin.row + (direction === "older" ? 1 : 0) };
    this.#direction = direction === "older" ? "backward" : "forward";
    this.#dirty = true;
    this.#scrollTarget = direction === "older" ? Number.MAX_SAFE_INTEGER : 0;
    this.scroll.scrollTo(this.scroll.scrollTop, { disableFollow: true });
    return true;
  }

  get hasNewer(): boolean { return this.#newer; }

  jump(direction: "older" | "newer"): boolean {
    this.#refreshItems();
    const component = direction === "older" ? this.#items[0] : this.#items.at(-1);
    const row = direction === "older" ? 0 : Number.MAX_SAFE_INTEGER;
    const traversal = direction === "older" ? "forward" : "backward";
    const target = direction === "older" ? 0 : undefined;
    // Repeated pointer notifications before the next frame share one jump.
    // A changed endpoint or an intervening render/page rearms navigation.
    if (this.#jumpQueued && this.#cursor?.component === component && this.#cursor?.row === row
      && this.#direction === traversal && this.#scrollTarget === target) return false;
    this.#cursor = component ? { component, row } : undefined;
    this.#direction = traversal;
    this.#scrollTarget = target;
    this.#dirty = true;
    this.#jumpQueued = true;
    return true;
  }
  invalidate(): void {
    this.#promptPreview = undefined;
    for (const component of this.#blocks.keys()) this.#evict(component);
    // Host invalidation also rebuilds theme-dependent tool component inputs.
    // Forward it to the source tree even though it is not the layout child.
    this.source.invalidate?.();
    this.#dirty = true;
  }
  handleMouse(event: Record<string, any>): unknown {
    const origin = this.#origins[event.y];
    return origin?.component.handleMouse?.({ ...event, y: origin.row, height: origin.height });
  }
  status() {
    return {
      rows: this.#rows.length,
      cachedBlocks: [...this.#blocks.values()].filter((block) => block.rows).length,
      renderedBlocks: this.#renderedBlocks,
      evictedBlocks: this.#evictedBlocks,
      older: this.#older,
      newer: this.#newer,
      budget: HISTORY_ROW_BUDGET,
    };
  }
  dispose(): void {
    this.#jumpQueued = false;
    this.#scrollTarget = undefined;
    this.#structureRestores.forEach((restore) => restore());
    this.#structureRestores = [];
    this.invalidate();
    this.#rows = [];
    this.#origins = [];
    this.#items = [];
    this.#prompts = [];
    this.#promptRows = [""];
    this.#pinned = undefined;
    this.#pressedPrompt = undefined;
    this.#promptPreview = undefined;
    this.#structureChecks = [];
    releaseCopyCache(this);
  }
}

export function createHistoryWindowSystem(host: HistoryWindowHost) {
  let installed:
    | {
        tui: HistoryWindowTui;
        scroll: Scroll;
        source: Component;
        scrollbarFollow: { installed: boolean; reason: string };
        window: HistoryWindow;
        wheel: Scroll["scrollBy"];
        wrapper: Scroll["scrollBy"];
        restoreNavigation: () => void;
        removeInput?: () => void;
      }
    | undefined;
  let reason = "not installed";
  function unmount() {
    if (!installed) return;
    const { scroll, source, window, wheel, wrapper, restoreNavigation, removeInput } = installed;
    removeInput?.();
    restoreNavigation();
    if (scroll.child === (window as unknown)) {
      scroll.child = source;
      scroll.children = [source];
    }
    if (scroll.scrollBy === wrapper) scroll.scrollBy = wheel;
    window.dispose();
    installed = undefined;
    reason = "not installed";
  }
  function mount(tui: HistoryWindowTui, root: any) {
    if (!root || !host.Container || !host.ScrollView) {
      unmount();
      return;
    }
    const find = (node: any): Scroll | undefined => {
      if (!node) return;
      if (node instanceof (host.ScrollView as any) && node.primary) return node;
      const layout = node[LAYOUT_NODE]?.();
      for (const entry of layout?.entries ?? []) {
        const found = find(entry.component);
        if (found) return found;
      }
    };
    const scroll = find(root);
    if (!scroll) {
      unmount();
      reason = "primary ScrollView unavailable";
      return;
    }
    if (installed?.scroll === scroll && installed.tui === tui) return;
    unmount();
    const source = scroll.child;
    if (!(source instanceof (host.Container as any))) {
      reason = "unsupported transcript root";
      return;
    }
    const selected = () => (tui.getSelectionBounds ? !!tui.getSelectionBounds() : tui.hasActiveSelection?.() === true);
    const nativeNode = Reflect.get(scroll, LAYOUT_NODE);
    const promptDescriptor = Object.getOwnPropertyDescriptor(scroll, LAYOUT_NODE);
    const promptHost = typeof host.VStack === "function" && typeof nativeNode === "function"
      && Object.isExtensible(scroll) && promptDescriptor?.configurable !== false ? host : undefined;
    const window = new HistoryWindow(source, scroll, host.Container, selected, promptHost);
    let restorePrompt = () => {};
    if (window.promptHost) {
      // Keep the one-row chrome OUTSIDE scrollContentLines and copy provenance.
      // Its fixed slot avoids a visibility/viewport-height feedback loop.
      const descriptor = promptDescriptor;
      let active = true;
      const body = { render: (width: number) => scroll.render(width), invalidate: () => scroll.invalidate?.(),
        [LAYOUT_NODE]: () => nativeNode.call(scroll) };
      const Stack = host.VStack as new (children: unknown[]) => { [LAYOUT_NODE](): unknown };
      const stack = new Stack([
        { component: window.promptHeader, basis: 1, shrink: 0 },
        { component: body, basis: 0, grow: 1, shrink: 1, minSize: 0 },
      ]);
      const node = () => active ? stack[LAYOUT_NODE]() : nativeNode.call(scroll);
      Object.defineProperty(scroll, LAYOUT_NODE, { value: node, writable: true, configurable: true });
      restorePrompt = () => {
        active = false;
        if (Reflect.get(scroll, LAYOUT_NODE) === node) {
          if (descriptor) Object.defineProperty(scroll, LAYOUT_NODE, descriptor);
          else Reflect.deleteProperty(scroll, LAYOUT_NODE);
        }
      };
    }
    let navigationActive = true;
    const restoreStart = observe(scroll, ["scrollToStart"], () => {
      if (navigationActive && scroll.child === window && window.jump("older")) tui.requestRender?.();
    });
    const restoreEnd = observe(scroll, ["scrollToEnd"], () => {
      if (navigationActive && scroll.child === window && window.jump("newer")) tui.requestRender?.();
    });
    // Pi 1.3's private pointer helper supplies actual scrollbar provenance.
    // Generic scrollTo also serves prompt/search navigation and stays native.
    // An absent/locked helper disables only this optional enhancement.
    const pointerName = "scrollScrollbarToPointer";
    const scrollbarFollow = { installed: false, reason: "native scrollbar helper unavailable" };
    let restorePointer = () => {};
    try {
      const descriptor = Object.getOwnPropertyDescriptor(tui, pointerName);
      const pointer: unknown = Reflect.get(tui, pointerName);
      if (typeof pointer === "function") scrollbarFollow.reason = "native scrollbar helper not writable";
      if (typeof pointer === "function" && Object.isExtensible(tui)
        && (!descriptor || descriptor.configurable && descriptor.writable !== false)) {
        const pointerWrapper = function (this: object, ...args: unknown[]) {
          const result = pointer.apply(this, args);
          if (navigationActive && args[0] === scroll
            && scroll.child === window && !selected() && scroll.isFollowingEnd
            && scroll.scrollTop >= Math.max(0, scroll.contentHeight - scroll.viewportHeight)
            && window.hasNewer && window.jump("newer")) tui.requestRender?.();
          return result;
        };
        Object.defineProperty(tui, pointerName, { value: pointerWrapper, writable: true, configurable: true });
        scrollbarFollow.installed = true;
        scrollbarFollow.reason = "installed";
        restorePointer = () => {
          if (Reflect.get(tui, pointerName) !== pointerWrapper) return;
          if (descriptor) Object.defineProperty(tui, pointerName, descriptor);
          else Reflect.deleteProperty(tui, pointerName);
        };
      }
    } catch { scrollbarFollow.reason = "native scrollbar bridge unavailable"; }
    const layoutDescriptor = Object.getOwnPropertyDescriptor(scroll, "updateLayout");
    const updateLayout = scroll.updateLayout;
    const commitLayout: Scroll["updateLayout"] = function (this: Scroll, ...args) {
      updateLayout.apply(this, args);
      window.commitScroll();
    };
    scroll.updateLayout = commitLayout;
    const removeInput = tui.addInputListener?.((data) => {
      if (host.matchesKey?.(data, "enter") && selected()) {
        tui.clearTextSelection?.(); tui.requestRender?.();
      }
    });
    const wheel = scroll.scrollBy;
    const wrapper = function (this: Scroll, delta: number): number {
      if (!selected()) {
        if (delta < 0 && this.scrollTop === 0 && window.page("older")) { tui.requestRender?.(); return 0; }
        if (delta > 0 && this.scrollTop >= this.contentHeight - this.viewportHeight && window.page("newer")) { tui.requestRender?.(); return 0; }
      }
      return wheel.call(this, delta);
    };
    scroll.child = window as unknown as Component; scroll.children = [scroll.child]; scroll.scrollBy = wrapper;
    installed = { tui, scroll, source, window, scrollbarFollow, wheel, wrapper, restoreNavigation: () => {
      navigationActive = false;
      restorePointer(); restorePrompt(); restoreStart(); restoreEnd();
      if (scroll.updateLayout === commitLayout) {
        if (layoutDescriptor) Object.defineProperty(scroll, "updateLayout", layoutDescriptor);
        else Reflect.deleteProperty(scroll, "updateLayout");
      }
    }, removeInput }; reason = "installed";
  }
  return {
    mount,
    status() {
      return { installed: !!installed, reason, ...installed?.window.status(),
        scrollbarFollow: installed ? { ...installed.scrollbarFollow } : { installed: false, reason: "not installed" } };
    },
    dispose: unmount,
  };
}
