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

export const systemMessage = (content, timestamp, extra = {}) => ({ role: "system", content, timestamp, ...extra });
export const userMessage = (text, timestamp) => ({ role: "user", content: text, timestamp });

export const messageEntry = (id, parentId, message) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(message.timestamp).toISOString(),
	message,
});

/** Link message entries after `parentId`; each spec is `[id, message]`. */
export function linkFrom(parentId, specs) {
	const entries = [];
	let previous = parentId;
	for (const [id, message] of specs) {
		entries.push(messageEntry(id, previous, message));
		previous = id;
	}
	return entries;
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
		details: {
			strategy: "openai-responses-compaction-v2",
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: model.baseUrl,
			createdAt: new Date(4).toISOString(),
			compactedWindow: [SEALED_WINDOW_ITEM],
		},
	};
	const tailEntries = linkFrom("compact", tail);
	const entries = [head, pre, ...keptEntries, compaction, ...tailEntries];
	return { entries, compaction, preEntries: [head, pre, ...keptEntries], tailEntries, leafId: entries[entries.length - 1].id };
}

/** A checkpoint-free session: `head` plus the message specs, linked in order. */
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
