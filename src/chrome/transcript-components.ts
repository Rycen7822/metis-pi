// Codex transcript display components: the separator, the live write call, and
// the three wrappers around a thinking run (rail, peek window, click layer).
//
// These are the leaf display classes the appearance entry used to own; they
// moved here so the entry stays a thin host-wiring file. Every host TYPE they
// need is structural (see TranscriptChild/TranscriptMouseEvent) and the entry
// injects the pipeline ColorLevel, so this module never imports the host
// packages (src/ rule) while rendering exactly what it rendered before.

import { registerProduct, productFor } from "../selection-copy/model.ts";
import type { CopyRow } from "../selection-copy/model.ts";
import { peekHintText } from "../thinking-view.ts";
import type { PeekWindow, ThinkingView, ThinkingViewControl } from "../thinking-view.ts";
import { CODEX_CYAN_RGB } from "../palette.ts";
import type { ColorLevel } from "../palette.ts";
import { renderWritePreview } from "../write-preview.ts";
import type { WritePreviewInput } from "../renderers.ts";
import type { Component, DiffLayoutOps } from "../tool-names.ts";

/** The slice of a pi-tui mouse event these wrappers inspect. */
export interface TranscriptMouseEvent {
  type?: string;
  button?: string;
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  wheelDelta?: number;
}

/** The slice of a pi-tui mouse result these wrappers return. */
export type TranscriptMouseResult = { handled?: boolean; render?: boolean } | undefined;

/** The slice of a host component a wrapper renders and forwards to. */
export interface TranscriptChild extends Component {
  invalidate?(): void;
}

/** Separator before assistant text that follows tool activity: a light
 * horizontal rule sized to the live layout width (never a fixed column count). */
export class CodexSeparatorComponent implements Component {
  readonly #level: ColorLevel;

  constructor(level: ColorLevel) {
    this.#level = level;
  }

  render(width: number): string[] {
    const usable = Math.max(1, Math.floor(width));
    const level = this.#level;
    const line = "─".repeat(usable);
    return [level.kind === "none" ? "-".repeat(usable) : `\x1b[2m${line}\x1b[22m`];
  }
  invalidate(): void {}
}

/** Live write call: structured header (• Writing <path>) + stage line +
 * bounded rolling tail of the real args.content prefix. The header
 * is part of THIS component and can never be bypassed by the preview body.
 * `update()` refreshes inputs in place so the host's lastComponent reuse
 * path keeps one stable instance per call. */
export class CodexWriteCallComponent implements Component {
  #input: WritePreviewInput & { headerText: string; layout: DiffLayoutOps; maxRows?: number };
  #revision = 0;
  #lastWidth = -1;
  #lastRevision = -1;
  #lastExpanded = false;
  #cache: string[] | undefined;

  constructor(input: WritePreviewInput & { headerText: string; layout: DiffLayoutOps; maxRows?: number }) {
    this.#input = input;
  }

  update(next: WritePreviewInput & { headerText?: string; layout?: DiffLayoutOps; maxRows?: number }): void {
    // The renderers' reuse path builds a PARTIAL input (no layout/maxRows -
    // those are component-owned). Merge instead of replacing: a full replace
    // dropped `layout` and crashed render on the next frame.
    this.#input = {
      ...next,
      headerText: next.headerText ?? this.#input.headerText,
      layout: next.layout ?? this.#input.layout,
      maxRows: next.maxRows ?? this.#input.maxRows,
    };
    // Bump the revision only when VISIBLE state changed (content, stage,
    // header, expansion, colors) - identical repeated snapshots keep the
    // old frame without a re-layout.
    const prev = this.#prevVisible;
    if (prev.contentPrefix !== next.contentPrefix
        || prev.stage !== next.stage
        || (next.headerText ?? "") !== prev.headerText
        || next.expanded !== prev.expanded
        || next.colorLevel.kind !== prev.colorKind) {
      this.#revision += 1;
    }
    this.#prevVisible = {
      contentPrefix: next.contentPrefix,
      stage: next.stage,
      headerText: next.headerText ?? "",
      expanded: next.expanded,
      colorKind: next.colorLevel.kind,
    };
  }

  #prevVisible: {
    contentPrefix: string; stage: string; headerText: string;
    expanded: boolean; colorKind: string;
  } = { contentPrefix: "", stage: "", headerText: "", expanded: false, colorKind: "" };

  render(width: number): string[] {
    const expanded = this.#input.expanded === true;
    if (this.#cache && this.#lastWidth === width && this.#lastRevision === this.#revision && this.#lastExpanded === expanded) {
      return this.#cache;
    }
    const header = this.#input.headerText;
    const out: string[] = [header];
    const copyOut: CopyRow[] = [{ spans: [{ colStart: 0, colEnd: width, kind: "decoration" }], breakBefore: "hard" }];
    // Live body: bounded tail; the body renderer owns its own physical-row
    // budget, header width is independent.
    const body = renderWritePreview(this.#input.contentPrefix, {
      width: Math.max(1, Math.floor(width)),
      stage: this.#input.stage,
      expanded,
      theme: this.#input.theme,
      colorLevel: this.#input.colorLevel,
      layout: this.#input.layout,
      gutter: "  │ ",
      headerRows: 1, // the header line above is ours; body budget is separate
      maxRows: this.#input.maxRows, // config.writePreview.rows (0 = body off)
      copyOut,
    });
    for (const line of body) out.push(line);
    if (copyOut.length === out.length) {
      registerProduct(out, { componentId: "write-call", width, rows: copyOut });
    }
    this.#cache = out;
    this.#lastWidth = width;
    this.#lastRevision = this.#revision;
    this.#lastExpanded = expanded;
    return this.#cache;
  }

  invalidate(): void {
    this.#cache = undefined;
    this.#lastWidth = -1;
  }
}

