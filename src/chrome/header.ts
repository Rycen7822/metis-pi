// Minimal 1–2 line startup header: shows the REAL identity (Pi + this
// extension + model/dir). Never impersonates OpenAI/Codex; omitted fields
// render no line.

export interface HeaderDeps {
  appearanceVersion: string;
  piVersion: string;
  getModel: () => { label: string } | undefined;
  getCwd: () => string;
}

export function headerLines(deps: HeaderDeps): string[] {
  const lines: string[] = [];
  lines.push(`Pi ${deps.piVersion} · codex-appearance ${deps.appearanceVersion}`);
  const model = deps.getModel()?.label;
  const dir = deps.getCwd();
  const second = [model, dir].filter(Boolean).join(" · ");
  if (second) lines.push(second);
  return lines;
}

export function createHeaderComponent(deps: HeaderDeps, theme: { fg?: (key: string, text: string) => string } | undefined) {
  // The host may pass a theme proxy that is not yet bound to a concrete
  // Theme instance (early header construction). Resolve the painter LAZILY at
  // render time and fall back to plain text if the theme is unusable.
  const paint = (): (key: string, text: string) => string => {
    const probe = (fg: (k: string, t: string) => string): boolean => {
      try {
        const probeText = "\u0000probe";
        return typeof fg("dim", probeText) === "string" && fg("dim", probeText) !== probeText;
      } catch {
        return false;
      }
    };
    if (theme && typeof theme.fg === "function" && probe(theme.fg)) {
      return (k, t) => (theme as { fg: (k: string, t: string) => string }).fg(k, t);
    }
    const globalTheme = (globalThis as Record<symbol, unknown>)[
      Symbol.for("@earendil-works/pi-coding-agent:theme")
    ] as { fg?: (k: string, t: string) => string } | undefined;
    if (globalTheme && typeof globalTheme.fg === "function" && probe(globalTheme.fg)) {
      return (k, t) => (globalTheme as { fg: (k: string, t: string) => string }).fg(k, t);
    }
    return (_k: string, t: string) => t;
  };
  return {
    render(width: number): string[] {
      const painter = paint();
      return headerLines(deps).map((line) => painter("dim", line.slice(0, Math.max(0, width))));
    },
    invalidate(): void {
      // static
    },
    dispose(): void {
      // static
    },
  };
}
