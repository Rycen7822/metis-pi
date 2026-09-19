// Minimal 1–2 line startup header: shows the REAL identity (Pi + this
// extension + model/dir). Never impersonates OpenAI/Codex; omitted fields
// render no line.

import { resolveThemePainter } from "../palette.ts";

export interface HeaderDeps {
  appearanceVersion: string;
  piVersion: string;
  /** Real model snapshot (id is the display value). */
  getModel: () => { id: string; name?: string } | undefined;
  getCwd: () => string;
}

export function headerLines(deps: HeaderDeps): string[] {
  const lines: string[] = [];
  lines.push(`Pi ${deps.piVersion} · codex-appearance ${deps.appearanceVersion}`);
  const model = deps.getModel()?.id;
  const dir = deps.getCwd();
  const second = [model, dir].filter(Boolean).join(" · ");
  if (second) lines.push(second);
  return lines;
}

export function createHeaderComponent(deps: HeaderDeps, theme: { fg?: (key: string, text: string) => string } | undefined) {
  // The host may pass a theme proxy that is not yet bound to a concrete
  // Theme instance (early header construction). Resolve the painter LAZILY at
  // render time via the shared probe (palette.resolveThemePainter).
  const paint = () => resolveThemePainter(theme);
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
