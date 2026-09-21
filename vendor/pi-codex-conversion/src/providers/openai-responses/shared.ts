import type { Api, Context, Model, SystemMessage, Tool, Usage } from "@earendil-works/pi-ai";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputItem,
	ResponseToolSearchOutputItemParam,
	Tool as OpenAITool,
} from "openai/resources/responses/responses.js";
import {
	getJsonSchemaToolParameters,
	getGrammarToolInput,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "../constrained-sampling.js";
import { parseTextSignature, shortHash } from "./signatures.ts";
import { normalizeResponsesToolHistory } from "./tool-history.ts";
import { normalizeResponsesMessageHistory } from "./message-history.ts";
import { encryptedToolOutputFromDetails, imageDetailForResponses, isImageGenerationCallBlock, isWebSearchCallBlock, sanitizeImageGenerationCallItem, sanitizeWebSearchCallItem, type ImageDetail, type ImageGenerationCallBlock, type WebSearchCallBlock } from "./native-items.ts";
import { unrouteContextNamespaceToolCall } from "../../context-management/namespace-tools.ts";
import {
	getAnchoredToolAdditions,
	getInitialSystemMessage,
	getSystemMessageText,
	legacyAddedToolNames,
	normalizeProviderContext,
	renderSystemMessageUpdate,
	resolveTranscript,
	resolveTranscriptTools,
	type TranscriptMessages,
} from "../transcript.ts";

type Message = Context["messages"][number];

type InternalAssistantContent = Extract<Message, { role: "assistant" }>["content"][number] | ImageGenerationCallBlock | WebSearchCallBlock;
type ImageContentWithDetail = { type: "image"; data: string; mimeType: string; detail?: ImageDetail | undefined };

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"] | undefined;
	grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (usage: Usage, serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined) => void;
	onOutputItemDone?: (item: unknown) => void;
}

interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean | undefined;
	grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
	deferredTools?: ReadonlyMap<string, Tool> | undefined;
	deferredToolsMode?: "additional-tools" | "tool-search" | undefined;
	/** Placement from `splitDeferredTools`: later system messages declare their additions in place. */
	anchorsToolAdditions?: boolean | undefined;
	/** Model accepts system/developer messages in the middle of the transcript. */
	supportsMidConvoSystemMessages?: boolean | undefined;
	/**
	 * Whether `context.messages` starts at the transcript head. Slices that continue a longer
	 * transcript pass false so a leading update is replayed in place instead of being dropped
	 * as the global prompt.
	 */
	startsAtTranscriptHead?: boolean | undefined;
	toolOptions?: ConvertResponsesToolsOptions | undefined;
}

interface ConvertResponsesToolsOptions {
	strict?: boolean | null | undefined;
	supportsStrictMode?: boolean | undefined;
	supportsOpenAIGrammarTools?: boolean | undefined;
	deferLoading?: boolean | undefined;
}

export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export type ResponsesToolDeclarationMode = "additional-tools" | "tool-search";

/** Model capabilities that decide how a transcript is replayed on the wire. */
export interface ResponsesTranscriptSemantics {
	/** The model accepts system/developer messages between turns. */
	supportsMidConvoSystemMessages: boolean;
	/** How tools declared after the first turn travel; `undefined` when the model has no in-place additions. */
	deferredToolsMode: ResponsesToolDeclarationMode | undefined;
	supportsStrictMode: boolean;
}

/**
 * Read the transcript semantics a model declares. Every provider-facing path (normal request,
 * compaction serializer, native replay) resolves them here, so the same transcript is replayed
 * the same way and no caller re-invents a second, independent decision.
 */
export function resolveResponsesTranscriptSemantics(model: Model<Api>): ResponsesTranscriptSemantics {
	const compat = model.compat as {
		supportsStrictMode?: boolean | undefined;
		supportsAdditionalTools?: boolean | undefined;
		supportsToolSearch?: boolean | undefined;
		supportsMidConvoSystemMessages?: boolean | undefined;
	} | undefined;
	return {
		supportsStrictMode: compat?.supportsStrictMode ?? true,
		supportsMidConvoSystemMessages: compat?.supportsMidConvoSystemMessages === true,
		deferredToolsMode: compat?.supportsAdditionalTools === true
			? "additional-tools"
			: compat?.supportsToolSearch === true
				? "tool-search"
				: undefined,
	};
}

