import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Insert selected reconstructed messages around surviving messages without rewriting them. */
export function insertReconstructedMessages(
	messages: readonly AgentMessage[],
	reconstructed: readonly AgentMessage[],
	messageKey: (message: AgentMessage) => string,
	shouldInsert: (message: AgentMessage, key: string) => boolean,
): AgentMessage[] {
	const positions = new Map<string, number[]>();
	messages.forEach((message, index) => {
		const key = messageKey(message);
		const indices = positions.get(key) ?? [];
		indices.push(index);
		positions.set(key, indices);
	});
	const insertions = new Map<number, AgentMessage[]>();
	let pending: AgentMessage[] = [];
	let last = -1;
	for (const message of reconstructed) {
		const key = messageKey(message);
		const index = positions.get(key)?.shift();
		if (index !== undefined) {
			if (pending.length) insertions.set(index, [...(insertions.get(index) ?? []), ...pending]);
			pending = [];
			last = index;
		} else if (shouldInsert(message, key)) pending.push(message);
	}
	if (pending.length) insertions.set(last + 1, [...(insertions.get(last + 1) ?? []), ...pending]);
	return messages.flatMap((message, index) => [...(insertions.get(index) ?? []), message])
		.concat(insertions.get(messages.length) ?? []);
}
