import { normalizeResponsesToolHistory } from "../../providers/openai-responses/tool-history.js";
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const APPROX_BYTES_PER_TOKEN = 4;
// Match Codex's coarse model-visible estimate for resized and auto-detail images.
const RESIZED_IMAGE_BYTES_ESTIMATE = 7_373;
const RETAINED_IMAGE_TOKEN_ESTIMATE = Math.ceil(RESIZED_IMAGE_BYTES_ESTIMATE / APPROX_BYTES_PER_TOKEN);
const CONTEXTUAL_USER_MARKERS = [
    ["# AGENTS.md instructions", "</INSTRUCTIONS>"],
    ["<environment_context>", "</environment_context>"],
    ["<skill>", "</skill>"],
    ["<user_shell_command>", "</user_shell_command>"],
    ["<turn_aborted>", "</turn_aborted>"],
    ["<subagent_notification>", "</subagent_notification>"],
    ["<recommended_plugins>", "</recommended_plugins>"],
];
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validMetadata(value) {
    return value === undefined || value === null || (isRecord(value)
        && (value["turn_id"] === undefined || value["turn_id"] === null || typeof value["turn_id"] === "string"));
}
export function canonicalCompactionOutput(item) {
    if (!isRecord(item) || (item["type"] !== "compaction" && item["type"] !== "compaction_summary"))
        return undefined;
    if (typeof item["encrypted_content"] !== "string" || item["encrypted_content"].trim() === "")
        return undefined;
    if (item["id"] !== undefined && item["id"] !== null && typeof item["id"] !== "string")
        return undefined;
    if (!validMetadata(item["internal_chat_message_metadata_passthrough"]))
        return undefined;
    const metadata = item["internal_chat_message_metadata_passthrough"];
    return {
        type: "compaction",
        ...(typeof item["id"] === "string" ? { id: item["id"] } : {}),
        encrypted_content: item["encrypted_content"],
        ...(isRecord(metadata)
            ? { internal_chat_message_metadata_passthrough: typeof metadata["turn_id"] === "string" ? { turn_id: metadata["turn_id"] } : {} }
            : {}),
    };
}
export function normalizeRemoteCompactionV2PromptInput(input) {
    return normalizeResponsesToolHistory(input)
        .filter((item) => isRecord(item))
        .map((item) => structuredClone(item));
}
function matchesMarkedText(text, start, end) {
    const trimmed = text.trim();
    return trimmed.slice(0, start.length).toLowerCase() === start.toLowerCase()
        && trimmed.slice(-end.length).toLowerCase() === end.toLowerCase();
}
function isHookPrompt(text) {
    const match = /^\s*<hook_prompt\s+hook_run_id=(?:"([^"]*)"|'([^']*)')\s*>[\s\S]*<\/hook_prompt>\s*$/.exec(text);
    return (match?.[1] ?? match?.[2] ?? "").trim() !== "";
}
function isAdditionalContext(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("<external_"))
        return false;
    const close = trimmed.indexOf(">");
    if (close < 0)
        return false;
    const key = trimmed.slice("<external_".length, close);
    return trimmed.slice(close + 1).endsWith(`</external_${key}>`);
}
function isInternalModelContext(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith("<goal_context>") && trimmed.endsWith("</goal_context>"))
        return true;
    const match = /^<codex_internal_context source="([a-z][a-z0-9_]*)">[\s\S]*<\/codex_internal_context>$/.exec(trimmed);
    return match !== null;
}
function isLegacyContextWarning(text) {
    const trimmed = text.trim();
    return trimmed.startsWith("Warning: The maximum number of unified exec processes you can keep open is")
        || trimmed.startsWith("Warning: Your account was flagged for potentially high-risk cyber activity")
        || (trimmed.startsWith("Warning: apply_patch was requested via ")
            && trimmed.endsWith("Use the apply_patch tool instead of exec_command."));
}
function isContextualText(text) {
    return CONTEXTUAL_USER_MARKERS.some(([start, end]) => matchesMarkedText(text, start, end))
        || isAdditionalContext(text)
        || isInternalModelContext(text)
        || isLegacyContextWarning(text);
}
function retainedRealUserMessage(item) {
    if (!isRecord(item) || (item["type"] !== undefined && item["type"] !== "message") || item["role"] !== "user" || !Array.isArray(item["content"]))
        return undefined;
    const content = item["content"].filter((part) => {
        if (!isRecord(part))
            return false;
        if (part["type"] !== "input_text" || typeof part["text"] !== "string")
            return true;
        return !isHookPrompt(part["text"]) && !isContextualText(part["text"]);
    });
    return content.length > 0 ? { ...structuredClone(item), type: "message", content: structuredClone(content) } : undefined;
}
function utf8Bytes(value) {
    return Buffer.byteLength(value, "utf8");
}
function approxTokenCount(value) {
    return Math.ceil(utf8Bytes(value) / APPROX_BYTES_PER_TOKEN);
}
function messageContentTokenCount(item) {
    if (!Array.isArray(item["content"]))
        return 0;
    return item["content"].reduce((tokens, part) => {
        if (!isRecord(part))
            return tokens;
        if ((part["type"] === "input_text" || part["type"] === "output_text") && typeof part["text"] === "string") {
            return tokens + approxTokenCount(part["text"]);
        }
        return part["type"] === "input_image" ? tokens + RETAINED_IMAGE_TOKEN_ESTIMATE : tokens;
    }, 0);
}
export function buildRemoteCompactionV2Window(promptInput, compactionOutput, maxTokens = RETAINED_MESSAGE_TOKEN_BUDGET) {
    const retained = promptInput
        .filter((item) => isRecord(item) && (item["type"] === undefined || item["type"] === "message") && (item["role"] === "user" || item["role"] === "developer" || item["role"] === "system"))
        .map(retainedRealUserMessage)
        .filter((item) => item !== undefined);
    let remaining = Math.max(0, Math.floor(maxTokens));
    const reversed = [];
    for (let index = retained.length - 1; index >= 0; index--) {
        const item = retained[index];
        const tokens = Math.max(1, messageContentTokenCount(item));
        if (tokens <= remaining) {
            reversed.push(item);
            remaining = Math.max(0, remaining - tokens);
        }
        else
            break;
    }
    reversed.reverse();
    // The next request establishes its selected effort as the new baseline.
    return [...reversed, structuredClone(compactionOutput)];
}
