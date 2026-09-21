import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CODEX_TOOL_CALL_PROVIDERS, prepareResponsesTranscript } from "../../providers/openai-responses/shared.js";
import { isCodexTransportModel } from "../prompt/codex-model.js";
import { isProviderContextExcludedMessage } from "../prompt/context-filter.js";
import { CodexDeveloperMessageBridge } from "../developer-messages.js";
import { projectCodexReasoningHistory } from "../reasoning-history.js";
import { createInitialSystemMessage } from "../../providers/transcript.js";
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
let cachedBlockImagesSetting;
function readBlockImagesSetting() {
    if (cachedBlockImagesSetting !== undefined)
        return cachedBlockImagesSetting;
    try {
        const parsed = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf-8"));
        cachedBlockImagesSetting = isRecord(parsed) && isRecord(parsed["images"]) && parsed["images"]["blockImages"] === true;
    }
    catch {
        cachedBlockImagesSetting = false;
    }
    return cachedBlockImagesSetting;
}
function replaceImagesWithDisabledPlaceholder(message) {
    if (!Array.isArray(message.content) || !message.content.some((item) => item.type === "image"))
        return message;
    const content = message.content
        .map((item) => item.type === "image" ? { type: "text", text: "Image reading is disabled." } : item)
        .filter((item, index, items) => {
        const previous = (items[index - 1]);
        return !(item.type === "text" && item.text === "Image reading is disabled." && previous?.type === "text" && previous.text === "Image reading is disabled.");
    });
    return { ...message, content };
}
function applyBlockImages(messages, blockImages) {
    if (!blockImages)
        return messages;
    return messages.map((message) => {
        if (message.role === "user" || message.role === "toolResult")
            return replaceImagesWithDisabledPlaceholder(message);
        return message;
    });
}
/**
 * Reconstruct the provider history for a session branch. Returns the placement decision together
 * with the items: a caller that assembles a request from this history (native compaction) must
 * declare the same top-level tools instead of deriving them from another context.
 */
export function serializeActiveSessionHistory(args) {
    const messages = projectCodexReasoningHistory(args.entries, undefined, args.leafId)
        .filter((message) => !isProviderContextExcludedMessage(message));
    return serializeMessagesToResponsesHistory(args.model, messages, args.options);
}
export function serializeMessagesToResponsesInput(model, messages, options = {}) {
    return serializeMessagesToResponsesHistory(model, messages, options).input;
}
function serializeMessagesToResponsesHistory(model, messages, options = {}) {
    const developerMessages = new CodexDeveloperMessageBridge();
    const llmMessages = applyBlockImages(convertToLlm(developerMessages.prepare(messages, true, model)), options.blockImages ?? readBlockImagesSetting());
    const allowedToolCallProviders = isCodexTransportModel(model) && !CODEX_TOOL_CALL_PROVIDERS.has(model.provider)
        ? new Set([...CODEX_TOOL_CALL_PROVIDERS, model.provider])
        : CODEX_TOOL_CALL_PROVIDERS;
    const prepared = prepareResponsesTranscript({
        model,
        // `includeInstructionsInInput` asks for the prompt as an input item as well; a caller that
        // supplies its own text still gets it at the head without touching the transcript.
        messages: options.includeInstructionsInInput && options.instructions
            ? [createInitialSystemMessage(options.instructions, undefined), ...llmMessages]
            : llmMessages,
        startsAtTranscriptHead: options.startsAtTranscriptHead,
        toolPlacement: options.toolPlacement,
        includeSystemPrompt: options.includeInstructionsInInput ?? false,
        grammarToolInputProperties: options.grammarToolInputProperties,
        allowedToolCallProviders,
    });
    return {
        input: developerMessages.rewritePayload({ input: prepared.input }, model).input,
        toolPlacement: prepared.toolPlacement,
    };
}
export function createResponsesInputParitySignature(input) {
    return input.map(describeResponsesInputItem);
}
export function compareResponsesInputParity(actual, expected) {
    const actualSignature = createResponsesInputParitySignature(actual);
    const expectedSignature = createResponsesInputParitySignature(expected);
    const maxLength = Math.max(actualSignature.length, expectedSignature.length);
    const mismatches = [];
    for (let index = 0; index < maxLength; index++) {
        const actualValue = actualSignature[index];
        const expectedValue = expectedSignature[index];
        if (actualValue !== expectedValue) {
            mismatches.push(`index ${index}: expected ${expectedValue ?? "<missing>"}, got ${actualValue ?? "<missing>"}`);
        }
    }
    return {
        ok: mismatches.length === 0,
        actual: actualSignature,
        expected: expectedSignature,
        mismatches,
    };
}
function describeResponsesInputItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        return typeof item;
    }
    const record = item;
    const type = typeof record["type"] === "string" ? record["type"] : undefined;
    if (type === "message") {
        const phase = record["phase"] === "commentary" || record["phase"] === "final_answer"
            ? `:${record["phase"]}`
            : "";
        return `message:${typeof record["role"] === "string" ? record["role"] : "unknown"}${phase}`;
    }
    if (type === "function_call") {
        return `function_call:${typeof record["name"] === "string" ? record["name"] : "unknown"}`;
    }
    if (type === "function_call_output") {
        return "function_call_output";
    }
    if (type === "reasoning") {
        return "reasoning";
    }
    if (typeof record["role"] === "string") {
        const content = Array.isArray(record["content"]) ? `[${record["content"].length}]` : "";
        return `input:${record["role"]}${content}`;
    }
    return type ? `item:${type}` : "object";
}
