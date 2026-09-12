// Codex-look composer FACTORY. Runs only inside index.ts's activation: the
// host CustomEditor class and the surface painters are injected here so this
// module stays dependency-free (project rule: src/ never imports
// @earendil-works/* directly).
//
// Surface mode (surface ops injected): the stock full-width accent borders
// are replaced by surface-painted padding rows (scroll indicators `↑ N more`
// preserved, dim); the first body row's two padding cells become `> ` and the
// empty editor shows a dim placeholder — same cells, so cursor geometry, mouse
// hit tests and autocomplete anchors are untouched (real-component tests
// cover this). The gray background is painted per physical row with bg
// re-assertion after inner resets (see src/surface.ts).
// Intentionally no per-line '›' prefix beyond the first row (deliberate Codex
// deviation, see VALIDATION.md).

/** Minimal structural types for the host pieces we touch (no imports). */
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
  /** Surface mode (gray background, no accent borders). Absent → legacy. */
  surface?: CodexSurfaceOps;
  /** `> ` prompt prefix on the first body row (default true in surface mode). */
  promptPrefix?: boolean;
  /** Placeholder shown on the empty first row (display only, never getText). */
  placeholder?: string;
  /** Legacy-mode accent painter (fallback: inline truecolor cyan). */
  accent?: (s: string) => string;
  paddingX?: number;
  embedWorkingStatus?: boolean;
  /** Selection-aware Ctrl+C: consume the key when the fullscreen TUI has a
   * selection (copy if copyable, consume-only when decoration-only). */
  selectionCopy?: { tryConsume: (data: string, editor: unknown) => boolean };
}

const CURSOR_CELL = "\x1b[7m \x1b[0m";

export function makeCodexEditorFactory(input: CodexEditorFactoryInput) {
  const accent = input.accent ?? ((s: string) => `\x1b[38;2;137;180;250m${s}\x1b[39m`);
  const surface = input.surface;
  const paddingX = input.paddingX ?? 2;
  const placeholder = input.placeholder ?? "Ask anything...";

  class CodexSurfaceEditor extends input.host.CustomEditor {
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
    }

    override renderTopBorder(width: number, hiddenLineCount: number): string {
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
        // the exact end-of-text cell `\x1b[7m \x1b[0m`. Overwrite an equal
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
