import type { Api, AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { parseStreamingJson, processResponsesStream as processNativeStream } from "../host-api.ts";
import { encodeTextSignatureV1 } from "./signatures.ts";
import { sanitizeImageGenerationCallItem, sanitizeWebSearchCallItem } from "./native-items.ts";
import type { OpenAIResponsesStreamOptions } from "./shared.ts";

type ProseBlock = Extract<AssistantMessage["content"][number], { type: "text" | "thinking" }>;
type Prose = { index: number; block: ProseBlock; parts: Map<number, { type: string; text: string }> };
type PendingTool = { index: number; type: "function_call" | "custom_tool_call"; input: string };

export async function processResponsesStream<TApi extends Api>(
	input: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	// Indexed prose and raw history are local; Pi owns streamed tool arguments and usage.
	const prose = new Map<number, Prose>();
	const pending = new Map<number, PendingTool>();
	let exhausted = false;
	let terminal = false;
	const startProse = (index: number, type: "message" | "reasoning"): Prose => {
		const block: ProseBlock = type === "message" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
		const state = { index: output.content.length, block, parts: new Map() };
		output.content.push(block);
		prose.set(index, state);
		stream.push({
			type: type === "message" ? "text_start" : "thinking_start", contentIndex: state.index, partial: output,
		});
		return state;
	};
	const updateProse = (state: Prose, notify: boolean) => {
		const { block } = state;
		const previous = block.type === "text" ? block.text : block.thinking;
		const next = [...state.parts].sort(([a], [b]) => a - b)
			.map(([, p]) => p.text).join(block.type === "text" ? "" : "\n\n");
		if (block.type === "text") block.text = next;
		else block.thinking = next;
		if (notify && next.startsWith(previous) && next.length > previous.length) {
			stream.push({
				type: block.type === "text" ? "text_delta" : "thinking_delta", contentIndex: state.index,
				delta: next.slice(previous.length), partial: output,
			});
		}
	};
	async function* adapt(): AsyncGenerator<ResponseStreamEvent> {
		try {
			for await (const event of input) {
				const state = "output_index" in event ? prose.get(event.output_index) : undefined;
				const tool = "output_index" in event ? pending.get(event.output_index) : undefined;
				if (event.type === "response.output_item.added") {
					const item = event.item;
					if (item.type === "message" || item.type === "reasoning") {
						startProse(event.output_index, item.type);
						continue;
					}
					if (item.type === "function_call" || item.type === "custom_tool_call") {
						pending.set(event.output_index, {
							index: output.content.length, type: item.type,
							input: item.type === "function_call" ? item.arguments || "" : item.input ?? "",
						});
						if (item.type === "custom_tool_call") {
							yield { ...event, item: { ...item, id: item.id ?? "" } };
							continue;
						}
					}
				} else if (event.type === "response.content_part.added") {
					if (state?.block.type === "text" && (event.part.type === "output_text" || event.part.type === "refusal")) {
						state.parts.set(event.content_index, {
							type: event.part.type, text: event.part.type === "output_text" ? event.part.text : event.part.refusal,
						});
					}
					continue;
				} else if (
					event.type === "response.reasoning_summary_part.added" || event.type === "response.reasoning_summary_part.done"
				) {
					if (state?.block.type === "thinking") {
						state.parts.set(event.summary_index, { type: "summary_text", text: event.part.text });
						if (event.type.endsWith(".done")) updateProse(state, false);
					}
					continue;
				} else if (
					event.type === "response.output_text.delta" || event.type === "response.refusal.delta" ||
					event.type === "response.reasoning_summary_text.delta"
				) {
					const type = event.type === "response.reasoning_summary_text.delta" ? "summary_text"
						: event.type === "response.output_text.delta" ? "output_text" : "refusal";
					if (state && (state.block.type === "thinking") === (type === "summary_text")) {
						const index = "summary_index" in event ? event.summary_index : event.content_index;
						const part = state.parts.get(index) ?? { type, text: "" };
						if (part.type === type) {
							part.text += event.delta;
							state.parts.set(index, part);
							updateProse(state, true);
						}
					}
					continue;
				} else if (
					event.type === "response.function_call_arguments.delta" || event.type === "response.custom_tool_call_input.delta"
				) {
					const type = event.type === "response.function_call_arguments.delta" ? "function_call" : "custom_tool_call";
					if (tool?.type === type) tool.input += event.delta;
				} else if (event.type === "response.function_call_arguments.done") {
					if (tool?.type === "function_call") tool.input = event.arguments;
				} else if (event.type === "response.custom_tool_call_input.done") {
					if (tool?.type === "custom_tool_call") tool.input = event.input;
				} else if (event.type === "response.output_item.done") {
					let item = event.item;
					if (item.type === "custom_tool_call") {
						item = { ...item, input: item.input ?? (tool?.type === "custom_tool_call" ? tool.input : "") };
					}
					options?.onOutputItemDone?.(item);
					if (item.type === "message" || item.type === "reasoning") {
						const current = state?.block.type === (item.type === "message" ? "text" : "thinking")
							? state : startProse(event.output_index, item.type);
						if (item.type === "message" && current.block.type === "text") {
							current.block.text = item.content.map(c => c.type === "output_text" ? c.text : c.refusal).join("");
							current.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
							stream.push({
								type: "text_end", contentIndex: current.index, content: current.block.text, partial: output,
							});
						} else if (item.type === "reasoning" && current.block.type === "thinking") {
							current.block.thinking = item.summary?.map(s => s.text).join("\n\n") || "";
							current.block.thinkingSignature = JSON.stringify(item);
							stream.push({
								type: "thinking_end", contentIndex: current.index, content: current.block.thinking, partial: output,
							});
						}
						prose.delete(event.output_index);
						continue;
					}
					if ((item.type === "function_call" || item.type === "custom_tool_call") && !tool) {
						// Completion-only items start with final arguments and have no synthetic delta.
						const block: ToolCall = {
							type: "toolCall", id: `${item.call_id}|${item.id ?? ""}`, name: item.name,
							arguments: item.type === "function_call" ? parseStreamingJson(item.arguments || "{}")
								: { [options?.grammarToolInputProperties?.get(item.name) ?? "input"]: item.input ?? "" },
							...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
						};
						const contentIndex = output.content.length;
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
					} else if (item.type === "image_generation_call" || item.type === "web_search_call") {
						const clean = item.type === "image_generation_call"
							? sanitizeImageGenerationCallItem(item) : sanitizeWebSearchCallItem(item);
						if (clean) (output.content as unknown[]).push({ type: item.type, item: clean });
					} else {
						if (item.type === "function_call" && tool?.type === "function_call") {
							item = { ...item, arguments: tool.input || item.arguments };
						}
						if (item.type === "custom_tool_call") item = { ...item, id: item.id ?? "" };
						yield { ...event, item };
					}
					pending.delete(event.output_index);
					continue;
				} else if (event.type === "response.completed" || event.type === "response.incomplete") {
					terminal = true;
					const previousRaw = output.rawStopReason;
					yield { ...event, response: event.response ?? {} } as ResponseStreamEvent;
					if (!event.response?.status || event.response.status === "in_progress" || event.response.status === "queued") {
						output.stopReason = "pending";
					}
					if (output.rawStopReason === undefined) {
						if (previousRaw === undefined) delete output.rawStopReason;
						else output.rawStopReason = previousRaw;
					}
					continue;
				} else if (event.type === "error") {
					throw new Error([event.code, event.message].filter(Boolean).join(": ") || "Unknown error");
				} else if (event.type === "response.failed") {
					const error = event.response?.error;
					const reason = event.response?.incomplete_details?.reason;
					throw new Error(error ? `${error.code || "unknown"}: ${error.message || "no message"}`
						: reason ? `incomplete: ${reason}` : "Unknown error (no error details in response)");
				}
				yield event;
			}
		} finally {
			// Only completed calls can survive EOF, cancellation or a consumer/source error.
			for (const { index } of [...pending.values()].sort((a, b) => b.index - a.index)) output.content.splice(index, 1);
		}
		exhausted = true;
	}
	try {
		// The two OpenAI SDK versions type error codes/service tiers differently;
		// the native parser forwards those fields without narrowing their values.
		await processNativeStream(
			adapt() as Parameters<typeof processNativeStream>[0], output, stream, model,
			options as Parameters<typeof processNativeStream>[4],
		);
	} catch (error) {
		// At a clean EOF the caller owns pending/retry classification. Source or callback failures propagate.
		if (!exhausted || terminal) throw error;
	}
}