/**
 * Whether the resolved transcript starts at its head: collapsing synthesizes a leading system
 * message, so a collapsed continuation does start at a head even when the caller passed a slice.
 */
function transcriptHeadIncluded(semantics: ResponsesTranscriptSemantics, startsAtTranscriptHead: boolean | undefined): boolean {
	return !(semantics.supportsMidConvoSystemMessages && startsAtTranscriptHead === false);
}

/**
 * The single tool placement decision for `messages`: which tools the request declares at the top
 * level and which ones its later system messages announce in place. Callers that serialize slices
 * of an already decided transcript pass the result on instead of asking again. Agent-level entries
 * are accepted: the decision only reads system messages and tool declarations.
 */
export function resolveToolPlacement<TApi extends Api>(
	model: Model<TApi>,
	messages: TranscriptMessages,
	startsAtTranscriptHead = true,
): DeferredToolPlacement {
	const semantics = resolveResponsesTranscriptSemantics(model);
	return splitDeferredTools(
		resolveTranscript(
			normalizeProviderContext({ messages } as unknown as Context),
			semantics.supportsMidConvoSystemMessages,
		),
		semantics.deferredToolsMode !== undefined,
		transcriptHeadIncluded(semantics, startsAtTranscriptHead),
	);
}

/** Everything a provider-facing path needs to replay one transcript. */
export interface PreparedResponsesTranscript {
	/** Provider input items for the transcript; the leading prompt is not part of it. */
	input: ResponseInput;
	/** Complete text of the leading system message, or `""` when the transcript has none. */
	instructions: string;
	/** Where every current tool is declared; the same decision owns the in-message additions. */
	toolPlacement: DeferredToolPlacement;
	/** Tool conversion options matching the placement. */
	toolOptions: ConvertResponsesToolsOptions;
}

/**
 * Replay one transcript into provider input plus the placement decision that owns every tool
 * declaration. Callers pass `toolPlacement` when they serialize slices of a transcript whose
 * decision was already made (native replay), so no slice decides on its own.
 */
export function prepareResponsesTranscript<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: Message[];
	startsAtTranscriptHead?: boolean | undefined;
	toolPlacement?: DeferredToolPlacement | undefined;
	includeSystemPrompt?: boolean | undefined;
	grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
	allowedToolCallProviders?: ReadonlySet<string> | undefined;
}): PreparedResponsesTranscript {
	const semantics = resolveResponsesTranscriptSemantics(args.model);
	const toolOptions: ConvertResponsesToolsOptions = {
		strict: false,
		supportsStrictMode: semantics.supportsStrictMode,
		supportsOpenAIGrammarTools: (args.grammarToolInputProperties?.size ?? 0) > 0,
	};
	const resolved = resolveTranscript(
		normalizeProviderContext({ messages: args.messages } as Context),
		semantics.supportsMidConvoSystemMessages,
	);
	const startsAtTranscriptHead = transcriptHeadIncluded(semantics, args.startsAtTranscriptHead);
	const toolPlacement = args.toolPlacement
		?? splitDeferredTools(resolved, semantics.deferredToolsMode !== undefined, startsAtTranscriptHead);
	const input = convertResponsesMessages(args.model, resolved, args.allowedToolCallProviders ?? CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: args.includeSystemPrompt ?? false,
		...(args.grammarToolInputProperties ? { grammarToolInputProperties: args.grammarToolInputProperties } : {}),
		deferredTools: toolPlacement.deferred,
		deferredToolsMode: semantics.deferredToolsMode,
		anchorsToolAdditions: toolPlacement.anchorsAdditions,
		supportsMidConvoSystemMessages: semantics.supportsMidConvoSystemMessages,
		startsAtTranscriptHead,
		toolOptions,
	});
	const initialSystemMessage = getInitialSystemMessage(resolved.messages, startsAtTranscriptHead);
	return {
		input,
		instructions: initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "",
		toolPlacement,
		toolOptions,
	};
}

