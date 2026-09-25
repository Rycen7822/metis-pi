import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export const HISTORY_DESCRIPTION = "Prior-window detail. Pass IDs unchanged. Search, never browse.";
export const NOTES_DESCRIPTION = "Cross-window checkpoints on virtual paths. Relative uses current agent; cross-agent uses <agent>/notes[/path].";
// Flat routers expose optional fields because requirements depend on action.
// Operations below select from these same typed fields, then narrow required
// arguments for namespace declarations and execution-time validation.
const HISTORY_FIELDS = Type.Object({
    agent_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    item_id: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    limit_chars: Type.Optional(Type.Integer({ minimum: 1 })),
    max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1 })),
    offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
    query: Type.Optional(Type.String()),
    recent_first: Type.Optional(Type.Boolean()),
    role: Type.Optional(Type.Union([
        StringEnum(["user", "assistant", "tool", "system", "developer"]),
        Type.Null(),
    ])),
    tool_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    tool_namespace: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    window_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const NOTES_FIELDS = Type.Object({
    file_order: Type.Optional(StringEnum(["ascending", "descending"])),
    file_order_by: Type.Optional(StringEnum(["name", "created_at", "updated_at"])),
    max_files: Type.Optional(Type.Integer({ minimum: 1 })),
    max_matches_per_file: Type.Optional(Type.Integer({ minimum: 1 })),
    max_results: Type.Optional(Type.Integer({ minimum: 1 })),
    path: Type.Optional(Type.String()),
    path_prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    query: Type.Optional(Type.String()),
    recent_file_first: Type.Optional(Type.Boolean()),
    start_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    stop_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    text: Type.Optional(Type.String()),
});
const NOTE_WRITE_ARGUMENTS = {
    parameters: Type.Required(Type.Pick(NOTES_FIELDS, ["path", "text"]), {
        required: ["text", "path"],
    }),
    encryptedField: "text",
    allowEmpty: ["text"],
};
export const CONTEXT_OPERATIONS = {
    history: {
        list_windows: {
            description: "List context windows",
            parameters: Type.Pick(HISTORY_FIELDS, ["agent_name", "limit", "recent_first"]),
        },
        list_items: {
            description: "List history items",
            parameters: Type.Pick(HISTORY_FIELDS, [
                "agent_name", "limit", "max_chars_per_item", "recent_first",
                "role", "tool_name", "tool_namespace", "window_id",
            ]),
        },
        read_item: {
            description: "Read history item range",
            parameters: Type.Object({
                ...Type.Pick(HISTORY_FIELDS, ["agent_name", "item_id", "limit_chars", "offset_chars", "window_id"]).properties,
                item_id: Type.String({ description: "Suffix from the item's [id: …] marker." }),
                // Unlike the other history operations, read_item needs a concrete window.
                window_id: Type.String(),
            }),
        },
        search_contents: {
            description: "Search history",
            parameters: Type.Object({
                ...Type.Pick(HISTORY_FIELDS, [
                    "agent_name", "limit", "query", "recent_first",
                    "role", "tool_name", "tool_namespace", "window_id",
                ]).properties,
                query: Type.String({ description: "Case-sensitive" }),
            }),
            encryptedField: "query",
        },
    },
    notes: {
        list_files_by_prefix: {
            description: "List note files",
            parameters: Type.Pick(NOTES_FIELDS, ["file_order", "file_order_by", "max_results", "prefix"]),
        },
        read_file: {
            description: "Read note file; line bounds inclusive, 1-based, negative from end",
            parameters: Type.Object({
                ...Type.Pick(NOTES_FIELDS, ["path", "start_line", "stop_line"]).properties,
                path: Type.String(),
            }),
        },
        search_contents: {
            description: "Search note lines by literal substring",
            parameters: Type.Object({
                ...Type.Pick(NOTES_FIELDS, ["max_files", "max_matches_per_file", "path_prefix", "query", "recent_file_first"]).properties,
                query: Type.String({ description: "Case-sensitive" }),
            }),
            encryptedField: "query",
        },
        append_to_file: { description: "Append text exactly", ...NOTE_WRITE_ARGUMENTS },
        write_file: { description: "Create or replace a note file", ...NOTE_WRITE_ARGUMENTS },
    },
};
export const HISTORY_ACTIONS = Object.keys(CONTEXT_OPERATIONS.history);
export const NOTES_ACTIONS = Object.keys(CONTEXT_OPERATIONS.notes);
export const HISTORY_PARAMETERS = Type.Object({ action: StringEnum(HISTORY_ACTIONS), ...HISTORY_FIELDS.properties }, { additionalProperties: false });
export const NOTES_PARAMETERS = Type.Object({ action: StringEnum(NOTES_ACTIONS), ...NOTES_FIELDS.properties }, { additionalProperties: false });
