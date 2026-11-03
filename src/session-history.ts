import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type MessageRole = Extract<SessionEntry, { type: "message" }>["message"]["role"];
type DetailedReferenceType = "message" | "custom" | "custom_message" | "context_edit" | "model_change";

/** Selection facts only: callers must load a complete entry before reading its body. */
export type SessionEntryReference = Pick<SessionEntry, "id" | "parentId" | "timestamp"> & (
  | { type: "message"; message: { role: MessageRole } }
  | { type: "custom" | "custom_message"; customType: string }
  | Pick<Extract<SessionEntry, { type: "context_edit" }>, "type" | "targetId">
  | Pick<Extract<SessionEntry, { type: "model_change" }>, "type" | "provider" | "modelId">
  | { type: Exclude<SessionEntry["type"], DetailedReferenceType> | "unknown" }
);

interface HistoryReader extends Pick<ExtensionContext["sessionManager"], "getBranch" | "getEntries" | "getEntry"> {
  getEntryForScan?(id: string): SessionEntry | undefined;
  getBranchMetadata?(): SessionEntryReference[];
  getEntriesMetadata?(): SessionEntryReference[];
  getEntryMetadata?(id: string): SessionEntryReference | undefined;
}

type HistoryScope = "branch" | "session";

/** Stock Pi keeps the eager path; the explicit SDK patch supplies body-free branch facts. */
export function branchEntryReferences(
  reader: Pick<HistoryReader, "getBranch" | "getBranchMetadata">,
): SessionEntryReference[] {
  return reader.getBranchMetadata?.() ?? reader.getBranch();
}

/** Stable immutable source identity without retaining a decoded body on the patched SDK. */
export function sourceEntryReference(
  reader: Pick<HistoryReader, "getEntry" | "getEntryMetadata">,
  entry: SessionEntry,
): SessionEntryReference {
  return reader.getEntryMetadata?.(entry.id) ?? entry;
}

/** Walk only as far as a reverse lookup needs; stock Pi uses the same parent walk with complete entries. */
export function* reverseBranchEntryReferences(
  reader: Pick<ExtensionContext["sessionManager"], "getLeafId" | "getEntry"> & Pick<HistoryReader, "getEntryMetadata">,
): IterableIterator<SessionEntryReference> {
  let id = reader.getLeafId();
  while (id) {
    const entry = reader.getEntryMetadata ? reader.getEntryMetadata(id) : reader.getEntry(id);
    if (!entry) return;
    yield entry;
    id = entry.parentId;
  }
}

/** Appearance accepts an unknown host shape and validates the returned usage records itself. */
export function sessionEntryFacts(reader: {
  getEntries?(): unknown[];
  getEntriesMetadata?(): unknown[];
}): unknown[] {
  return reader.getEntriesMetadata?.() ?? reader.getEntries?.() ?? [];
}

/**
 * Filter before loading complete bodies. One-pass scans can skip cache admission on supporting hosts;
 * cache hits and older-host reads retain their normal semantics. Never substitute placeholders.
 */
export function* readHistoryEntries(
  reader: HistoryReader,
  scope: HistoryScope,
  select: (entry: SessionEntryReference) => boolean,
  options?: { cacheAdmission: "bypass" },
): IterableIterator<SessionEntry> {
  const metadata = scope === "branch" ? reader.getBranchMetadata : reader.getEntriesMetadata;
  if (!metadata) {
    const entries = scope === "branch" ? reader.getBranch() : reader.getEntries();
    for (const entry of entries) if (select(entry)) yield entry;
    return;
  }
  const readEntry = options?.cacheAdmission === "bypass" && reader.getEntryForScan ? reader.getEntryForScan : reader.getEntry;
  for (const reference of metadata.call(reader)) {
    if (!select(reference)) continue;
    const entry = readEntry.call(reader, reference.id);
    if (!entry) throw new Error(`Session entry not found: ${reference.id}`);
    yield entry;
  }
}
