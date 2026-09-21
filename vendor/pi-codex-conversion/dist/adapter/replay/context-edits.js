function readContextEdit(entry) {
    const candidate = entry;
    if (candidate.type !== "context_edit" || typeof candidate.targetId !== "string")
        return undefined;
    const replacement = candidate.replacement;
    return {
        targetId: candidate.targetId,
        replacement: replacement === null || replacement === undefined
            ? null
            : { content: replacement.content },
    };
}
/**
 * First kept entry a checkpoint replays, or undefined when its boundary cannot be placed.
 *
 * Pi's `appendCompaction(summary, null, ...)` keeps no entry: 0.87 stores the checkpoint's own id,
 * 0.86 stored `null`, and both hosts project either shape as an empty kept window. Only those two
 * markers are retain-none. A missing field and an explicit `undefined` are not the legacy marker,
 * and an id that does not name an entry before the checkpoint on this branch (unknown, later, or
 * off-branch) is unresolvable; none of them may degrade into an empty kept window.
 */
function findCheckpointFirstKeptEntryIndex(entries, checkpoint, checkpointIndex) {
    const boundary = checkpoint.firstKeptEntryId;
    if (boundary === null)
        return checkpointIndex;
    if (typeof boundary !== "string")
        return undefined;
    if (boundary === checkpoint.id)
        return checkpointIndex;
    for (let index = 0; index < checkpointIndex; index++) {
        if (entries[index].id === boundary)
            return index;
    }
    return undefined;
}
export function inspectCheckpointWindow(args) {
    const firstKeptEntryIndex = findCheckpointFirstKeptEntryIndex(args.branchEntries, args.checkpoint, args.checkpointIndex);
    if (firstKeptEntryIndex === undefined)
        return { ok: false, reason: "first-kept-entry-not-found" };
    const keptIds = new Set();
    const effective = new Map();
    for (let index = firstKeptEntryIndex; index < args.checkpointIndex; index++) {
        const entry = args.branchEntries[index];
        keptIds.add(entry.id);
        const edit = readContextEdit(entry);
        if (edit)
            effective.set(edit.targetId, { edit, entryIndex: index });
    }
    for (let index = args.checkpointIndex + 1; index < args.branchEntries.length; index++) {
        const edit = readContextEdit(args.branchEntries[index]);
        if (edit)
            effective.set(edit.targetId, { edit, entryIndex: index });
    }
    let edits;
    for (const [targetId, positioned] of effective) {
        if (positioned.entryIndex > args.checkpointIndex && keptIds.has(targetId)) {
            return { ok: false, reason: "context-edit-targets-compacted-content" };
        }
        (edits ??= new Map()).set(targetId, positioned.edit);
    }
    return { ok: true, firstKeptEntryIndex, edits };
}
function replaceMessageContent(message, replacement) {
    // The host normalizes a string replacement for assistant/toolResult content back to a text part.
    return (message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
        ? [{ type: "text", text: replacement.content }]
        : replacement.content;
}
/**
 * Project entries the way the host projects model context: drop entries whose edit omits them and
 * rewrite the content of the editable roles. Edit markers themselves never contribute messages.
 */
export function applyContextEdits(entries, edits) {
    if (!edits || edits.size === 0)
        return [...entries];
    const projected = [];
    for (const entry of entries) {
        if (readContextEdit(entry))
            continue;
        const edit = edits.get(entry.id);
        if (!edit) {
            projected.push(entry);
            continue;
        }
        if (edit.replacement === null)
            continue;
        if (entry.type === "custom_message") {
            projected.push({ ...entry, content: edit.replacement.content });
            continue;
        }
        if (entry.type === "message") {
            const message = entry.message;
            if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
                projected.push({
                    ...entry,
                    message: { ...entry.message, content: replaceMessageContent(message, edit.replacement) },
                });
                continue;
            }
        }
        projected.push(entry);
    }
    return projected;
}
