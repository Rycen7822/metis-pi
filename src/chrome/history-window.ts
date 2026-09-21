import { productFor, publishRows, registerProduct, releaseCopyCache, type CopyProduct, type ChildPlacement } from "../selection-copy/model.ts";

export const HISTORY_ROW_BUDGET = 5000;
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const OWNER = Symbol.for("Rycen7822.metis-pi.history-window");

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
}
interface Tui {
  mode?: string;
  layoutRoot?: Component;
  setLayoutRoot(root: unknown): void;
  hasActiveSelection?(): boolean;
  getSelectionBounds?(): unknown;
  clearTextSelection?(): void;
  addInputListener?(listener: (data: string) => void): () => void;
  requestRender?(): void;
}
export interface HistoryWindowHost { Container?: unknown; ScrollView?: unknown; matchesKey?: (data: string, key: "enter") => boolean; }
type Cursor = { component: Component; row: number };
type RowOrigin = Cursor & { height: number };
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
  #cursor: Cursor | undefined;
  #direction: "backward" | "forward" = "backward";
  #older = false;
  #newer = false;
  #renderedBlocks = 0;
  #evictedBlocks = 0;
  readonly source: Component;
  readonly scroll: Scroll;
  readonly container: unknown;
  readonly holdSelection: () => boolean;
  constructor(source: Component, scroll: Scroll, container: unknown, holdSelection: () => boolean = () => false) {
    this.source = source; this.scroll = scroll; this.container = container;
    this.holdSelection = holdSelection;
    releaseBlock(source);
  }

  #refreshItems(): void {
    if (this.#structureChecks.some((unchanged) => !unchanged())) { this.#structureDirty = true; this.#dirty = true; }
    if (!this.#structureDirty) return;
    this.#structureRestores.forEach((restore) => restore());
    this.#structureRestores = []; this.#structureChecks = [];
    this.#items = [];
    const walk = (node: Component) => {
      if (node.constructor !== this.container) { this.#items.push(node); return; }
      this.#structureRestores.push(observe(node, ["addChild", "removeChild", "clear", "invalidate"], () => {
        this.#structureDirty = true; this.#dirty = true;
      }));
      const children = node.children, length = children?.length, head = children?.[0], tail = children?.at(-1);
      // Pi replaces its header by array-index assignment. Check container
      // boundaries and array identity without scanning every history entry.
      this.#structureChecks.push(() => node.children === children && children?.length === length && children?.[0] === head && children?.at(-1) === tail);
      if (node.children) this.#structureRestores.push(observe(node.children,
        ["push", "pop", "shift", "unshift", "splice", "sort", "reverse"], () => {
          this.#structureDirty = true; this.#dirty = true;
        }));
      for (const child of node.children ?? []) walk(child);
    };
    walk(this.source);
    this.#structureDirty = false;
    const present = new Set(this.#items);
    if (this.#cursor && !present.has(this.#cursor.component)) {
      this.#cursor = undefined; this.#direction = "backward";
    }
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
      }));
    block.unwatch = () => restores.forEach((restore) => restore());
    this.#blocks.set(component, block);
    return block;
  }

  render(width: number): string[] {
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
    const anchor = !this.scroll.isFollowingEnd ? this.#origins[this.scroll.scrollTop] : undefined;
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
        this.#origins.push({ component: piece.component, row, height: piece.rows.length });
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
        if (visible.has(component)) this.#watch(component);
      }
    }
    this.#rows = rows; this.#dirty = false;
    if (anchor) {
      const next = this.#origins.findIndex((origin) => origin?.component === anchor.component && origin.row === anchor.row);
      if (next >= 0) this.scroll.scrollTo(next, { disableFollow: true });
    }
    registerProduct(rows, { componentId: "history-window", width, rows: [], children: placements });
    publishRows(this, rows);
    return rows;
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
    this.scroll.scrollTo(direction === "older" ? Number.MAX_SAFE_INTEGER : 0, { disableFollow: true });
    return true;
  }

  jump(direction: "older" | "newer"): void {
    this.#refreshItems();
    const component = direction === "older" ? this.#items[0] : this.#items.at(-1);
    this.#cursor = component ? { component, row: direction === "older" ? 0 : Number.MAX_SAFE_INTEGER } : undefined;
    this.#direction = direction === "older" ? "forward" : "backward";
    this.#dirty = true;
  }
  invalidate(): void {
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
  status() { return { rows: this.#rows.length, cachedBlocks: [...this.#blocks.values()].filter((block) => block.rows).length, renderedBlocks: this.#renderedBlocks,
    evictedBlocks: this.#evictedBlocks, older: this.#older, newer: this.#newer, budget: HISTORY_ROW_BUDGET }; }
  dispose(): void {
    this.#structureRestores.forEach((restore) => restore()); this.#structureRestores = [];
    this.invalidate(); this.#rows = []; this.#origins = []; this.#items = []; this.#structureChecks = []; releaseCopyCache(this);
  }
}

export function createHistoryWindowSystem(host: HistoryWindowHost) {
  let installed: { scroll: Scroll; source: Component; window: HistoryWindow; wheel: Scroll["scrollBy"]; wrapper: Scroll["scrollBy"]; restoreNavigation: () => void; removeInput?: () => void } | undefined;
  let proto: any, setter: any, wrappedSetter: any;
  let reason = "not installed";
  function unmount() {
    if (!installed) return;
    const { scroll, source, window, wheel, wrapper, restoreNavigation, removeInput } = installed;
    removeInput?.(); restoreNavigation();
    if (scroll.child === window as unknown) { scroll.child = source; scroll.children = [source]; }
    if (scroll.scrollBy === wrapper) scroll.scrollBy = wheel;
    window.dispose(); installed = undefined;
  }
  function mount(tui: Tui, root: any) {
    if (!root || !host.Container || !host.ScrollView) { unmount(); return; }
    const find = (node: any): Scroll | undefined => {
      if (!node) return;
      if (node instanceof (host.ScrollView as any) && node.primary) return node;
      const layout = node[LAYOUT_NODE]?.();
      for (const entry of layout?.entries ?? []) { const found = find(entry.component); if (found) return found; }
    };
    const scroll = find(root);
    if (!scroll) { unmount(); reason = "primary ScrollView unavailable"; return; }
    if (installed?.scroll === scroll) return;
    unmount();
    const source = scroll.child;
    if (!(source instanceof (host.Container as any))) { reason = "unsupported transcript root"; return; }
    const selected = () => tui.getSelectionBounds ? !!tui.getSelectionBounds() : tui.hasActiveSelection?.() === true;
    const window = new HistoryWindow(source, scroll, host.Container, selected);
    const restoreStart = observe(scroll, ["scrollToStart"], () => { window.jump("older"); tui.requestRender?.(); });
    const restoreEnd = observe(scroll, ["scrollToEnd"], () => { window.jump("newer"); tui.requestRender?.(); });
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
    installed = { scroll, source, window, wheel, wrapper, restoreNavigation: () => { restoreStart(); restoreEnd(); }, removeInput }; reason = "installed";
  }
  return {
    installOnTui(tui: unknown): boolean {
      const target = tui as Tui;
      if (!target || target.mode !== "fullscreen") return false;
      const candidate = Object.getPrototypeOf(target);
      if (!proto) {
        if (typeof candidate.setLayoutRoot !== "function" || candidate.setLayoutRoot[OWNER]) return false;
        setter = candidate.setLayoutRoot;
        wrappedSetter = function (this: Tui, root: unknown) { mount(this, root); return setter.call(this, root); };
        wrappedSetter[OWNER] = true;
        candidate.setLayoutRoot = wrappedSetter; proto = candidate;
      }
      mount(target, target.layoutRoot); return !!installed;
    },
    status() { return { installed: !!installed, reason, ...installed?.window.status() }; },
    dispose() { unmount(); if (proto && proto.setLayoutRoot === wrappedSetter) proto.setLayoutRoot = setter; proto = undefined; },
  };
}
