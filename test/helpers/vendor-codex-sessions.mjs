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
