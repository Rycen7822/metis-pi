import { Type, type TObject } from "typebox";
export declare const HISTORY_DESCRIPTION = "Prior-window detail. Pass IDs unchanged. Search, never browse.";
export declare const NOTES_DESCRIPTION = "Cross-window checkpoints on virtual paths. Relative uses current agent; cross-agent uses <agent>/notes[/path].";
export interface ContextOperation {
    description: string;
    parameters: TObject;
    encryptedField?: "query" | "text";
    /** Required IDs, paths and queries must be nonempty; note text need not be. */
    allowEmpty?: readonly string[];
}
export declare const CONTEXT_OPERATIONS: {
    history: {
        list_windows: {
            description: string;
            parameters: Type.TObject<{
                agent_name: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                limit: Type.TOptional<Type.TInteger>;
                recent_first: Type.TOptional<Type.TBoolean>;
            }>;
        };
        list_items: {
            description: string;
            parameters: Type.TObject<{
                agent_name: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                limit: Type.TOptional<Type.TInteger>;
                max_chars_per_item: Type.TOptional<Type.TInteger>;
                recent_first: Type.TOptional<Type.TBoolean>;
                role: Type.TOptional<Type.TUnion<[Type.TUnsafe<"assistant" | "system" | "user" | "tool" | "developer">, Type.TNull]>>;
                tool_name: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                tool_namespace: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                window_id: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            }>;
        };
        read_item: {
            description: string;
            parameters: Type.TObject<{
                item_id: Type.TString;
                window_id: Type.TString;
                agent_name: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                limit_chars: Type.TOptional<Type.TInteger>;
                offset_chars: Type.TOptional<Type.TInteger>;
            }>;
        };
        search_contents: {
            description: string;
            parameters: Type.TObject<{
                query: Type.TString;
                agent_name: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                limit: Type.TOptional<Type.TInteger>;
                recent_first: Type.TOptional<Type.TBoolean>;
                role: Type.TOptional<Type.TUnion<[Type.TUnsafe<"assistant" | "system" | "user" | "tool" | "developer">, Type.TNull]>>;
                tool_name: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                tool_namespace: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                window_id: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            }>;
            encryptedField: "query";
        };
    };
    notes: {
        list_files_by_prefix: {
            description: string;
            parameters: Type.TObject<{
                file_order: Type.TOptional<Type.TUnsafe<"ascending" | "descending">>;
                file_order_by: Type.TOptional<Type.TUnsafe<"name" | "created_at" | "updated_at">>;
                max_results: Type.TOptional<Type.TInteger>;
                prefix: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            }>;
        };
        read_file: {
            description: string;
            parameters: Type.TObject<{
                path: Type.TString;
                start_line: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
                stop_line: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
            }>;
        };
        search_contents: {
            description: string;
            parameters: Type.TObject<{
                query: Type.TString;
                max_files: Type.TOptional<Type.TInteger>;
                max_matches_per_file: Type.TOptional<Type.TInteger>;
                path_prefix: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                recent_file_first: Type.TOptional<Type.TBoolean>;
            }>;
            encryptedField: "query";
        };
        append_to_file: {
            parameters: Type.TObject<{
                path: Type.TString;
                text: Type.TString;
            }>;
            encryptedField: "text";
            allowEmpty: readonly ["text"];
            description: string;
        };
        write_file: {
            parameters: Type.TObject<{
                path: Type.TString;
                text: Type.TString;
            }>;
            encryptedField: "text";
            allowEmpty: readonly ["text"];
            description: string;
        };
    };
};
export type HistoryAction = keyof typeof CONTEXT_OPERATIONS.history;
export type NotesAction = keyof typeof CONTEXT_OPERATIONS.notes;
export declare const HISTORY_ACTIONS: HistoryAction[];
export declare const NOTES_ACTIONS: NotesAction[];
export declare const HISTORY_PARAMETERS: Type.TObject<{
    agent_name: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    item_id: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TInteger>;
    limit_chars: Type.TOptional<Type.TInteger>;
    max_chars_per_item: Type.TOptional<Type.TInteger>;
    offset_chars: Type.TOptional<Type.TInteger>;
    query: Type.TOptional<Type.TString>;
    recent_first: Type.TOptional<Type.TBoolean>;
    role: Type.TOptional<Type.TUnion<[Type.TUnsafe<"assistant" | "system" | "user" | "tool" | "developer">, Type.TNull]>>;
    tool_name: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    tool_namespace: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    window_id: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    action: Type.TUnsafe<"list_windows" | "list_items" | "read_item" | "search_contents">;
}>;
export declare const NOTES_PARAMETERS: Type.TObject<{
    file_order: Type.TOptional<Type.TUnsafe<"ascending" | "descending">>;
    file_order_by: Type.TOptional<Type.TUnsafe<"name" | "created_at" | "updated_at">>;
    max_files: Type.TOptional<Type.TInteger>;
    max_matches_per_file: Type.TOptional<Type.TInteger>;
    max_results: Type.TOptional<Type.TInteger>;
    path: Type.TOptional<Type.TString>;
    path_prefix: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    prefix: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    query: Type.TOptional<Type.TString>;
    recent_file_first: Type.TOptional<Type.TBoolean>;
    start_line: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
    stop_line: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
    text: Type.TOptional<Type.TString>;
    action: Type.TUnsafe<"search_contents" | "list_files_by_prefix" | "read_file" | "append_to_file" | "write_file">;
}>;
