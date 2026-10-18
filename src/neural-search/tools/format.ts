import type { GrepResult, SearchResult } from "@ff-labs/fff-node";
import { truncateHead } from "@earendil-works/pi-coding-agent";

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
  let lineTruncated = false;
  const blocks = [...files.values()].map(file => [file.heading,
    ...[...file.rows].sort(([a], [b]) => a - b).map(([number, row]) => {
      let text = row.text;
      if (text.length > 500) { text = `${text.slice(0, 500)}...`; lineTruncated = true; }
      return ` ${number}${row.matched ? ":" : "-"} ${text}`;
    }),
  ].join("\n"));
  const bounded = truncateHead(blocks.join("\n\n"));
  const truncated = lineTruncated || bounded.truncated;
  const reasons = [lineTruncated ? "source lines shortened to 500 characters" : "",
    bounded.truncated ? `${bounded.totalLines - bounded.outputLines} output lines omitted by the display budget` : ""].filter(Boolean);
  const notice = truncated ? `\n[Output truncated: ${reasons.join("; ")}. Refine the query or read the matching files.]` : "";
  return { output: bounded.content + notice, truncated };
}

export function formatFindOutput(items: SearchResult["items"], limit: number, weak: boolean): { output: string; shownCount: number } {
  if (!items.length) return { output: "No files found matching pattern", shownCount: 0 };
  const shown = items.slice(0, weak ? Math.min(5, limit) : limit);
  return { output: shown.map(item => `${item.relativePath}${fileAnnotation(item)}`).join("\n"), shownCount: shown.length };
}
