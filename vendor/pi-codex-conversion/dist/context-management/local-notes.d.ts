import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
export declare const CONTEXT_NOTE_SNAPSHOT_ENTRY_TYPE = "codex-context-note-snapshot";
type LocalNotesAction = "list_files_by_prefix" | "read_file" | "search_contents" | "append_to_file" | "write_file";
export interface NoteSnapshotData {
    protocol: 1;
    timestamp: number;
    files: Array<{
        path: string;
        text: string;
        createdAt: number;
        updatedAt: number;
    }>;
}
export declare function usePiSessionNotes(pi: Pick<ExtensionAPI, "appendEntry">, action: LocalNotesAction, params: Record<string, unknown>, ctx: ExtensionContext): Record<string, unknown>;
export declare function createPiSessionNotesSnapshot(entries: readonly SessionEntry[], path?: string): NoteSnapshotData;
export declare function renderPiSessionNotesThreadHint(entries: readonly SessionEntry[], maxBytes: number): string | undefined;
export {};
