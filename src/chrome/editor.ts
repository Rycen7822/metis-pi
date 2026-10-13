// Codex-look composer FACTORY. Runs only inside index.ts's activation: the
// host CustomEditor class and the surface painters are injected here; the
// cursor cell uses Pi 1.2's public fake-cursor helper.
//
// Surface mode (surface ops injected): the stock full-width accent borders
// are replaced by surface-painted padding rows (scroll indicators `↑ N more`
// preserved, dim); the first body row's two padding cells become `> ` and the
// empty editor shows a dim placeholder — same cells, so cursor geometry, mouse
// hit tests and autocomplete anchors are untouched (real-component tests
// cover this). The gray background is painted per physical row with bg
// re-assertion after inner resets (see src/surface.ts).
// Intentionally no per-line '›' prefix beyond the first row (deliberate Codex deviation).

import { renderFakeCursor } from "@earendil-works/pi-tui";
import { CODEX_CYAN_RGB } from "../palette.ts";
import { isSkillPrefixOnly } from "../skill-tokens.ts";
import { cellWidth, clipLine } from "../segments.ts";
import { formatDuration } from "../ui-metrics.ts";

/** Structural subset of the status passed through CustomEditor's public API. */
export interface CodexStatusIndicator {
  readonly kind: "working" | "retry" | "compaction" | "branchSummary";
  renderInBorder(width: number): string;
}

export interface CodexEditorRowHost {
  borderColor: (str: string) => string;
  paddingX: number;
  focused: boolean;
  render(width: number): string[];
  renderTopBorder(width: number, hiddenLineCount: number): string;
  renderBottomBorder(width: number, hiddenLineCount: number): string;
  getText: () => string;
  getPaddingX(): number;
  setPaddingX(padding: number): void;
  handleInput(data: string): void;
  setWorkingStatusIndicator?(indicator: CodexStatusIndicator | undefined): void;
  /** Base editor surface used by the multi-skill trigger hook (optional so
   * test fakes without them stay valid — absent means "no hook"). */
  getLines?: () => string[];
  getCursor?: () => { line: number; col: number };
  isShowingAutocomplete?: () => boolean;
  /** The editor's own auto-trigger, the same one letters in a slash context
   * use (private in the host class; absent on other host versions). */
  tryTriggerAutocomplete?: () => void;
}

export interface CodexEditorHost {
  CustomEditor: new (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    options?: { embedWorkingStatus?: boolean; paddingX?: number },
  ) => CodexEditorRowHost;
}

export interface CodexSurfaceOps {
  /** Paint one physical row with the surface background (pads to width). */
  paintRow: (row: string, width: number) => string;
  /** Prompt glyph / scroll-indicator painter. */
  paintGlyph: (text: string, tone: "accent" | "dim") => string;
}

export interface CodexEditorFactoryInput {
  host: CodexEditorHost;
  /** Surface mode (gray background, no accent borders). Absent → native borders. */
  surface?: CodexSurfaceOps;
  /** `> ` prompt prefix on the first body row (default true in surface mode). */
  promptPrefix?: boolean;
  /** Placeholder shown on the empty first row (display only, never getText). */
  placeholder?: string;
  /** Native-border accent painter (fallback: inline truecolor cyan). */
  accent?: (s: string) => string;
  paddingX?: number;
  embedWorkingStatus?: boolean;
  /** Selection-aware Ctrl+C: consume the key when the fullscreen TUI has a
   * selection (copy if copyable, consume-only when decoration-only). */
  selectionCopy?: { tryConsume: (data: string, editor: unknown) => boolean };
  /** Multi-skill composer: force the completion query for a trigger char the
   * host refuses to auto-trigger (see forceSkillCompletion). */
  skillTrigger?: boolean;
  /** Acquire a real vertical cursor; undefined leaves the native block intact. */
  hardwareCursor?: (tui: unknown) => void;
}

