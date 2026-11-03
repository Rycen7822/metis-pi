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

/** Filter before loading bodies. Required old state is read in full, never replaced with placeholders. */
export function* readHistoryEntries(
  reader: HistoryReader,
  scope: HistoryScope,
  select: (entry: SessionEntryReference) => boolean,
): IterableIterator<SessionEntry> {
  const metadata = scope === "branch" ? reader.getBranchMetadata : reader.getEntriesMetadata;
  if (!metadata) {
    const entries = scope === "branch" ? reader.getBranch() : reader.getEntries();
    for (const entry of entries) if (select(entry)) yield entry;
    return;
  }
  for (const reference of metadata.call(reader)) {
    if (!select(reference)) continue;
    const entry = reader.getEntry(reference.id);
    if (!entry) throw new Error(`Session entry not found: ${reference.id}`);
    yield entry;
  }
}
