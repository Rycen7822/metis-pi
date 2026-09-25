// Offline session/entry fixtures shared by the vendored Codex compaction tests.
//
// These build the Pi 0.86 entry shapes the adapter replays: a session head that declares the
// initial tools, later system messages that carry tool/prompt deltas, and a native compaction
// checkpoint whose stored `systemMessage` is the replayed prompt/tool state. The checkpoint
// window below is a handmade offline stand-in, never a real server-side encrypted window.
import assert from "node:assert/strict";

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

const messageEntry = (id, parentId, message) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(message.timestamp).toISOString(),
	message,
});

/** Link messages with deterministic, branch-local ids. */
function linkFrom(parentId, messages) {
	let previous = parentId;
	return messages.map((message, index) => {
		const entry = messageEntry(`${parentId}-${index}`, previous, message);
		previous = entry.id;
		return entry;
	});
}

/**
 * Session with a native checkpoint: `head` declares the initial tools, `kept` stands in for
 * entries before the checkpoint, `tail` follows it. `checkpointSystemMessage` is what Pi stores
 * as the replayed prompt/tool state at compaction time.
 */
export function checkpointSession({ model, kept = [], tail, checkpointSystemMessage }) {
	const head = messageEntry("head", null, systemMessage("BASE_PROMPT", 0, { toolsAdded: [tool("tool_alpha")] }));
	const pre = messageEntry("pre", "head", userMessage("pre-kept", 1));
	const keptEntries = linkFrom("pre", kept);
	const lastKept = keptEntries.length > 0 ? keptEntries[keptEntries.length - 1].id : "pre";
	const compaction = {
		type: "compaction",
		id: "compact",
		parentId: lastKept,
		timestamp: new Date(4).toISOString(),
		summary: "[OpenAI native compaction checkpoint]",
		firstKeptEntryId: "pre",
		tokensBefore: 100,
		systemMessage: checkpointSystemMessage ?? systemMessage("BASE_PROMPT", 4, { toolsAdded: [tool("tool_alpha")] }),
		details: checkpointDetails(model),
	};
	const tailEntries = linkFrom("compact", tail);
	const entries = [head, pre, ...keptEntries, compaction, ...tailEntries];
	return { entries, compaction, tailEntries, leafId: entries[entries.length - 1].id };
}

/** A checkpoint-free session: `head` plus messages linked in order. */
export function session({ headTools = [tool("tool_alpha")], messages }) {
	const head = messageEntry("head", null, systemMessage("BASE_PROMPT", 0, { toolsAdded: headTools }));
	const entries = [head, ...linkFrom("head", messages)];
	return { entries, leafId: entries[entries.length - 1].id };
}

/** `latestNativeCompaction` argument for `buildNativeCompactionInput`. */
export function latestCheckpointFor(entries, compaction) {
	const index = entries.findIndex((entry) => entry.id === compaction.id);
	assert.ok(index >= 0, "the checkpoint entry must be part of the branch");
	return { ok: true, index, entry: compaction };
}
