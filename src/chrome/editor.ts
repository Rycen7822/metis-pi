// chrome/editor.ts — the Codex-look composer FACTORY.
//
// Runs only inside index.ts's activation (which owns the host imports):
// index.ts passes the host CustomEditor CLASS plus theme painters here, so
// this module stays dependency-free (project rule: src/ never imports
// @earendil-works/* directly).
//
// What changes vs the stock editor:
//   · border painted with the Codex cyan accent instead of the default gray
//   · paddingX 2 for the compact-but-breathing Codex density
//   · embedWorkingStatus stays ON (the Working line lives in the top border)
//
// What intentionally does NOT change: per-line '›' prefix (the Editor render
// pipeline has no safe per-line hook; faking it risks cursor/autocomplete
// drift — recorded as a deliberate Codex deviation in VALIDATION.md).

/** Minimal structural types for the host pieces we touch (no imports). */
export interface CodexEditorHost {
  CustomEditor: new (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    options?: { embedWorkingStatus?: boolean; paddingX?: number },
  ) => {
    /** Public on the stock Editor; assignable painter. */
    borderColor: (str: string) => string;
    paddingX: number;
  };
}

export interface CodexEditorFactoryInput {
  host: CodexEditorHost;
  /** Codex accent painter (fallback: inline truecolor cyan). */
  accent?: (s: string) => string;
  paddingX?: number;
  embedWorkingStatus?: boolean;
}

export function makeCodexEditorFactory(input: CodexEditorFactoryInput) {
  const accent = input.accent ?? ((s: string) => `\x1b[38;2;148;226;213m${s}\x1b[39m`);
  return (tui: unknown, theme: unknown, keybindings: unknown) => {
    const editor = new input.host.CustomEditor(tui, theme, keybindings, {
      embedWorkingStatus: input.embedWorkingStatus ?? true,
      paddingX: input.paddingX ?? 2,
    });
    editor.borderColor = accent;
    return editor;
  };
}