const CURSOR_CELL = renderFakeCursor(" ");

/**
 * Force the completion query the host skips for the second skill trigger.
 *
 * The host editor auto-triggers `/` only at line start (isAtStartOfMessage),
 * `/` is excluded from its autocomplete trigger characters, and a query that
 * returns nothing clears its menu state — so after `/skill:a ` (the built-in
 * provider answers nothing there) the next `/` keystroke reaches NO provider
 * at all: no menu, no matter how long the user waits. The editor's own
 * auto-trigger path is private, so call it directly (optional member: if a
 * future host renames it, this silently does nothing instead of throwing).
 * The predicate matches ONLY "complete skill tokens + whitespace" right before
 * the slash, so ordinary text and first-token slashes are untouched.
 */
function forceSkillCompletion(editor: CodexEditorRowHost, data: string): void {
  if (data !== "/") return;
  if (typeof editor.tryTriggerAutocomplete !== "function") return;
  if (editor.isShowingAutocomplete?.() === true) return;
  const cursor = editor.getCursor?.();
  const line = cursor ? (editor.getLines?.() ?? [])[cursor.line] : undefined;
  if (cursor === undefined || line === undefined) return;
  const beforeCursor = line.slice(0, cursor.col);
  if (!beforeCursor.endsWith("/")) return;
  if (!isSkillPrefixOnly(beforeCursor.slice(0, -1))) return;
  editor.tryTriggerAutocomplete();
}

