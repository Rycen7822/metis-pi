import type { ExtensionContext, SessionEntry, SessionEntryMetadata } from "@earendil-works/pi-coding-agent";

type HistoryReader = Pick<ExtensionContext["sessionManager"],
  "getLeafId" | "getEntry" | "getEntryForScan" | "getBranchMetadata" | "getEntriesMetadata" | "getEntryMetadata">;

/** Selection facts only: load a complete entry before reading its body. */
export type SessionEntryReference = SessionEntryMetadata;

/** Stable source identity when the body can be evicted independently. */
export function sourceEntryReference(reader: Pick<HistoryReader, "getEntryMetadata">, entry: SessionEntry) {
  return reader.getEntryMetadata(entry.id) ?? entry;
}

/** Walk only as far as a reverse lookup needs. */
export function* reverseBranchEntryReferences(
  reader: Pick<HistoryReader, "getLeafId" | "getEntryMetadata">,
): IterableIterator<SessionEntryReference> {
  let id = reader.getLeafId();
  while (id) {
    const entry = reader.getEntryMetadata(id);
    if (!entry) return;
    yield entry;
    id = entry.parentId;
  }
}

/** Filter before decoding bodies; one-pass scans can bypass cache admission without discarding cache hits. */
export function* readHistoryEntries(
  reader: HistoryReader,
  scope: "branch" | "session",
  select: (entry: SessionEntryReference) => boolean,
  options?: { cacheAdmission: "bypass" },
): IterableIterator<SessionEntry> {
  const references = scope === "branch" ? reader.getBranchMetadata() : reader.getEntriesMetadata();
  for (const reference of references) {
    if (!select(reference)) continue;
    const entry = options?.cacheAdmission === "bypass" ? reader.getEntryForScan(reference.id) : reader.getEntry(reference.id);
    if (!entry) throw new Error(`Session entry not found: ${reference.id}`);
    yield entry;
  }
}