/** Narrow static rail left of a thinking run. Wraps the host's thinking
 * component (Markdown inside MouseRegion) so clicks keep working. */
export class CodexThinkingRailComponent implements Component {
  readonly #child: TranscriptChild;
  readonly #level: ColorLevel;
  #lastWidth = -1;
  #lastChildLines: string[] | undefined;
  #cache: string[] | undefined;

  constructor(child: TranscriptChild, level: ColorLevel) {
    this.#child = child;
    this.#level = level;
  }

  render(width: number): string[] {
    const railCells = 2;
    const inner = Math.max(1, Math.floor(width) - railCells);
    const childLines = this.#child.render(inner);
    // Cached by BOTH width and the child's row array: a peek window that
    // scrolled in place returns a new array, so the rail must re-prefix it.
    // The child render itself is cached downstream (peek/markdown per width),
    // which is what makes this identity check cheap.
    if (this.#cache && this.#lastWidth === width && this.#lastChildLines === childLines) return this.#cache;
    const level = this.#level;
    const rail = level.kind === "none" ? "| " : `\x1b[38;2;${CODEX_CYAN_RGB}m▏\x1b[39m `;
    // Per-row shift: rows already carrying a rail pass through WITHOUT the
    // prefix, so their provenance shift is 0, not railCells.
    const shifts = childLines.map((line) => {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      return stripped.startsWith("▏") || stripped.startsWith("| ") ? 0 : railCells;
    });
    this.#cache = childLines.map((line, i) => (shifts[i] === 0 ? line : `${rail}${line}`));
    // Provenance: every rail row is the child's row shifted right by its rail
    // cells (the rail itself is decoration). Resolves through the child
    // product via array identity when one exists.
    const childProduct = productFor(childLines);
    if (childProduct) {
      registerProduct(this.#cache, {
        componentId: "thinking-rail",
        width,
        rows: [],
        children: this.#cache.map((_, i) => childProduct.children
          ? childProduct.children[i]
            ? { ...childProduct.children[i]!, colShift: childProduct.children[i]!.colShift + shifts[i]! }
            : undefined
          : { product: childProduct, rowIndex: i, colShift: shifts[i]! }),
      });
    }
    this.#lastWidth = width;
    this.#lastChildLines = childLines;
    return this.#cache;
  }

  handleMouse(event: TranscriptMouseEvent): TranscriptMouseResult {
    if (event.type === "click" && event.button === "left") {
      if (event.x < 2) return undefined; // rail column: not a toggle
      const child = this.#child as unknown as { handleMouse?: (e: TranscriptMouseEvent) => TranscriptMouseResult };
      return child.handleMouse?.({ ...event, x: event.x - 2 });
    }
    const child = this.#child as unknown as { handleMouse?: (e: TranscriptMouseEvent) => TranscriptMouseResult };
    return child.handleMouse?.(event);
  }

  invalidate(): void {
    this.#cache = undefined;
    this.#lastWidth = -1;
    this.#lastChildLines = undefined;
    this.#child.invalidate?.();
  }
}

/** Forward a mouse event to a wrapped component (undefined when it cannot
 * receive one). Used by every wrapper whose own interest is clicks or wheels. */
function childHandleMouse(child: unknown, event: TranscriptMouseEvent): TranscriptMouseResult {
  const target = child as { handleMouse?: (event: TranscriptMouseEvent) => TranscriptMouseResult };
  return typeof target?.handleMouse === "function" ? target.handleMouse(event) : undefined;
}

