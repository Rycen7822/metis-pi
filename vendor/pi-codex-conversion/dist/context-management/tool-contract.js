export const HISTORY_ACTIONS = [
    "list_windows",
    "list_items",
    "read_item",
    "search_contents",
];
export const NOTES_ACTIONS = [
    "list_files_by_prefix",
    "read_file",
    "search_contents",
    "append_to_file",
    "write_file",
];
export const HISTORY_DESCRIPTION = "Prior-window detail. Pass IDs unchanged. Search, never browse.";
export const NOTES_DESCRIPTION = "Cross-window checkpoints on virtual paths. Relative uses current agent; cross-agent uses <agent>/notes[/path].";
