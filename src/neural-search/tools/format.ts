import type { GrepResult, SearchResult } from "@ff-labs/fff-node";

export function fileAnnotation(item: { gitStatus?: string; totalFrecencyScore?: number; accessFrecencyScore?: number }): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown") return `  [${git} in git]`;
  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  return frecency >= 25 ? "  [VERY often touched file]" : frecency >= 20 ? "  [often touched file]" : "";
}

export function formatGrepOutput(result: GrepResult): string {
  if (!result.items.length) return "No matches found";
  const lines: string[] = [];
  let currentFile = "";
  // Keep native frecency order across files and source order within each file.
  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fileAnnotation(match)}`);
    }
    match.contextBefore?.forEach((line, i) => lines.push(` ${match.lineNumber - match.contextBefore!.length + i}- ${truncateLine(line)}`));
    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);
    match.contextAfter?.forEach((line, i) => lines.push(` ${match.lineNumber + 1 + i}- ${truncateLine(line)}`));
  }
  return lines.join("\n");
}

export function formatFindOutput(result: SearchResult, limit: number, pattern: string): { output: string; weak: boolean; shownCount: number } {
  if (!result.items.length) return { output: "No files found matching pattern", weak: false, shownCount: 0 };
  const weak = (result.scores[0]?.total ?? 0) < Math.floor(pattern.length * 6);
  const shown = result.items.slice(0, weak ? Math.min(5, limit) : limit);
  return { output: shown.map(item => `${item.relativePath}${fileAnnotation(item)}`).join("\n"), weak, shownCount: shown.length };
}

function truncateLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}...`;
}
