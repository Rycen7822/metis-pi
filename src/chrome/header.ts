// chrome/header.ts — minimal 1–2 line startup header through setHeader().
//
// Shows the REAL identity (Pi + this extension + model/dir when available).
// Never impersonates OpenAI/Codex. Omitted fields simply render no line.

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
  const paint = theme?.fg ?? ((_k: string, t: string) => t);
  return {
    render(width: number): string[] {
      return headerLines(deps).map((line) => paint("dim", line.slice(0, Math.max(0, width))));
    },
    invalidate(): void {
      // static
    },
    dispose(): void {
      // static
    },
  };
}
