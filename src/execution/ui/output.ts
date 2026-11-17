import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { cachedRowsComponent } from "../../presentation/components/rows.ts";
import { asRecord } from "../../presentation/tool-names.ts";
import { stripAnsi, wrapWithProvenance, type ProvenanceRow } from "../../selection-copy/wrap.ts";
import { OUTPUT_INITIAL_PREFIX, OUTPUT_SUBSEQUENT_PREFIX, type Foreground } from "../../presentation/terminal-text.ts";

export function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const { text } = asRecord(content.find(part => asRecord(part)["type"] === "text"));
  return typeof text === "string" ? text : "";
}

/** Bound the work before wrapping collapsed terminal output. */
export function trimOutputTail(output: string, maxChars: number, maxLines: number) {
  const clipped = output.length > maxChars;
  if (clipped) output = output.slice(-maxChars);
  const start = clipped ? output.indexOf("\n") + 1 : 0;
  const lines = output.slice(start).split("\n");
  return { output: lines.slice(-maxLines).join("\n"), truncated: clipped || lines.length > maxLines };
}

function expandHint(): string {
  try { return keyHint("app.tools.expand", "to expand"); }
  catch { return "ctrl+o to expand"; }
}

/** Wrap the body before adding the gutter so soft wraps cannot escape it. */
export function renderExecOutput(
  body: string,
  status: readonly string[],
  theme: Foreground,
  preview?: { lines: number; truncated?: boolean; hint?: boolean },
) {
  return cachedRowsComponent((width, copyOut) => {
    const indent = width > OUTPUT_SUBSEQUENT_PREFIX.length + 1 ? OUTPUT_SUBSEQUENT_PREFIX : "";
    const branch = indent ? OUTPUT_INITIAL_PREFIX : "";
    const available = Math.max(1, width - indent.length);
    const normalized = body.replace(/\t/g, "   ");
    const rows = normalized ? wrapTextWithAnsi(normalized, available) : [];
    const bodyRows = rows.length;
    for (const line of status) rows.push(...wrapTextWithAnsi(line, available));
    // Keep the host wrap authoritative and avoid a second large output projection.
    const source = normalized && normalized.length <= 16_000
      ? wrapWithProvenance([{ styled: normalized, kind: "content" }], available, visibleWidth) : [];
    const matched = source.length === bodyRows && source.every((row, i) => stripAnsi(row.styled) === rows[i]);
    const skipped = preview ? Math.max(0, rows.length - preview.lines) : 0;
    const visible: string[] = [];
    const push = (gutter: string, text: string, mapping?: ProvenanceRow) => {
      const shift = gutter.length;
      visible.push(theme.fg("dim", gutter) + text);
      const spans = mapping ? mapping.spans.map(span => ({ ...span, colStart: span.colStart + shift, colEnd: span.colEnd + shift }))
        : [{ colStart: shift, colEnd: shift + visibleWidth(text), kind: "unknown" as const }];
      copyOut.push({ breakBefore: mapping && !mapping.hard ? "soft" : "hard", bridge: mapping?.bridge ?? "",
        spans: [{ colStart: 0, colEnd: shift, kind: "decoration" }, ...spans] });
    };
    if (preview?.hint && (skipped || preview.truncated)) {
      const message = preview.truncated ? "earlier output hidden" : `${skipped} earlier lines`;
      push(indent, truncateToWidth(theme.fg("muted", `... (${message}, ${expandHint()})`), available, "..."));
    }
    for (let i = skipped; i < rows.length; i++) {
      const row = truncateToWidth(rows[i]!, available);
      const mapping = matched && i < bodyRows && row === rows[i] ? source[i] : undefined;
      push(i === 0 && !preview?.truncated ? branch : indent, i < bodyRows ? theme.fg("dim", row) : row, mapping);
    }
    return visible;
  });
}
