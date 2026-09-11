// chrome/footer.ts — one compact Codex-style status line.
//
// Left: model · effort · cwd/branch — Right: context used (dim).
// Extension statuses added via ctx.ui.setStatus() keep their own row so
// third-party plugins never lose their state line (2.2).
//
// Data comes only from live host APIs: the factory arguments (tui/theme/
// footerData), ctx.getContextUsage(), and the current ctx snapshot passed in
// by index.ts. No paint-time I/O; branch updates arrive via onBranchChange.

import { formatTokensCompact } from "../ui-metrics.ts";

export interface FooterDeps {
  /** Context usage snapshot factory (ctx.getContextUsage()). */
  getContextUsage: () => { percentUsed?: number; input?: number; capacity?: number } | undefined;
  /** Current model display name (ctx.model). */
  getModel: () => { label: string; effort?: string } | undefined;
  /** Current working directory. */
  getCwd: () => string;
  /** Invalidate request (host requestRender wrapper). */
  requestRender: () => void;
}

export interface FooterDataView {
  getGitBranch?: () => string | undefined;
  getExtensionStatuses?: () => ReadonlyMap<string, string>;
  onBranchChange?: (cb: () => void) => () => void;
}

const SEP = " · ";

/** Left segment: model · effort · dir[/branch]. Unknown pieces are omitted. */
export function footerLeft(model: { label: string; effort?: string } | undefined, cwd: string, branch: string | undefined, dirLimit = 28): string {
  const parts: string[] = [];
  if (model?.label) parts.push(model.effort ? `${model.label} · ${model.effort}` : model.label);
  const dir = shortDir(cwd, dirLimit);
  if (dir) parts.push(branch ? `${dir} (${branch})` : dir);
  return parts.join(SEP);
}

/** Right segment: "NN% context left" (Codex grammar). Absent data renders nothing. */
export function footerRight(usage: { percentUsed?: number; input?: number; capacity?: number } | undefined): string {
  if (!usage) return "";
  if (typeof usage.percentUsed === "number" && Number.isFinite(usage.percentUsed)) {
    const left = Math.max(0, Math.min(100, Math.round(100 - usage.percentUsed)));
    return `${left}% context left`;
  }
  if (typeof usage.input === "number" && typeof usage.capacity === "number" && usage.capacity > 0) {
    const left = Math.max(0, Math.min(100, Math.round(100 - (usage.input / usage.capacity) * 100)));
    return `${left}% context left`;
  }
  return "";
}

/** Extension status row (third-party setStatus content, verbatim). */
export function extensionStatusLine(statuses: ReadonlyMap<string, string> | undefined): string {
  if (!statuses || statuses.size === 0) return "";
  const parts: string[] = [];
  for (const [key, text] of statuses) {
    if (text) parts.push(text);
    else parts.push(key);
  }
  return parts.join(SEP);
}

function shortDir(cwd: string, max: number): string {
  if (!cwd) return "";
  const home = /^\/(?:home|Users)\/[^/]+/;
  let out = home.test(cwd) ? cwd.replace(home, "~") : cwd;
  if (out.length > max) {
    const tail = out.slice(-max);
    const slash = tail.indexOf("/");
    out = slash >= 0 ? `…${tail.slice(slash)}` : `…${tail}`;
  }
  return out;
}

/** The component produced by our setFooter factory. */
export function createFooterComponent(
  deps: FooterDeps,
  footerData: FooterDataView | undefined,
  theme: { fg?: (key: string, text: string) => string },
) {
  let branch: string | undefined = footerData?.getGitBranch?.();
  const unsubscribe = footerData?.onBranchChange?.(() => {
    branch = footerData?.getGitBranch?.();
    deps.requestRender();
  });
  const paint = theme.fg ?? ((_k: string, t: string) => t);

  return {
    render(width: number): string[] {
      const left = footerLeft(deps.getModel(), deps.getCwd(), branch);
      const right = footerRight(deps.getContextUsage());
      const rows: string[] = [];
      const main = joinSides(left, right, width);
      if (main.trim()) rows.push(main);
      const ext = extensionStatusLine(footerData?.getExtensionStatuses?.());
      if (ext) rows.push(truncate(paint("dim", ext), width));
      return rows;
    },
    invalidate(): void {
      // stateless per render
    },
    dispose(): void {
      unsubscribe?.();
    },
  };
}

function joinSides(left: string, right: string, width: number): string {
  const leftW = visible(left);
  const rightW = visible(right);
  if (leftW + rightW === 0) return "";
  if (leftW + rightW + 2 > width) {
    // Narrow: prefer the left info; drop the right context rather than overlap.
    return truncate(left, width);
  }
  const gap = Math.max(1, width - leftW - rightW);
  return `${left}${" ".repeat(gap)}${right}`;
}

function visible(text: string): number {
  // Cell width: strip ANSI, count CJK/fullwidth as 2 (matches palette helpers).
  const bare = text.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of bare) {
    const code = ch.codePointAt(0) ?? 0;
    w += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff))) ? 2 : 1;
  }
  return w;
}

function truncate(text: string, width: number): string {
  if (visible(text) <= width) return text;
  let out = "";
  let w = 0;
  for (const ch of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    const cw = visible(ch);
    if (w + cw > width - 1) return `${out}…`;
    out += ch;
    w += cw;
  }
  return out;
}

// formatTokensCompact is re-exported for tests that verify token display rules.
export { formatTokensCompact };