export function makeCodexEditorFactory(input: CodexEditorFactoryInput) {
  const accent = input.accent ?? ((s: string) => `\x1b[38;2;${CODEX_CYAN_RGB}m${s}\x1b[39m`);
  const surface = input.surface;
  const paddingX = input.paddingX ?? 2;
  const placeholder = input.placeholder ?? "Ask anything...";

  class CodexSurfaceEditor extends input.host.CustomEditor {
    private nativeStatus: CodexStatusIndicator | undefined;
    private compactionStartedAt: number | undefined;

    constructor(tui: unknown, theme: unknown, keybindings: unknown, options: { embedWorkingStatus?: boolean; paddingX?: number }) {
      super(tui, theme, keybindings, options);
      input.hardwareCursor?.(tui);
    }

    // Public custom-editor integration, not a native prototype patch. Pi owns
    // the indicator, spinner repaint and cancellation; we only render it.
    override setWorkingStatusIndicator(indicator: CodexStatusIndicator | undefined): void {
      super.setWorkingStatusIndicator?.(indicator);
      this.nativeStatus = indicator;
      if (indicator?.kind === "compaction") {
        this.compactionStartedAt ??= performance.now();
      } else if (indicator && indicator.kind !== "retry") {
        this.compactionStartedAt = undefined;
      } else if (!indicator && this.compactionStartedAt !== undefined) {
        // showStatusIndicator clears then replaces synchronously. Keep elapsed
        // time through retry/backoff swaps, but clear it after a real end.
        queueMicrotask(() => {
          if (!this.nativeStatus) this.compactionStartedAt = undefined;
        });
      }
    }

    // The host re-applies ITS default paddingX to custom editors after
    // install (interactive-mode.js). The `> ` prefix borrows the first two
    // padding cells, so the surface composer needs at least two — clamp and
    // keep every geometry consumer (render/handleMouse) on the same value.
    override setPaddingX(value: number): void {
      super.setPaddingX(Math.max(2, value));
    }

    // Selection-aware Ctrl+C. Runs BEFORE the app-action dispatch so a
    // selection copies instead of clearing the draft; without a selection the
    // stock path (including the double-press-to-exit logic) is untouched.
    override handleInput(data: string): void {
      const hook = input.selectionCopy;
      if (hook && hook.tryConsume(data, this)) return;
      super.handleInput(data);
      if (input.skillTrigger) forceSkillCompletion(this, data);
    }

    override renderTopBorder(width: number, hiddenLineCount: number): string {
      if (input.embedWorkingStatus && this.nativeStatus && width > 0) {
        const elapsed = this.nativeStatus.kind === "compaction" && this.compactionStartedAt !== undefined
          ? ` · ${formatDuration(performance.now() - this.compactionStartedAt)}` : "";
        const scroll = hiddenLineCount > 0 ? ` · ↑ ${hiddenLineCount} more` : "";
        const status = this.nativeStatus.renderInBorder(Math.max(1, width - 2));
        // Keep the native cancel hint ahead of display-only details. Drop
        // scroll detail, then elapsed, rather than truncating a fitting hint.
        const room = width - 1 - cellWidth(status);
        const tail = cellWidth(elapsed + scroll) <= room ? elapsed + scroll
          : cellWidth(elapsed) <= room ? elapsed : "";
        const paintedTail = surface ? surface.paintGlyph(tail, "dim") : tail;
        const line = clipLine(` ${status}${paintedTail}`, width);
        return surface ? surface.paintRow(line, width) : line;
      }
      if (!surface) return accent("─".repeat(Math.max(0, width)));
      if (hiddenLineCount > 0) {
        // Scroll indicator must survive the redesign (dim, on-surface).
        return surface.paintRow(` ${surface.paintGlyph(`↑ ${hiddenLineCount} more`, "dim")} `, width);
      }
      return surface.paintRow("", width);
    }

    override renderBottomBorder(width: number, hiddenLineCount: number): string {
      if (!surface) return accent("─".repeat(Math.max(0, width)));
      if (hiddenLineCount > 0) {
        return surface.paintRow(` ${surface.paintGlyph(`↓ ${hiddenLineCount} more`, "dim")} `, width);
      }
      return surface.paintRow("", width);
    }

    override render(width: number): string[] {
      const rows = super.render(width);
      if (!surface || rows.length === 0) return rows;
      // Base Editor.render row structure (verified in pi-tui editor.js):
      // [topBorder, ...body rows..., bottomBorder, ...autocomplete rows...].
      // The first BODY row is therefore always index 1 — structural, not a
      // guess from ANSI content.
      const painted = rows.map((row) => surface!.paintRow(row, width));
      const livePaddingX = typeof this.getPaddingX === "function" ? this.getPaddingX() : paddingX;
      if (rows.length >= 2 && livePaddingX >= 2 && (input.promptPrefix ?? true)) {
        const body = rows[1]!;
        let decorated = body;
        // `>` + (paddingX-1) spaces replaces the left padding cells — same
        // cell count, zero cursor/geometry shift.
        const pad = " ".repeat(livePaddingX);
        if (body.startsWith(pad)) {
          decorated = `${surface.paintGlyph(">", "accent")}${" ".repeat(livePaddingX - 1)}${body.slice(livePaddingX)}`;
        }
        // Placeholder: only for the EMPTY editor, where the host cursor is
        // the exact end-of-text cell wrapped by renderFakeCursor. Overwrite an equal
        // number of trailing padding cells (never grow the row), and never
        // touch getText().
        if (this.getText() === "" && decorated.includes(CURSOR_CELL)) {
          const at = decorated.indexOf(CURSOR_CELL) + CURSOR_CELL.length;
          const glyph = surface.paintGlyph(placeholder, "dim");
          const after = decorated.slice(at);
          const replacement = glyph + after.slice(Math.min(after.length, placeholder.length));
          decorated = `${decorated.slice(0, at)}${replacement}`;
        }
        painted[1] = surface.paintRow(decorated, width);
      }
      return painted;
    }
  }

  return (tui: unknown, theme: unknown, keybindings: unknown) => {
    const editor = new CodexSurfaceEditor(tui, theme, keybindings, {
      embedWorkingStatus: input.embedWorkingStatus ?? false,
      paddingX,
    });
    if (!surface) editor.borderColor = accent;
    return editor;
  };
}
