import { getJsonSchemaToolParameters, getGrammarToolInput, resolveGrammarConstrainedSampling, resolveJsonSchemaStrictSampling, } from "../constrained-sampling.js";
import { parseTextSignature, shortHash } from "./signatures.js";
import { normalizeResponsesToolHistory } from "./tool-history.js";
import { normalizeResponsesMessageHistory } from "./message-history.js";
import { encryptedToolOutputFromDetails, imageDetailForResponses, isImageGenerationCallBlock, isWebSearchCallBlock, sanitizeImageGenerationCallItem, sanitizeWebSearchCallItem } from "./native-items.js";
import { unrouteContextNamespaceToolCall } from "../../context-management/namespace-tools.js";
import { getCurrentTools, hasNonAdditiveToolChanges, getInitialSystemMessage, getSystemMessageText, legacyAddedToolNames, renderSystemMessageUpdate, resolveTranscript, } from "../transcript.js";
export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
/**
 * Read the transcript semantics a model declares. Every provider-facing path (normal request,
 * compaction serializer, native replay) resolves them here, so the same transcript is replayed
 * the same way and no caller re-invents a second, independent decision.
 */
function resolveResponsesTranscriptSemantics(model) {
    const compat = model.compat;
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
function transcriptHeadIncluded(semantics, startsAtTranscriptHead) {
    return !(semantics.supportsMidConvoSystemMessages && startsAtTranscriptHead === false);
}
/**
 * The single tool placement decision for `messages`: which tools the request declares at the top
 * level and which ones its later system messages announce in place. Callers that serialize slices
 * of an already decided transcript pass the result on instead of asking again. Agent-level entries
 * are accepted: the decision only reads system messages and tool declarations.
 */
export function resolveToolPlacement(model, messages, startsAtTranscriptHead = true) {
    const semantics = resolveResponsesTranscriptSemantics(model);
    return splitDeferredTools(resolveTranscript({ messages: messages }, semantics.supportsMidConvoSystemMessages).messages, semantics.deferredToolsMode !== undefined, transcriptHeadIncluded(semantics, startsAtTranscriptHead));
}
/**
 * Replay one transcript into provider input plus the placement decision that owns every tool
 * declaration. Callers pass `toolPlacement` when they serialize slices of a transcript whose
 * decision was already made (native replay), so no slice decides on its own.
 */
export function prepareResponsesTranscript(args) {
    const semantics = resolveResponsesTranscriptSemantics(args.model);
    const toolOptions = {
        strict: false,
        supportsStrictMode: semantics.supportsStrictMode,
        supportsOpenAIGrammarTools: (args.grammarToolInputProperties?.size ?? 0) > 0,
    };
    const resolved = resolveTranscript({ messages: args.messages }, semantics.supportsMidConvoSystemMessages);
    const startsAtTranscriptHead = transcriptHeadIncluded(semantics, args.startsAtTranscriptHead);
    const toolPlacement = args.toolPlacement
        ?? splitDeferredTools(resolved.messages, semantics.deferredToolsMode !== undefined, startsAtTranscriptHead);
    const input = convertResponsesMessages(args.model, resolved.messages, args.allowedToolCallProviders ?? CODEX_TOOL_CALL_PROVIDERS, {
        includeSystemPrompt: args.includeSystemPrompt ?? false,
        ...(args.grammarToolInputProperties ? { grammarToolInputProperties: args.grammarToolInputProperties } : {}),
        toolPlacement,
        deferredToolsMode: semantics.deferredToolsMode,
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
function splitDeferredTools(messages, enabled, startsAtTranscriptHead) {
    if (!enabled || hasNonAdditiveToolChanges(messages)) {
        return { immediate: getCurrentTools(messages), deferred: new Map(), anchorsAdditions: false };
    }
    const initial = getInitialSystemMessage(messages, startsAtTranscriptHead);
    const requestTools = initial?.toolsAdded ?? [];
    const anchoredAdditions = messages.flatMap((message) => message.role === "system" && message !== initial ? message.toolsAdded ?? [] : []);
    const deferredNames = new Set(anchoredAdditions.map((tool) => tool.name));
    // Pre-0.86 transcripts recorded each dynamic tool on the tool result that introduced it.
    const usedNames = new Set();
    for (const message of messages) {
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "toolCall")
                    usedNames.add(block.name);
            }
        }
        else if (message.role === "toolResult") {
            for (const name of legacyAddedToolNames(message)) {
                if (!usedNames.has(name))
                    deferredNames.add(name);
            }
        }
    }
    const immediate = [];
    const deferred = new Map();
    for (const tool of requestTools) {
        if (deferredNames.has(tool.name))
            deferred.set(tool.name, tool);
        else
            immediate.push(tool);
    }
    // Tools anchored on a later system message are absent from the top-level declaration.
    for (const tool of anchoredAdditions) {
        if (!deferred.has(tool.name))
            deferred.set(tool.name, tool);
    }
    return { immediate, deferred, anchorsAdditions: true };
}
function sanitizeSurrogates(text) {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
function parseResponsesThinkingSignature(signature) {
    try {
        return JSON.parse(signature);
    }
    catch {
        return undefined;
    }
}
// Only prepared transcripts reach wire serialization; model resolution belongs to the caller.
function convertResponsesMessages(model, transcript, allowedToolCallProviders, options) {
    const messages = [];
    const loadedTools = new Map();
    const normalizeIdPart = (part) => {
        const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
        const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
        return normalized.replace(/_+$/, "");
    };
    const buildForeignResponsesItemId = (itemId) => {
        const normalized = `fc_${shortHash(itemId)}`;
        return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
    };
    const normalizeToolCallId = (id, _targetModel, source) => {
        if (!allowedToolCallProviders.has(model.provider))
            return normalizeIdPart(id);
        if (!id.includes("|"))
            return normalizeIdPart(id);
        const [callId, itemId] = id.split("|");
        const normalizedCallId = normalizeIdPart(callId);
        const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
        let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId ?? "") : normalizeIdPart(itemId ?? "");
        if (!normalizedItemId.startsWith("fc_"))
            normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
        return `${normalizedCallId}|${normalizedItemId}`;
    };
    const transformedMessages = normalizeResponsesMessageHistory(transcript, model, normalizeToolCallId);
    const { startsAtTranscriptHead, includeSystemPrompt, toolPlacement } = options;
    const appendToolAdditions = (tools, seed) => {
        if (tools.length === 0)
            return;
        if (options.deferredToolsMode === "additional-tools") {
            messages.push({
                type: "additional_tools",
                role: "developer",
                tools: convertResponsesTools(tools, options.toolOptions),
            });
            return;
        }
        if (options.deferredToolsMode !== "tool-search")
            return;
        const names = tools.map((tool) => tool.name);
        // Derive the id from the anchor itself (not its index) so a replayed slice of the same
        // transcript produces the same tool_search pair as the full request.
        const searchCallId = `pi_tool_load_${shortHash(`${seed}:${names.join(",")}`)}`;
        messages.push({
            type: "tool_search_call",
            call_id: searchCallId,
            execution: "client",
            status: "completed",
            arguments: { query: names.join(" "), limit: names.length },
        });
        messages.push({
            type: "tool_search_output",
            call_id: searchCallId,
            execution: "client",
            status: "completed",
            tools: convertResponsesTools(tools, { ...options.toolOptions, deferLoading: true }),
        });
    };
    const compat = model.compat;
    const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
    let msgIndex = 0;
    let sourceIndex = 0;
    for (const msg of transformedMessages) {
        const isLeadingSystemMessage = startsAtTranscriptHead && sourceIndex++ === 0 && msg.role === "system";
        if (msg.role === "system") {
            if (!isLeadingSystemMessage && toolPlacement.anchorsAdditions) {
                appendToolAdditions(msg.toolsAdded ?? [], `${msg.timestamp ?? 0}:${renderSystemMessageUpdate(msg)}`);
            }
            if (isLeadingSystemMessage) {
                if (includeSystemPrompt) {
                    const text = getSystemMessageText(msg);
                    if (text.length > 0)
                        messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
                }
            }
            else {
                const text = renderSystemMessageUpdate(msg);
                if (text.length > 0)
                    messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
            }
        }
        else if (msg.role === "user") {
            if (typeof msg.content === "string") {
                messages.push({ role: "user", content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }] });
            }
            else {
                const content = msg.content.map((item) => item.type === "text"
                    ? { type: "input_text", text: sanitizeSurrogates(item.text) }
                    : { type: "input_image", detail: imageDetailForResponses(item), image_url: `data:${item.mimeType};base64,${item.data}` });
                if (content.length > 0)
                    messages.push({ role: "user", content });
            }
        }
        else if (msg.role === "assistant") {
            const output = [];
            const isSameProviderAndApi = msg.provider === model.provider && msg.api === model.api;
            const isSameModel = isSameProviderAndApi && msg.model === model.id;
            const isDifferentModel = isSameProviderAndApi && msg.model !== model.id;
            let textBlockIndex = 0;
            for (const block of msg.content) {
                if (isImageGenerationCallBlock(block)) {
                    const imageGenerationCall = sanitizeImageGenerationCallItem(block.item);
                    if (imageGenerationCall)
                        output.push(imageGenerationCall);
                }
                else if (isWebSearchCallBlock(block)) {
                    const webSearchCall = sanitizeWebSearchCallItem(block.item);
                    if (webSearchCall)
                        output.push(webSearchCall);
                }
                else if (block.type === "thinking") {
                    const thinkingItem = block.thinkingSignature ? parseResponsesThinkingSignature(block.thinkingSignature) : undefined;
                    if (thinkingItem)
                        output.push(thinkingItem);
                }
                else if (block.type === "text") {
                    const parsedSignature = parseTextSignature(block.textSignature);
                    const fallbackMessageId = textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
                    textBlockIndex++;
                    let msgId = parsedSignature?.id ?? fallbackMessageId;
                    if (msgId.length > 64)
                        msgId = `msg_${shortHash(msgId)}`;
                    output.push({
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
                        status: "completed",
                        id: msgId,
                        ...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
                    });
                }
                else if (block.type === "toolCall") {
                    const wireCall = unrouteContextNamespaceToolCall(block);
                    const [callId, itemIdRaw] = block.id.split("|");
                    const customInputProperty = options.grammarToolInputProperties?.get(block.name);
                    let itemId = itemIdRaw;
                    if (customInputProperty !== undefined && itemId?.startsWith("fc_")) {
                        itemId = `ctc_${itemId.slice(3)}`;
                    }
                    if ((isDifferentModel && itemId?.startsWith("fc_"))
                        || (customInputProperty === undefined && !itemId?.startsWith("fc_")))
                        itemId = undefined;
                    const canReplayNamespace = isSameModel || toolPlacement.deferred.has(block.name);
                    output.push(customInputProperty === undefined
                        ? {
                            type: "function_call",
                            ...(itemId ? { id: itemId } : {}),
                            call_id: callId,
                            name: wireCall.name,
                            arguments: JSON.stringify(wireCall.arguments),
                            ...(canReplayNamespace && block.namespace !== undefined ? { namespace: block.namespace } : {}),
                        }
                        : {
                            type: "custom_tool_call",
                            ...(itemId ? { id: itemId } : {}),
                            call_id: callId,
                            name: wireCall.name,
                            input: sanitizeSurrogates(getGrammarToolInput(block.name, wireCall.arguments, customInputProperty)),
                            ...(canReplayNamespace && block.namespace !== undefined ? { namespace: block.namespace } : {}),
                        });
                }
            }
            if (output.length > 0)
                messages.push(...output);
        }
        else if (msg.role === "toolResult") {
            const textResult = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
            const hasImages = msg.content.some((c) => c.type === "image");
            const hasText = textResult.length > 0;
            const [callId] = msg.toolCallId.split("|");
            const encryptedToolOutput = encryptedToolOutputFromDetails(msg.details);
            const output = encryptedToolOutput
                ? [
                    { type: "encrypted_content", encrypted_content: encryptedToolOutput },
                    ...(hasImages && model.input.includes("image")
                        ? msg.content
                            .filter((block) => block.type === "image")
                            .map((block) => ({
                            type: "input_image",
                            detail: imageDetailForResponses(block),
                            image_url: `data:${block.mimeType};base64,${block.data}`,
                        }))
                        : []),
                ]
                : hasImages && model.input.includes("image")
                    ? [
                        ...(hasText ? [{ type: "input_text", text: sanitizeSurrogates(textResult) }] : []),
                        ...msg.content
                            .filter((block) => block.type === "image")
                            .map((block) => ({
                            type: "input_image",
                            detail: imageDetailForResponses(block),
                            image_url: `data:${block.mimeType};base64,${block.data}`,
                        })),
                    ]
                    : sanitizeSurrogates(hasText ? textResult : "(see attached image)");
            messages.push({
                type: options.grammarToolInputProperties?.has(msg.toolName)
                    ? "custom_tool_call_output"
                    : "function_call_output",
                call_id: callId,
                output: output,
            });
            const newlyLoadedTools = [];
            for (const name of legacyAddedToolNames(msg)) {
                const tool = toolPlacement.deferred.get(name);
                if (!tool || loadedTools.has(name))
                    continue;
                loadedTools.set(name, tool);
                newlyLoadedTools.push(tool);
            }
            if (newlyLoadedTools.length > 0 && toolPlacement.anchorsAdditions) {
                // The legacy additional_tools payload is cumulative; tool_search loads only the delta.
                appendToolAdditions(options.deferredToolsMode === "additional-tools" ? [...loadedTools.values()] : newlyLoadedTools, msg.toolCallId);
            }
        }
        msgIndex++;
    }
    return normalizeResponsesToolHistory(messages);
}
export function convertResponsesTools(tools, options) {
    const defaultStrict = options?.strict === undefined ? false : options.strict;
    const supportsStrictMode = options?.supportsStrictMode ?? true;
    const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;
    return tools.map((tool) => {
        const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
        if (grammar)
            return {
                type: "custom",
                name: tool.name,
                description: tool.description,
                format: {
                    type: "grammar",
                    syntax: grammar.format,
                    definition: grammar.definition,
                },
                ...(options?.deferLoading ? { defer_loading: true } : {}),
            };
        const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
        const strict = constrainedStrict ?? defaultStrict;
        const functionTool = {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: getJsonSchemaToolParameters(tool, strict === true),
            ...(options?.deferLoading ? { defer_loading: true } : {}),
        };
        if (supportsStrictMode)
            functionTool.strict = strict;
        return functionTool;
    });
}
export { processResponsesStream } from "./stream.js";
