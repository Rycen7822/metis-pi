import type { GrepResult, SearchResult } from "@ff-labs/fff-node";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { hasGlobSyntax } from "../native/query.ts";

export function fileAnnotation(item: { gitStatus?: string; totalFrecencyScore?: number; accessFrecencyScore?: number }): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown") return `  [${git} in git]`;
  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  return frecency >= 25 ? "  [VERY often touched file]" : frecency >= 20 ? "  [often touched file]" : "";
}

export function formatGrepOutput(result: GrepResult): { output: string; truncated: boolean } {
  if (!result.items.length) return { output: "No matches found", truncated: false };
  type Row = { text: string; matched: boolean };
  const files = new Map<string, { heading: string; rows: Map<number, Row> }>();
  // First appearance retains native file ranking; physical rows merge overlapping
  // context windows, with actual matches taking precedence over context markers.
  for (const match of result.items) {
    let file = files.get(match.relativePath);
    if (!file) {
      file = { heading: `${match.relativePath}${fileAnnotation(match)}`, rows: new Map() };
      files.set(match.relativePath, file);
    }
    const add = (number: number, text: string, matched = false) => {
      if (matched || !file.rows.has(number)) file.rows.set(number, { text, matched });
    };
    match.contextBefore?.forEach((line, i) => add(match.lineNumber - match.contextBefore!.length + i, line));
    add(match.lineNumber, match.lineContent, true);
    match.contextAfter?.forEach((line, i) => add(match.lineNumber + 1 + i, line));
  }
  const blocks = [...files.values()].map(file => [file.heading,
    ...[...file.rows].sort(([a], [b]) => a - b).map(([number, row]) => ` ${number}${row.matched ? ":" : "-"} ${truncateLine(row.text)}`),
  ].join("\n"));
  const bounded = truncateHead(blocks.join("\n\n"));
  const notice = bounded.truncated ? `\n[Output truncated: ${bounded.totalLines - bounded.outputLines} output lines omitted by the display budget. Refine the query or read the matching files.]` : "";
  return { output: bounded.content + notice, truncated: bounded.truncated };
}

export function formatFindOutput(result: SearchResult, limit: number, pattern: string, topScore = result.scores[0]?.total ?? 0): { output: string; weak: boolean; shownCount: number } {
  if (!result.items.length) return { output: "No files found matching pattern", weak: false, shownCount: 0 };
  const fuzzy = pattern.trim().split(/\s+/).some(token => token && !hasGlobSyntax(token) && !token.startsWith("!"));
  const weak = fuzzy && topScore < Math.floor(pattern.length * 6);
  const shown = result.items.slice(0, weak ? Math.min(5, limit) : limit);
  return { output: shown.map(item => `${item.relativePath}${fileAnnotation(item)}`).join("\n"), weak, shownCount: shown.length };
}

function truncateLine(line: string): string {
  return line.length <= 500 ? line : `${line.slice(0, 500)}...`;
}
