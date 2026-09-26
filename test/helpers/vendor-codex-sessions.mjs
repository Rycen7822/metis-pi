// Offline transcripts use Pi's in-memory session: Pi owns ids, branches and checkpoint snapshots.
// The sealed window is handmade test data, never real encrypted conversation content.
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const SEALED_WINDOW_ITEM = { type: "compaction_summary", encrypted_content: "offline-sealed-fixture" };

export const tool = (name, description = `${name} description`) => ({
	name,
	description,
	parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
});

export const systemMessage = (content, timestamp = 0, extra = {}) => ({ role: "system", content, timestamp, ...extra });
export const userMessage = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });
export const assistantToolCall = (model, id, name, args = { value: "x" }) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	provider: model.provider, api: model.api, model: model.id,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
	stopReason: "toolUse", timestamp: 2,
});
export const toolResult = (toolCallId, toolName, text, timestamp = 3) => ({
	role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], timestamp,
});

export const checkpointDetails = (model, compactedWindow = [SEALED_WINDOW_ITEM]) => ({
	strategy: "openai-responses-compaction-v2",
	provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl,
	createdAt: new Date(4).toISOString(), compactedWindow,
});

/** Construct a transcript; tests append edits through the returned real session manager. */
export function session({ headTools = [tool("tool_alpha")], messages = [] } = {}) {
	const sm = SessionManager.inMemory("/tmp/offline-codex-session");
	sm.appendMessage(systemMessage("BASE_PROMPT", 0, { toolsAdded: headTools }));
	for (const message of messages) sm.appendMessage(message);
	return { sm };
}

/** Explicit pre-checkpoint and live-tail data, with ids for tests that edit either region. */
export function checkpointSession({ model, kept = [], tail = [], retainNone = false, checkpointSystemMessage }) {
	const { sm } = session();
	const preId = sm.appendMessage(userMessage("pre-kept", 1));
	const keptIds = kept.map((message) => sm.appendMessage(message));
	const compactionId = sm.appendCompaction("[OpenAI native compaction checkpoint]",
		retainNone ? null : preId, 100, checkpointDetails(model));
	// Historical stored snapshots are deliberate compatibility inputs, not a second projection engine.
	if (checkpointSystemMessage) sm.getEntry(compactionId).systemMessage = checkpointSystemMessage;
	const tailIds = tail.map((message) => sm.appendMessage(message));
	return { sm, preId, keptIds, compactionId, tailIds };
}

/** `latestNativeCompaction` argument for `buildNativeCompactionInput`. */
export function latestCheckpointFor(entries, compaction) {
	const index = entries.findIndex((entry) => entry.id === compaction.id);
	assert.ok(index >= 0, "the checkpoint entry must be part of the branch");
	return { ok: true, index, entry: compaction };
}
