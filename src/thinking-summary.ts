import { formatDuration } from "./ui-metrics.ts";

/** Label text for one collapsed thinking run. An absent duration means no
 * honest timing evidence (e.g. a restored history session) — never fabricate
 * "0s" for missing evidence. */
export function thoughtSummaryText(durationMs?: number): string {
  return durationMs === undefined ? "Thought" : `Thought for ${formatDuration(durationMs)}`;
}
