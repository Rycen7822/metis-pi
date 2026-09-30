import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CODEX_REASONING_UPDATE_TYPE, readCodexReasoningUpdate } from "../providers/reasoning-updates.ts";
import { insertReconstructedMessages } from "../context/history-insertion.ts";

export function projectCodexReasoningEntry(entry: SessionEntry): SessionEntry {
	if (entry.type !== "custom" || entry.customType !== CODEX_REASONING_UPDATE_TYPE) return entry;
	const update = readCodexReasoningUpdate(entry.data);
	return { ...entry, type: "custom_message", content: `Reasoning effort: ${update.effort}`, display: false, details: update };
}

/** Rehydrate bookkeeping only in model context; leave Pi's tree and stored entries intact. */
export function projectCodexReasoningHistory(
	entries: readonly SessionEntry[],
	messages?: readonly AgentMessage[],
	leafId?: string | null,
): AgentMessage[] {
	const retired = new Set<string>();
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let ancestor = leafId === null ? undefined : leafId ? byId.get(leafId) : entries.at(-1);
	let compacted = false;
	while (ancestor) {
		if (ancestor.type === "compaction") compacted = true;
		if (compacted && (ancestor.type === "custom" || ancestor.type === "custom_message") && ancestor.customType === CODEX_REASONING_UPDATE_TYPE)
			retired.add(readCodexReasoningUpdate(ancestor.type === "custom" ? ancestor.data : ancestor.details).id);
		ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
	}
	const survives = (message: AgentMessage) => message.role !== "custom" || message.customType !== CODEX_REASONING_UPDATE_TYPE
		|| !retired.has(readCodexReasoningUpdate(message.details).id);
	// Pi can retain pre-compaction messages. Retire only their reasoning bookkeeping,
	// without changing saved entries or another extension's message transformations.
	messages = messages?.filter(survives);
	const virtualIds = new Set<string>();
	const projectedEntries = entries.map((entry): SessionEntry => {
		const projected = projectCodexReasoningEntry(entry);
		if (projected !== entry && projected.type === "custom_message" && !retired.has(readCodexReasoningUpdate(projected.details).id)) virtualIds.add(readCodexReasoningUpdate(projected.details).id);
		return projected;
	});
	if (messages && virtualIds.size === 0) return [...messages];
	const reconstructed = buildSessionContext(projectedEntries, leafId).messages.filter(survives);
	if (!messages) return reconstructed;
	// Preserve other extensions' message edits and additions. Insert metadata at its
	// persisted position, before the next surviving message or after the final one.
	return insertReconstructedMessages(messages, reconstructed, messageKey,
		(message) => message.role === "custom" && message.customType === CODEX_REASONING_UPDATE_TYPE
			&& virtualIds.has(readCodexReasoningUpdate(message.details).id));
}

function messageKey(message: AgentMessage): string {
	return JSON.stringify([message.role, message.timestamp,
		message.role === "custom" ? (message.customType === CODEX_REASONING_UPDATE_TYPE
			? readCodexReasoningUpdate(message.details).id : message.customType)
			: message.role === "toolResult" ? message.toolCallId : undefined]);
}
