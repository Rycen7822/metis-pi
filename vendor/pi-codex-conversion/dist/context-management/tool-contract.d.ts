export declare const HISTORY_ACTIONS: readonly ["list_windows", "list_items", "read_item", "search_contents"];
export declare const NOTES_ACTIONS: readonly ["list_files_by_prefix", "read_file", "search_contents", "append_to_file", "write_file"];
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];
export type NotesAction = (typeof NOTES_ACTIONS)[number];
export declare const HISTORY_DESCRIPTION = "Prior-window detail. Pass IDs unchanged. Search, never browse.";
export declare const NOTES_DESCRIPTION = "Cross-window checkpoints on virtual paths. Relative uses current agent; cross-agent uses <agent>/notes[/path].";
