import { isProviderContextExcludedCustomMessageEntry } from "../prompt/context-filter.js";
import { projectCodexReasoningEntry } from "../reasoning-history.js";
function toBranchSummaryMessage(entry) {
    return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: new Date(entry.timestamp).getTime() };
}
function toCustomMessage(entry) {
    return { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: new Date(entry.timestamp).getTime() };
}
function toSessionMessage(entry) {
    return entry.message;
}
export function toReplayAgentMessage(entry) {
    entry = projectCodexReasoningEntry(entry);
    if (entry.type === "message")
        return toSessionMessage(entry);
    if (entry.type === "custom_message") {
        if (isProviderContextExcludedCustomMessageEntry(entry))
            return undefined;
        return toCustomMessage(entry);
    }
    if (entry.type === "branch_summary")
        return toBranchSummaryMessage(entry);
    return undefined;
}
export function toPiReplayAgentMessage(entry) {
    entry = projectCodexReasoningEntry(entry);
    if (entry.type === "message")
        return toSessionMessage(entry);
    if (entry.type === "custom_message")
        return toCustomMessage(entry);
    if (entry.type === "branch_summary")
        return toBranchSummaryMessage(entry);
    return undefined;
}
