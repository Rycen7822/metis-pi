import type { CapturedBatch, SummaryDetails, SummaryMember, SummaryToolCallRef } from "./types.ts";
import { occKey, resultTimestampOf } from "./occurrence-key.ts";

export type { SummaryToolCallRef } from "./types.ts";

export interface SummaryMessageDetailsLike {
  toolCallRefs?: SummaryToolCallRef[];
  toolCallIds?: string[];
}

const SHORT_ID_PREFIX = "t";

export function buildShortToolCallRefs(
  calls: { toolCallId: string; resultTimestamp?: number }[],
  startIndex: number,
): { refs: SummaryToolCallRef[]; nextIndex: number } {
  const refs = calls.map((call, offset) => ({
    shortId: `${SHORT_ID_PREFIX}${startIndex + offset}`,
    toolCallId: call.toolCallId,
    ...(call.resultTimestamp !== undefined ? { resultTimestamp: call.resultTimestamp } : {}),
  }));
  return { refs, nextIndex: startIndex + refs.length };
}

export function normalizeSummaryToolCallRefs(details: unknown): SummaryToolCallRef[] {
  if (!details || typeof details !== "object") return [];

  const raw = details as SummaryMessageDetailsLike;
  if (Array.isArray(raw.toolCallRefs)) {
    return raw.toolCallRefs
      .filter(
        (ref): ref is SummaryToolCallRef =>
          !!ref && typeof ref.shortId === "string" && typeof ref.toolCallId === "string",
      )
      .map((ref) => {
        const resultTimestamp = resultTimestampOf((ref as any).resultTimestamp);
        return {
          shortId: ref.shortId,
          toolCallId: ref.toolCallId,
          ...(resultTimestamp !== undefined ? { resultTimestamp } : {}),
        };
      });
  }

  if (Array.isArray(raw.toolCallIds)) {
    return raw.toolCallIds.filter((id): id is string => typeof id === "string").map((id) => ({ shortId: id, toolCallId: id }));
  }

  return [];
}

export function formatSummaryToolCallRefs(refs: SummaryToolCallRef[]): string {
  const refList = refs.map((ref) => `\`${ref.shortId}\``).join(", ");
  return (
    `\n\n---\n**Summarized tool refs**: ${refList}\n` +
    `Use \`context_tree_query\` with these refs to retrieve the original full outputs.`
  );
}

export function makeSummaryDetails(batch: CapturedBatch, refs: SummaryToolCallRef[]): SummaryDetails {
  return {
    toolCallRefs: refs,
    toolNames: batch.toolCalls.map((tc) => tc.toolName),
    turnIndex: batch.turnIndex,
    timestamp: batch.timestamp,
  };
}

export interface SummaryMessage {
  content: string;
  details: SummaryDetails;
}

const table = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function groupRefs(value: unknown): SummaryToolCallRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return;
  const refs: SummaryToolCallRef[] = [];
  for (const ref of value) {
    if (!table(ref) || typeof ref.shortId !== "string" || !ref.shortId || typeof ref.toolCallId !== "string" || !ref.toolCallId
      || (ref.resultTimestamp !== undefined && !finite(ref.resultTimestamp))) return;
    refs.push({ shortId: ref.shortId, toolCallId: ref.toolCallId,
      ...(ref.resultTimestamp !== undefined ? { resultTimestamp: ref.resultTimestamp } : {}) });
  }
  return refs;
}

/** Decode only complete, disjoint member ownership; malformed metadata remains one unsplittable legacy body. */
export function summaryGroupMembers(message: { content?: unknown; details?: unknown }): SummaryMember[] | undefined {
  const details = message.details, content = message.content;
  if (!table(details) || typeof content !== "string" || !Array.isArray(details.members) || !details.members.length) return;
  const refs = groupRefs(details.toolCallRefs);
  if (!refs) return;
  const declared = new Map(refs.map(ref => [occKey(ref.toolCallId, ref.resultTimestamp), ref.shortId]));
  if (declared.size !== refs.length || new Set(refs.map(ref => ref.shortId)).size !== refs.length) return;
  const owned = new Set<string>(), members: SummaryMember[] = [];
  let cursor = 0;
  for (const member of details.members) {
    if (!table(member) || !Number.isSafeInteger(member.bodyStart) || !Number.isSafeInteger(member.bodyEnd)
      || !finite(member.bodyStart) || !finite(member.bodyEnd) || member.bodyStart !== cursor
      || member.bodyEnd <= member.bodyStart || member.bodyEnd > content.length) return;
    const own = groupRefs(member.toolCallRefs);
    if (!own || !content.slice(member.bodyStart, member.bodyEnd).trim()) return;
    for (const ref of own) {
      const key = occKey(ref.toolCallId, ref.resultTimestamp);
      if (owned.has(key) || declared.get(key) !== ref.shortId) return;
      owned.add(key);
    }
    members.push({ toolCallRefs: own, bodyStart: member.bodyStart, bodyEnd: member.bodyEnd });
    cursor = member.bodyEnd + 2;
    if (member !== details.members.at(-1) && content.slice(member.bodyEnd, cursor) !== "\n\n") return;
  }
  return owned.size === declared.size && cursor - 2 === content.length ? members : undefined;
}

