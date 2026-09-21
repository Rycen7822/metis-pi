import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ContextManagementMode } from "../adapter/activation/config.ts";
import { type NotesAction } from "./tool-contract.ts";
declare const HISTORY_PARAMETERS: Type.TObject<{
    action: Type.TUnsafe<"list_windows" | "list_items" | "read_item" | "search_contents">;
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
}>;
declare const NOTES_PARAMETERS: Type.TObject<{
    action: Type.TUnsafe<"search_contents" | "list_files_by_prefix" | "read_file" | "append_to_file" | "write_file">;
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
}>;
export interface CodexHistoryNotesDetails {
    codexHistoryNotes: Record<string, unknown>;
}
export declare function createHistoryNotesTools(pi?: Pick<ExtensionAPI, "appendEntry">, resolveMode?: (ctx: ExtensionContext) => ContextManagementMode, prepareNoteWrite?: (action: NotesAction, path: unknown, ctx: ExtensionContext) => () => boolean): [
    ToolDefinition<typeof HISTORY_PARAMETERS, CodexHistoryNotesDetails>,
    ToolDefinition<typeof NOTES_PARAMETERS, CodexHistoryNotesDetails>
];
export declare function loadHistoryNotesThreadHint(ctx: ExtensionContext, mode: ContextManagementMode, signal?: AbortSignal): Promise<string | undefined>;
export declare function usesRemoteHistoryNotes(ctx: Pick<ExtensionContext, "model" | "sessionManager">, mode: ContextManagementMode): boolean;
export {};
