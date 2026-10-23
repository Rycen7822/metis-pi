import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function* customEntries(branch: readonly SessionEntry[], customType?: string) {
  for (const entry of branch) {
    if (entry.type === "custom" && (customType === undefined || entry.customType === customType)) yield entry;
  }
}
