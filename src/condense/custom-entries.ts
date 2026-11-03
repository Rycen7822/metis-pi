import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { readHistoryEntries, reverseBranchEntryReferences } from "../session-history.ts";

export function* customEntries(source: Iterable<SessionEntry> | ExtensionContext["sessionManager"], customType?: string) {
  const entries = "getBranch" in source
    ? readHistoryEntries(source, "branch", entry => entry.type === "custom"
      && (customType === undefined || entry.customType === customType))
    : source;
  for (const entry of entries) {
    if (entry.type === "custom" && (customType === undefined || entry.customType === customType)) yield entry;
  }
}

export function hasCustomEntryData(manager: ExtensionContext["sessionManager"], customType: string, data: unknown): boolean {
  // Publication normally checks the just-appended record; retain the older-record fallback.
  for (const reference of reverseBranchEntryReferences(manager)) {
    if (reference.type !== "custom" || reference.customType !== customType) continue;
    const entry = manager.getEntry(reference.id);
    if (!entry) throw new Error(`Session entry not found: ${reference.id}`);
    if (entry.type === "custom" && JSON.stringify(entry.data) === JSON.stringify(data)) return true;
  }
  return false;
}