export interface DeferredToolPlacement {
	/** Tools declared in the top-level request field. */
	immediate: Tool[];
	/** Tools declared in place from a later system message or a pre-0.86 `addedToolNames` result. */
	deferred: Map<string, Tool>;
	/** Whether later system messages declare their own additions in place. */
	anchorsAdditions: boolean;
}

/**
 * Decide where every current tool is declared: the top-level request field or a later in-place
 * addition. This is the single placement decision for the request — the caller hands it to
 * `convertResponsesMessages`, so the top-level declarations and the in-message additions cannot
 * disagree.
 *
 * Pi 0.86 anchors dynamic tools on system messages (`toolsAdded`); the bundled 3.0.34 transport
 * predates that and used `ToolResultMessage.addedToolNames`. Both shapes are read here so code-mode
 * tool deferral keeps its cache-friendly shape on either host.
 *
 * Removals and same-name redeclarations are not expressible as additions: the request then carries
 * the complete current tool set, and nothing is declared in place (which would duplicate a tool or
 * resurrect a removed one).
 */
export function splitDeferredTools(context: Pick<Context, "messages">, enabled: boolean, startsAtTranscriptHead = true): DeferredToolPlacement {
	const messages = normalizeProviderContext(context as Context).messages;
	const { requestTools, anchorsAdditions } = resolveTranscriptTools(messages, enabled, startsAtTranscriptHead);
	if (!anchorsAdditions) return { immediate: requestTools, deferred: new Map(), anchorsAdditions: false };

	const anchoredAdditions = getAnchoredToolAdditions(messages, startsAtTranscriptHead);
	const deferredNames = new Set(anchoredAdditions.map((tool) => tool.name));
	// Pre-0.86 transcripts recorded each dynamic tool on the tool result that introduced it.
	const usedNames = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") usedNames.add(block.name);
			}
		} else if (message.role === "toolResult") {
			for (const name of legacyAddedToolNames(message)) {
				if (!usedNames.has(name)) deferredNames.add(name);
			}
		}
	}

	const immediate: Tool[] = [];
	const deferred = new Map<string, Tool>();
	for (const tool of requestTools) {
		if (deferredNames.has(tool.name)) deferred.set(tool.name, tool);
		else immediate.push(tool);
	}
	// Tools anchored on a later system message are absent from the top-level declaration.
	for (const tool of anchoredAdditions) {
		if (!deferred.has(tool.name)) deferred.set(tool.name, tool);
	}
	return { immediate, deferred, anchorsAdditions: true };
}

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function parseResponsesThinkingSignature(signature: string): ResponseInput[number] | undefined {
	try {
		return JSON.parse(signature) as ResponseInput[number];
	} catch {
		return undefined;
	}
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const loadedTools = new Map<string, Tool>();
	const normalizeIdPart = (part: string) => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};
	const buildForeignResponsesItemId = (itemId: string) => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};
	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: Extract<Message, { role: "assistant" }>) => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|") as [string, string | undefined];
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId ?? "") : normalizeIdPart(itemId ?? "");
		if (!normalizedItemId.startsWith("fc_")) normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const normalizedContext = resolveTranscript(
		normalizeProviderContext(context),
		options?.supportsMidConvoSystemMessages,
	);
	const startsAtTranscriptHead = options?.startsAtTranscriptHead !== false;
	const transformedMessages = normalizeResponsesMessageHistory(normalizedContext.messages, model as Model<Api>, normalizeToolCallId as never);
	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	const supportsMidConvoSystemMessages = options?.supportsMidConvoSystemMessages === true;
	const anchorsToolAdditions = options?.anchorsToolAdditions === true;
	const appendSystemToolAdditions = (message: SystemMessage): void => {
		const tools = anchorsToolAdditions ? (message.toolsAdded ?? []) : [];
		if (tools.length === 0) return;
		if (options?.deferredToolsMode === "additional-tools") {
			messages.push({
				type: "additional_tools",
				role: "developer",
				tools: convertResponsesTools(tools, options.toolOptions),
			} as unknown as ResponseInputItem);
			return;
		}
		if (options?.deferredToolsMode !== "tool-search") return;
		const names = tools.map((tool) => tool.name);
		// Derive the id from the anchor itself (not its index) so a replayed slice of the same
		// transcript produces the same tool_search pair as the full request.
		const seed = `${message.timestamp ?? 0}:${renderSystemMessageUpdate(message)}`;
		const searchCallId = `pi_tool_load_${shortHash(`${seed}:${names.join(",")}`)}`;
		messages.push({
			type: "tool_search_call",
			call_id: searchCallId,
			execution: "client",
			status: "completed",
			arguments: { query: names.join(" "), limit: names.length },
		} satisfies ResponseInputItem);
		messages.push({
			type: "tool_search_output",
			call_id: searchCallId,
			execution: "client",
			status: "completed",
			tools: convertResponsesTools(tools, { ...options.toolOptions, deferLoading: true }),
		} satisfies ResponseToolSearchOutputItemParam);
	};
	const compat = model.compat as { supportsDeveloperRole?: boolean | undefined } | undefined;
	const instructionRole: "developer" | "system" = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";

	let msgIndex = 0;
	let sourceIndex = 0;
	for (const msg of transformedMessages) {
		const isLeadingSystemMessage = startsAtTranscriptHead && sourceIndex++ === 0 && msg.role === "system";
		if (msg.role === "system") {
			if (!isLeadingSystemMessage) appendSystemToolAdditions(msg);
			if (isLeadingSystemMessage) {
				if (includeSystemPrompt) {
					const text = getSystemMessageText(msg);
					if (text.length > 0) messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
				}
			} else if (supportsMidConvoSystemMessages) {
				const text = renderSystemMessageUpdate(msg);
				if (text.length > 0) messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
			}
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }] });
			} else {
				const content = msg.content.map((item) =>
					item.type === "text"
						? { type: "input_text" as const, text: sanitizeSurrogates(item.text) }
						: { type: "input_image" as const, detail: imageDetailForResponses(item), image_url: `data:${item.mimeType};base64,${item.data}` },
				);
				if (content.length > 0) messages.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const isSameProviderAndApi = msg.provider === model.provider && msg.api === model.api;
			const isSameModel = isSameProviderAndApi && msg.model === model.id;
			const isDifferentModel = isSameProviderAndApi && msg.model !== model.id;
			let textBlockIndex = 0;
			for (const block of msg.content as InternalAssistantContent[]) {
				if (isImageGenerationCallBlock(block)) {
					const imageGenerationCall = sanitizeImageGenerationCallItem(block.item);
					if (imageGenerationCall) output.push(imageGenerationCall as ResponseInput[number]);
				} else if (isWebSearchCallBlock(block)) {
					const webSearchCall = sanitizeWebSearchCallItem(block.item);
					if (webSearchCall) output.push(webSearchCall as ResponseInput[number]);
				} else if (block.type === "thinking") {
					const thinkingItem = block.thinkingSignature ? parseResponsesThinkingSignature(block.thinkingSignature) : undefined;
					if (thinkingItem) output.push(thinkingItem);
				} else if (block.type === "text") {
					const parsedSignature = parseTextSignature(block.textSignature);
					const fallbackMessageId = textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					let msgId = parsedSignature?.id ?? fallbackMessageId;
					if (msgId.length > 64) msgId = `msg_${shortHash(msgId)}`;
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
						status: "completed",
						id: msgId,
						...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
					});
				} else if (block.type === "toolCall") {
					const wireCall = unrouteContextNamespaceToolCall(block);
					const [callId, itemIdRaw] = block.id.split("|");
					const customInputProperty = options?.grammarToolInputProperties?.get(block.name);
					let itemId: string | undefined = itemIdRaw;
					if (customInputProperty !== undefined && itemId?.startsWith("fc_")) {
						itemId = `ctc_${itemId.slice(3)}`;
					}
					if (
						(isDifferentModel && itemId?.startsWith("fc_"))
						|| (customInputProperty === undefined && !itemId?.startsWith("fc_"))
					) itemId = undefined;
					const canReplayNamespace = isSameModel || options?.deferredTools?.has(block.name) === true;
					output.push(customInputProperty === undefined
						? {
								type: "function_call",
								...(itemId ? { id: itemId } : {}),
								call_id: callId,
								name: wireCall.name,
								arguments: JSON.stringify(wireCall.arguments),
								...(canReplayNamespace && block.namespace !== undefined ? { namespace: block.namespace } : {}),
							} as ResponseInput[number]
						: {
								type: "custom_tool_call",
								...(itemId ? { id: itemId } : {}),
								call_id: callId,
								name: wireCall.name,
								input: sanitizeSurrogates(getGrammarToolInput(block.name, wireCall.arguments, customInputProperty)),
								...(canReplayNamespace && block.namespace !== undefined ? { namespace: block.namespace } : {}),
							} as ResponseInput[number]);
				}
			}
			if (output.length > 0) messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			const hasImages = msg.content.some((c) => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");
			const encryptedToolOutput = encryptedToolOutputFromDetails(msg.details);
			const output = encryptedToolOutput
				? [
						{ type: "encrypted_content" as const, encrypted_content: encryptedToolOutput },
						...(hasImages && model.input.includes("image")
							? msg.content
									.filter((block): block is ImageContentWithDetail => block.type === "image")
									.map((block) => ({
										type: "input_image" as const,
										detail: imageDetailForResponses(block),
										image_url: `data:${block.mimeType};base64,${block.data}`,
									}))
							: []),
					]
				: hasImages && model.input.includes("image")
					? [
							...(hasText ? [{ type: "input_text" as const, text: sanitizeSurrogates(textResult) }] : []),
							...msg.content
								.filter((block): block is ImageContentWithDetail => block.type === "image")
								.map((block) => ({
									type: "input_image" as const,
									detail: imageDetailForResponses(block),
									image_url: `data:${block.mimeType};base64,${block.data}`,
								})),
						]
					: sanitizeSurrogates(hasText ? textResult : "(see attached image)");
			messages.push({
				type: options?.grammarToolInputProperties?.has(msg.toolName)
					? "custom_tool_call_output"
					: "function_call_output",
				call_id: callId!,
				output: output as any,
			} as ResponseInput[number]);

			const newlyLoadedTools: Tool[] = [];
			for (const name of legacyAddedToolNames(msg)) {
				const tool = options?.deferredTools?.get(name);
				if (!tool || loadedTools.has(name)) continue;
				loadedTools.set(name, tool);
				newlyLoadedTools.push(tool);
			}
			if (newlyLoadedTools.length > 0 && anchorsToolAdditions && options?.deferredToolsMode === "additional-tools") {
				messages.push({
					type: "additional_tools",
					role: "developer",
					tools: convertResponsesTools([...loadedTools.values()], options.toolOptions),
				} as unknown as ResponseInputItem);
			} else if (newlyLoadedTools.length > 0 && anchorsToolAdditions && options?.deferredToolsMode === "tool-search") {
				const names = newlyLoadedTools.map((tool) => tool.name);
				const searchCallId = `pi_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
				messages.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: { query: names.join(" "), limit: names.length },
				} satisfies ResponseInputItem);
				messages.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: convertResponsesTools(newlyLoadedTools, {
						...options.toolOptions,
						deferLoading: true,
					}),
				} satisfies ResponseToolSearchOutputItemParam);
			}
		}
		msgIndex++;
	}

	return normalizeResponsesToolHistory(messages) as ResponseInput;
}

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;
	return tools.map((tool): OpenAITool => {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) return {
			type: "custom",
			name: tool.name,
			description: tool.description,
			format: {
				type: "grammar",
				syntax: grammar.format,
				definition: grammar.definition,
			},
			...(options?.deferLoading ? { defer_loading: true } : {}),
		} as OpenAITool;
		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const strict = constrainedStrict ?? defaultStrict;
		const functionTool = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true) as unknown as Record<string, unknown>,
			...(options?.deferLoading ? { defer_loading: true } : {}),
		} as Extract<OpenAITool, { type: "function" }>;
		if (supportsStrictMode) functionTool.strict = strict;
		return functionTool;
	});
}


export { processResponsesStream } from "./stream.ts";