/**
 * Peek window over a thinking body: the newest `windowLines` rendered rows,
 * wheel-scrollable, plus ONE dim hint row when rows are clipped. The child's
 * own rows are sliced — never re-rendered — so markdown styling, the rail and
 * copy provenance stay exactly what the host produced; the window's rows map
 * back to the child's rows one-to-one (the hint row stays unmapped, so a copy
 * of it falls back to native extraction of the visible text).
 */
export class CodexThinkingPeekComponent implements Component {
  readonly #child: TranscriptChild;
  readonly #control: ThinkingViewControl;
  readonly #windowLines: number;
  readonly #paintHint: (text: string) => string;
  readonly #onScroll: () => void;
  #lastWidth = -1;
  #childLines: string[] | undefined;
  #window: PeekWindow | undefined;
  #rows: string[] | undefined;

  constructor(
    child: TranscriptChild,
    control: ThinkingViewControl,
    windowLines: number,
    paintHint: (text: string) => string,
    onScroll: () => void,
  ) {
    this.#child = child;
    this.#control = control;
    this.#windowLines = windowLines;
    this.#paintHint = paintHint;
    this.#onScroll = onScroll;
  }

  render(width: number): string[] {
    // Child rows are cached per width; the WINDOW is rebuilt whenever it moved
    // (a wheel scroll changes it without any content change, and a stale cache
    // would freeze the visible rows).
    if (!this.#childLines || this.#lastWidth !== width) {
      this.#childLines = this.#child.render(width);
      this.#lastWidth = width;
      this.#window = undefined;
    }
    const lines = this.#childLines;
    const window = this.#control.scroll.resolve(lines.length, this.#windowLines);
    const cached = this.#window;
    if (this.#rows && cached && cached.top === window.top && cached.above === window.above && cached.below === window.below) {
      return this.#rows;
    }
    const body = lines.slice(window.top, window.top + this.#windowLines);
    const clipped = window.above > 0 || window.below > 0;
    const rows = clipped
      ? [this.#paintHint(peekHintText(window.above, window.below, lines.length)), ...body]
      : body;
    const childProduct = productFor(lines);
    if (childProduct) {
      registerProduct(rows, {
        componentId: "thinking-peek",
        width,
        rows: [],
        children: rows.map((_, index) => {
          if (clipped && index === 0) return undefined; // hint row = decoration, copied natively
          const source = window.top + index - (clipped ? 1 : 0);
          return childProduct.children
            ? childProduct.children[source]
            : { product: childProduct, rowIndex: source, colShift: 0 };
        }),
      });
    }
    this.#window = window;
    this.#rows = rows;
    return rows;
  }

  handleMouse(event: TranscriptMouseEvent): TranscriptMouseResult {
    if (event.type === "wheel") {
      // Scrolling inside the window wins; at either end the event falls through
      // so the transcript scrolls instead of swallowing the gesture.
      if (!this.#control.scroll.scrollBy(event.wheelDelta ?? 0)) return undefined;
      // The window moved: ask for the same host rebuild a click asks for, which
      // is the path that actually repaints this subtree.
      this.#onScroll();
      return { handled: true, render: true };
    }
    return childHandleMouse(this.#child, event);
  }

  invalidate(): void {
    this.#childLines = undefined;
    this.#rows = undefined;
    this.#window = undefined;
    this.#lastWidth = -1;
    this.#child.invalidate?.();
  }
}

/**
 * Click layer around a thinking block (rail and peek inside it). A click never
 * rewrites itself into a toggle here: the run control owns the gesture, so a
 * single click (delayed by the double-click window) folds or opens the peek
 * window while a double click switches between peek and full — the same rule
 * while streaming and after completion. Renders nothing of its own.
 */
export class CodexThinkingClickableComponent implements Component {
  readonly #child: TranscriptChild;
  readonly #control: ThinkingViewControl;
  readonly #fallback: ThinkingView;
  readonly #apply: (next: ThinkingView) => void;

  constructor(child: TranscriptChild, control: ThinkingViewControl, fallback: ThinkingView, apply: (next: ThinkingView) => void) {
    this.#child = child;
    this.#control = control;
    this.#fallback = fallback;
    this.#apply = apply;
  }

  render(width: number): string[] {
    return this.#child.render(width);
  }

  handleMouse(event: TranscriptMouseEvent): TranscriptMouseResult {
    if (event.type === "click" && event.button === "left") {
      this.#control.handleClick(
        { at: Date.now(), x: event.screenX, y: event.screenY },
        { fallback: this.#fallback, apply: this.#apply },
      );
      return { handled: true };
    }
    return childHandleMouse(this.#child, event);
  }

  invalidate(): void {
    this.#child.invalidate?.();
  }
}