/** One content payload; member spans carry ownership without duplicating the text in session metadata. */
export function combineSummaryMessages(summaries: readonly SummaryMessage[]): SummaryMessage {
  const first = summaries[0];
  if (!first) throw new Error("Cannot combine an empty summary group");
  const members: SummaryMember[] = [];
  let cursor = 0;
  for (const summary of summaries) {
    members.push({ toolCallRefs: summary.details.toolCallRefs, bodyStart: cursor, bodyEnd: cursor + summary.content.length });
    cursor += summary.content.length + 2;
  }
  return { content: summaries.map(summary => summary.content).join("\n\n"), details: { ...first.details,
    toolCallRefs: summaries.flatMap(summary => summary.details.toolCallRefs),
    toolNames: summaries.flatMap(summary => summary.details.toolNames), members } };
}

/** undefined = legacy; null = fully consumed. Never split a member whose other refs still survive. */
export function retainSummaryGroup(
  message: { content?: unknown; details?: unknown }, keepRef: (ref: SummaryToolCallRef) => boolean,
): { content: string; details: Record<string, unknown> } | null | undefined {
  const members = summaryGroupMembers(message);
  if (!members || typeof message.content !== "string" || !table(message.details)) return;
  const retained = members.filter(member => member.toolCallRefs.some(keepRef));
  if (!retained.length) return null;
  if (retained.length === members.length) return { content: message.content, details: message.details };
  const refs = retained.flatMap(member => member.toolCallRefs), toolNames = message.details.toolNames;
  const names = Array.isArray(toolNames) ? new Map(normalizeSummaryToolCallRefs(message.details)
    .map((ref, index) => [ref.shortId, toolNames[index]])) : undefined;
  const content = message.content;
  let cursor = 0;
  const spans = retained.map(member => {
    const length = member.bodyEnd - member.bodyStart;
    const span = { ...member, bodyStart: cursor, bodyEnd: cursor + length };
    cursor += length + 2;
    return span;
  });
  return { content: retained.map(member => content.slice(member.bodyStart, member.bodyEnd)).join("\n\n"),
    details: { ...message.details, toolCallRefs: refs, members: spans,
      ...(names ? { toolNames: refs.map(ref => names.get(ref.shortId)) } : {}) } };
}

/**
 * Rewrites line-leading `[[N:name]]` labels emitted by the summarizer into
 * inline `` `tN` `` refs. `refs` and `toolNames` are positionally aligned to
 * the batch's tool-call order. The echoed name is validated against the tool
 * at position N; a mismatch or out-of-range N strips the label (footer-only).
 * A catch-all strip pass on non-fenced lines removes any surviving well-formed
 * label token (wrapped, numbered, or blockquoted) so no raw `[[N:name]]` token
 * ever leaks into context; fenced code blocks remain exempt.
 */
export function substituteInlineRefs(
  text: string,
  refs: SummaryToolCallRef[],
  toolNames: string[],
): string {
  const LABEL = /^(\s*(?:[-*]\s+)?)\[\[(\d+):([^\]\n]+)\]\]\s*/;
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = lines[i].replace(LABEL, (_m, prefix: string, numStr: string, name: string) => {
      const n = Number(numStr);
      const ref = refs[n - 1];
      const expected = toolNames[n - 1];
      if (!ref || expected === undefined) return prefix;
      if (name.trim().toLowerCase() !== expected.trim().toLowerCase()) return prefix;
      return `${prefix}\`${ref.shortId}\` `;
    });
    lines[i] = lines[i].replace(/\[\[\d+:[^\]\n]+\]\]\s*/g, "");
  }
  return lines.join("\n");
}
