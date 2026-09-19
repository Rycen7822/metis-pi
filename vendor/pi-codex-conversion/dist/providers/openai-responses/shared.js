import { getJsonSchemaToolParameters, getGrammarToolInput, resolveGrammarConstrainedSampling, resolveJsonSchemaStrictSampling, } from "../constrained-sampling.js";
import { parseTextSignature, shortHash } from "./signatures.js";
import { normalizeResponsesToolHistory } from "./tool-history.js";
import { normalizeResponsesMessageHistory } from "./message-history.js";
import { encryptedToolOutputFromDetails, imageDetailForResponses, isImageGenerationCallBlock, isWebSearchCallBlock, sanitizeImageGenerationCallItem, sanitizeWebSearchCallItem } from "./native-items.js";
import { unrouteContextNamespaceToolCall } from "../../context-management/namespace-tools.js";
export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
export function splitDeferredTools(context, enabled) {
    const uniqueTools = new Map();
    for (const tool of context.tools ?? [])
        uniqueTools.set(tool.name, tool);
    if (!enabled)
        return { immediate: [...uniqueTools.values()], deferred: new Map() };
    const deferredNames = new Set();
    const usedNames = new Set();
    for (const message of context.messages) {
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "toolCall")
                    usedNames.add(block.name);
            }
        }
        else if (message.role === "toolResult") {
            for (const name of message.addedToolNames ?? []) {
                if (!usedNames.has(name))
                    deferredNames.add(name);
            }
        }
    }
    const immediate = [];
    const deferred = new Map();
    for (const [name, tool] of uniqueTools) {
        if (deferredNames.has(name))
            deferred.set(name, tool);
        else
            immediate.push(tool);
    }
    return { immediate, deferred };
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
export function convertResponsesMessages(model, context, allowedToolCallProviders, options) {
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
    const transformedMessages = normalizeResponsesMessageHistory(context.messages, model, normalizeToolCallId);
    const includeSystemPrompt = options?.includeSystemPrompt ?? true;
    if (includeSystemPrompt && context.systemPrompt) {
        messages.push({ role: model.reasoning ? "developer" : "system", content: sanitizeSurrogates(context.systemPrompt) });
    }
    let msgIndex = 0;
    for (const msg of transformedMessages) {
        if (msg.role === "user") {
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
                    const customInputProperty = options?.grammarToolInputProperties?.get(block.name);
                    let itemId = itemIdRaw;
                    if (customInputProperty !== undefined && itemId?.startsWith("fc_")) {
                        itemId = `ctc_${itemId.slice(3)}`;
                    }
                    if ((isDifferentModel && itemId?.startsWith("fc_"))
                        || (customInputProperty === undefined && !itemId?.startsWith("fc_")))
                        itemId = undefined;
                    const canReplayNamespace = isSameModel || options?.deferredTools?.has(block.name) === true;
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
                type: options?.grammarToolInputProperties?.has(msg.toolName)
                    ? "custom_tool_call_output"
                    : "function_call_output",
                call_id: callId,
                output: output,
            });
            const newlyLoadedTools = [];
            for (const name of msg.addedToolNames ?? []) {
                const tool = options?.deferredTools?.get(name);
                if (!tool || loadedTools.has(name))
                    continue;
                loadedTools.set(name, tool);
                newlyLoadedTools.push(tool);
            }
            if (newlyLoadedTools.length > 0 && options?.deferredToolsMode === "additional-tools") {
                messages.push({
                    type: "additional_tools",
                    role: "developer",
                    tools: convertResponsesTools([...loadedTools.values()], options.toolOptions),
                });
            }
            else if (newlyLoadedTools.length > 0 && options?.deferredToolsMode === "tool-search") {
                const names = newlyLoadedTools.map((tool) => tool.name);
                const searchCallId = `pi_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
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
                    tools: convertResponsesTools(newlyLoadedTools, {
                        ...options.toolOptions,
                        deferLoading: true,
                    }),
                });
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
