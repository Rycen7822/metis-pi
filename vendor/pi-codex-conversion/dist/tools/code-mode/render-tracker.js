const MAX_TRACKED_CODE_MODE_CALLS = 1_000;
export function createCodeModeRenderTracker() {
    const entries = new Map();
    return {
        register(toolCallId, invalidate) {
            if (!toolCallId)
                return;
            const entry = entries.get(toolCallId) ?? { status: "running" };
            entry.invalidate = invalidate;
            entries.set(toolCallId, entry);
        },
        start(toolCallId) {
            const entry = entries.get(toolCallId) ?? { status: "running" };
            const changed = entry.status !== "running";
            entry.status = "running";
            entries.set(toolCallId, entry);
            trimRenderEntries(entries);
            if (changed)
                entry.invalidate?.();
        },
        finish(toolCallId, status = "done") {
            const entry = entries.get(toolCallId) ?? { status: "done" };
            const changed = entry.status !== status;
            const invalidate = entry.invalidate;
            entry.status = status;
            entry.invalidate = undefined;
            entries.set(toolCallId, entry);
            trimRenderEntries(entries);
            if (changed)
                invalidate?.();
        },
        status(toolCallId) {
            return toolCallId ? (entries.get(toolCallId)?.status ?? "done") : "done";
        },
    };
}
function trimRenderEntries(entries) {
    while (entries.size > MAX_TRACKED_CODE_MODE_CALLS) {
        const oldest = entries.keys().next().value;
        if (typeof oldest !== "string")
            return;
        entries.delete(oldest);
    }
}
