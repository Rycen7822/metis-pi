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
    replacement: {
        content: unknown;
    } | null;
};
export type ContextEdits = ReadonlyMap<string, ContextEdit>;
/** The checkpoint fields the boundary judgment needs; legacy 0.86 sessions can carry a null id. */
type CheckpointBoundary = {
    id: string;
    firstKeptEntryId: string | null | undefined;
};
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
export type CheckpointWindowInspection = {
    ok: true;
    firstKeptEntryIndex: number;
    edits: ContextEdits | undefined;
} | {
    ok: false;
    reason: "first-kept-entry-not-found" | "context-edit-targets-compacted-content";
};
export declare function inspectCheckpointWindow(args: {
    branchEntries: readonly SessionEntry[];
    checkpoint: CheckpointBoundary;
    checkpointIndex: number;
}): CheckpointWindowInspection;
/**
 * Project entries the way the host projects model context: drop entries whose edit omits them and
 * rewrite the content of the editable roles. Edit markers themselves never contribute messages.
 */
export declare function applyContextEdits(entries: readonly SessionEntry[], edits: ContextEdits | undefined): SessionEntry[];
export {};
