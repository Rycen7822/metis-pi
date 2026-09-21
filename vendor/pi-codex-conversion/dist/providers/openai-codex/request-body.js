import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { CODEX_TOOL_CALL_PROVIDERS, convertResponsesTools, prepareResponsesTranscript, } from "../openai-responses/shared.js";
import { normalizeProviderContext } from "../transcript.js";
import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "./constants.js";
function clampOpenAIPromptCacheKey(key) {
    if (key === undefined)
        return undefined;
    const chars = Array.from(key);
    if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH)
        return key;
    return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
function clampReasoningEffort(modelId, effort) {
    if (effort === "none")
        return effort;
    const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
    const gpt5MinorMatch = /^gpt-5\.(\d+)/.exec(id);
    const gpt5Minor = gpt5MinorMatch ? Number.parseInt(gpt5MinorMatch[1], 10) : undefined;
    if (gpt5Minor !== undefined && gpt5Minor >= 2 && effort === "minimal")
        return "low";
    if (id === "gpt-5.1" && effort === "xhigh")
        return "high";
    if (id === "gpt-5.1-codex-mini")
        return effort === "high" || effort === "xhigh" ? "high" : "medium";
    return effort;
}
export function buildRequestBody(model, context, options) {
    const grammarToolInputProperties = options?.grammarToolInputProperties ?? new Map();
    const supportsOpenAIGrammarTools = grammarToolInputProperties.size > 0;
    const allowedToolCallProviders = supportsOpenAIGrammarTools && !CODEX_TOOL_CALL_PROVIDERS.has(model.provider)
        ? new Set([...CODEX_TOOL_CALL_PROVIDERS, model.provider])
        : CODEX_TOOL_CALL_PROVIDERS;
    // Accept both shapes: 0.85 hosts hand over `Context.systemPrompt`/`Context.tools`
    // (compaction and replay build these internally), 0.86 hosts a normalized transcript.
    const prepared = prepareResponsesTranscript({
        model,
        messages: normalizeProviderContext(context).messages,
        includeSystemPrompt: false,
        grammarToolInputProperties,
        allowedToolCallProviders,
    });
    const { instructions, input: messages, toolOptions, toolPlacement } = prepared;
    const body = {
        model: model.id,
        store: false,
        stream: true,
        instructions: instructions || "You are a helpful assistant.",
        input: messages,
        text: { verbosity: (options?.textVerbosity ?? "low") },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
        tool_choice: options?.toolChoice ?? "auto",
        parallel_tool_calls: true,
        ...(options?.sessionId ? { client_metadata: { session_id: options.sessionId, thread_id: options.sessionId } } : {}),
    };
    // The Codex ChatGPT-backed endpoint rejects output-token cap fields with
    // `Unsupported parameter: max_output_tokens`. Pi's branch summarizer passes
    // `maxTokens`, so forwarding it breaks `/tree` summaries and extensions that
    // use `ctx.navigateTree(..., { summarize: true })`.
    if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
    }
    const serviceTier = options?.serviceTier;
    if (serviceTier !== undefined) {
        body.service_tier = serviceTier;
    }
    if (toolPlacement.immediate.length > 0) {
        body.tools = convertResponsesTools(toolPlacement.immediate, toolOptions);
    }
    const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
    const reasoningEffort = options?.reasoningEffort ?? (clampedReasoning === "off" ? undefined : clampedReasoning);
    if (reasoningEffort !== undefined) {
        const thinkingLevelMap = model.thinkingLevelMap;
        const effort = reasoningEffort === "none" ? (thinkingLevelMap?.["off"] ?? "none") : (thinkingLevelMap?.[reasoningEffort] ?? reasoningEffort);
        if (effort === null)
            return body;
        body.reasoning = {
            effort: clampReasoningEffort(model.id, effort),
            summary: (options?.reasoningSummary ?? "auto"),
        };
    }
    return body;
}
