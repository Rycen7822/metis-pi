import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Pi 0.87 context edits are append-only entries that change what one earlier entry contributes to
 * model context. Vendored replay reads raw session entries, so every reconstructed or replayed
 * slice has to apply the same projection first: otherwise a repeated compaction or an
 * opaque-checkpoint replay resurrects content the host already replaced or removed. Pi 0.86
 * sessions have no such entries, so this projection is a no-op there.
 *
 * The projection mirrors the host's `projectContextEntry`: the last edit per target on the active
 * path wins, a null replacement omits the target, and a replacement rewrites only content. Edits
 * carry no position information themselves, so checkpoint reuse also needs the chronological
 * judgment in `inspectCheckpointWindow`.
 */
type ContextEdit = {
	targetId: string;
	replacement: { content: unknown } | null;
};

export type ContextEdits = ReadonlyMap<string, ContextEdit>;

type PositionedContextEdit = { edit: ContextEdit; entryIndex: number };

function readContextEdit(entry: SessionEntry): ContextEdit | undefined {
	const candidate = entry as { type?: unknown; targetId?: unknown; replacement?: unknown };
	if (candidate.type !== "context_edit" || typeof candidate.targetId !== "string") return undefined;
	const replacement = candidate.replacement;
	return {
		targetId: candidate.targetId,
		replacement: replacement === null || replacement === undefined
			? null
			: { content: (replacement as { content?: unknown }).content },
	};
}

/** The checkpoint fields the boundary judgment needs; legacy 0.86 sessions can carry a null id. */
type CheckpointBoundary = { id: string; firstKeptEntryId: string | null | undefined };

/**
 * First kept entry a checkpoint replays, or undefined when its boundary cannot be placed.
 *
 * Pi's `appendCompaction(summary, null, ...)` keeps no entry: 0.87 stores the checkpoint's own id,
 * 0.86 stored `null`, and both hosts project either shape as an empty kept window. Only those two
 * markers are retain-none. A missing field and an explicit `undefined` are not the legacy marker,
 * and an id that does not name an entry before the checkpoint on this branch (unknown, later, or
 * off-branch) is unresolvable; none of them may degrade into an empty kept window.
 */
function findCheckpointFirstKeptEntryIndex(
	entries: readonly SessionEntry[],
	checkpoint: CheckpointBoundary,
	checkpointIndex: number,
): number | undefined {
	const boundary = checkpoint.firstKeptEntryId;
	if (boundary === null) return checkpointIndex;
	if (typeof boundary !== "string") return undefined;
	if (boundary === checkpoint.id) return checkpointIndex;
	for (let index = 0; index < checkpointIndex; index++) {
		if (entries[index]!.id === boundary) return index;
	}
	return undefined;
}

/**
 * Whether a checkpoint may be replayed or reused, together with the edits its window is missing.
 *
 * The host projects the last edit per target on the active path. An edit recorded before the
 * checkpoint was already part of the input the checkpoint absorbed, so it stays valid even though
 * its entry still sits in the kept window. An edit recorded after the checkpoint that targets a
 * kept-window entry is not absorbed: the kept window is represented by the opaque window on the
 * wire, so reusing the checkpoint would resurrect the replaced content. Live-tail targets are
 * rewritable directly and never invalidate the window.
 *
 * An unresolvable boundary is reported as such. It never degrades into an empty kept window.
 */
export type CheckpointWindowInspection =
	| { ok: true; firstKeptEntryIndex: number; edits: ContextEdits | undefined }
	| { ok: false; reason: "first-kept-entry-not-found" | "context-edit-targets-compacted-content" };

export function inspectCheckpointWindow(args: {
	branchEntries: readonly SessionEntry[];
	checkpoint: CheckpointBoundary;
	checkpointIndex: number;
}): CheckpointWindowInspection {
	const firstKeptEntryIndex = findCheckpointFirstKeptEntryIndex(args.branchEntries, args.checkpoint, args.checkpointIndex);
	if (firstKeptEntryIndex === undefined) return { ok: false, reason: "first-kept-entry-not-found" };

	const keptIds = new Set<string>();
	const effective = new Map<string, PositionedContextEdit>();
	for (let index = firstKeptEntryIndex; index < args.checkpointIndex; index++) {
		const entry = args.branchEntries[index]!;
		keptIds.add(entry.id);
		const edit = readContextEdit(entry);
		if (edit) effective.set(edit.targetId, { edit, entryIndex: index });
	}
	for (let index = args.checkpointIndex + 1; index < args.branchEntries.length; index++) {
		const edit = readContextEdit(args.branchEntries[index]!);
		if (edit) effective.set(edit.targetId, { edit, entryIndex: index });
	}

	let edits: Map<string, ContextEdit> | undefined;
	for (const [targetId, positioned] of effective) {
		if (positioned.entryIndex > args.checkpointIndex && keptIds.has(targetId)) {
			return { ok: false, reason: "context-edit-targets-compacted-content" };
		}
		(edits ??= new Map()).set(targetId, positioned.edit);
	}
	return { ok: true, firstKeptEntryIndex, edits };
}

function replaceMessageContent(message: { role?: unknown; content?: unknown }, replacement: { content: unknown }): unknown {
	// The host normalizes a string replacement for assistant/toolResult content back to a text part.
	return (message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
		? [{ type: "text", text: replacement.content }]
		: replacement.content;
}

/**
 * Project entries the way the host projects model context: drop entries whose edit omits them and
 * rewrite the content of the editable roles. Edit markers themselves never contribute messages.
 */
export function applyContextEdits(entries: readonly SessionEntry[], edits: ContextEdits | undefined): SessionEntry[] {
	if (!edits || edits.size === 0) return [...entries];
	const projected: SessionEntry[] = [];
	for (const entry of entries) {
		if (readContextEdit(entry)) continue;
		const edit = edits.get(entry.id);
		if (!edit) {
			projected.push(entry);
			continue;
		}
		if (edit.replacement === null) continue;
		if (entry.type === "custom_message") {
			projected.push({ ...entry, content: edit.replacement.content as typeof entry.content });
			continue;
		}
		if (entry.type === "message") {
			const message = entry.message as { role?: unknown; content?: unknown };
			if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
				projected.push({
					...entry,
					message: { ...entry.message, content: replaceMessageContent(message, edit.replacement) } as typeof entry.message,
				});
				continue;
			}
		}
		projected.push(entry);
	}
	return projected;
}
