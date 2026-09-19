import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { ExecSessionManager } from "../tools/exec/session-manager.ts";
export declare const BACKGROUND_BASH_WIDGET_ID = "codex-background-bashes";
export interface BackgroundBashWidgetState {
    activeSessionId?: number | undefined;
    folded: boolean;
    ctx?: ExtensionContext | undefined;
}
export declare function renderBackgroundBashWidget(ctx: ExtensionContext, state: BackgroundBashWidgetState, sessions: ExecSessionManager): void;
export declare function registerBackgroundBashWidgetShortcuts(pi: ExtensionAPI, state: BackgroundBashWidgetState, sessions: ExecSessionManager, config: Pick<CodexConversionConfig["ui"], "backgroundShellCloseShortcut" | "backgroundShellNextShortcut" | "backgroundShellPrevShortcut" | "backgroundShellToggleShortcut">, isEnabled: () => boolean): void;
