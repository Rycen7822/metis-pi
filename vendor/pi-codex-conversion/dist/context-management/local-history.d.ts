import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextManagementMode } from "../adapter/activation/config.ts";
type LocalHistoryAction = "list_windows" | "list_items" | "read_item" | "search_contents";
export interface LocalHistoryRecoveryHint {
    window_id: string;
    summary_item_id?: string | undefined;
    user_item_ids?: string[] | undefined;
}
export declare function getPiSessionHistoryRecoveryHint(ctx: ExtensionContext, mode: ContextManagementMode): LocalHistoryRecoveryHint | undefined;
export declare function readPiSessionHistory(action: LocalHistoryAction, params: Record<string, unknown>, ctx: ExtensionContext, mode?: ContextManagementMode): Record<string, unknown>;
export {};
