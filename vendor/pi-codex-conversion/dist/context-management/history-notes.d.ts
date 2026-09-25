import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ContextManagementMode } from "../adapter/activation/config.ts";
import { HISTORY_PARAMETERS, NOTES_PARAMETERS, type NotesAction } from "./tool-contract.ts";
export interface CodexHistoryNotesDetails {
    codexHistoryNotes: Record<string, unknown>;
}
export declare function createHistoryNotesTools(pi?: Pick<ExtensionAPI, "appendEntry">, resolveMode?: (ctx: ExtensionContext) => ContextManagementMode, prepareNoteWrite?: (action: NotesAction, path: unknown, ctx: ExtensionContext) => () => boolean): [
    ToolDefinition<typeof HISTORY_PARAMETERS, CodexHistoryNotesDetails>,
    ToolDefinition<typeof NOTES_PARAMETERS, CodexHistoryNotesDetails>
];
export declare function loadHistoryNotesThreadHint(ctx: ExtensionContext, mode: ContextManagementMode, signal?: AbortSignal): Promise<string | undefined>;
export declare function usesRemoteHistoryNotes(ctx: Pick<ExtensionContext, "model" | "sessionManager">, mode: ContextManagementMode): boolean;
