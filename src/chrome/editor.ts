// Codex-look composer FACTORY. Runs only inside index.ts's activation: the
// host CustomEditor class and theme painters are injected here so this module
// stays dependency-free (project rule: src/ never imports @earendil-works/*
// directly). embedWorkingStatus stays ON (the Working line lives in the top
// border). Intentionally no per-line '›' prefix: the Editor render pipeline
// has no safe per-line hook (deliberate Codex deviation, see VALIDATION.md).

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
