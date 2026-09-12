// Collapsed thinking label (display-only): "Thought for 13s" / "Thought".
// Duration convention matches the Working line (ui-metrics formatDuration:
// 13s / 1m 04s / 1h 02m 03s). No host imports — painting happens in index.ts.

import { formatDuration } from "./ui-metrics.ts";

/** Label text for one collapsed thinking run. An absent duration means no
 * honest timing evidence (e.g. a restored history session) — never fabricate
 * "0s" for missing evidence. */
export function thoughtSummaryText(durationMs?: number): string {
  return durationMs === undefined ? "Thought" : `Thought for ${formatDuration(durationMs)}`;
}
