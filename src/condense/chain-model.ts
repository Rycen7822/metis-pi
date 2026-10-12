import type { ChainCompressionEntry, SharedChainCompressionEntry, SingleChainCompressionEntry } from "./types.ts";

export function isSharedChain(entry: ChainCompressionEntry): entry is SharedChainCompressionEntry {
  return "kind" in entry && entry.kind === "shared-v1";
}

/** Temporary render views; the durable shared body is stored only once. */
export function chainMembers(entry: ChainCompressionEntry): SingleChainCompressionEntry[] {
  return isSharedChain(entry) ? entry.members.map(member => ({ ...member,
    blockId: entry.blockId, compressedAt: entry.compressedAt,
    rangeSummaryText: entry.bodyText.slice(member.bodyStart, member.bodyEnd) })) : [entry];
}
