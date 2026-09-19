import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { CodexTreeHandoff } from "./tree-handoff.ts";
import { CodexContextWindowManager } from "./window-manager.ts";
import { CodexContextWindowKickoff } from "./window-kickoff.ts";
export declare class CodexContextTreeCoordinator {
    readonly handoff: CodexTreeHandoff;
    private readonly windows;
    private readonly kickoff;
    private captured;
    private pending;
    private navigation;
    private queuedInputs;
    constructor(windows: CodexContextWindowManager, kickoff: CodexContextWindowKickoff);
    get archiving(): boolean;
    get rolloverPending(): boolean;
    register(pi: ExtensionAPI): void;
    beginSession(pi: ExtensionAPI): void;
    reset(): void;
    schedule(ctx: ExtensionContext, options?: {
        compactionEntryId?: string;
        triggerTurn?: boolean;
        sourceLeafId?: string | undefined;
    }): boolean;
    interceptInput(event: InputEvent): InputEventResult | undefined;
    handleSessionTree(event: SessionTreeEvent): boolean;
    settle(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean>;
    private assertReadyToNavigate;
    private restoreEditorAfterNavigation;
    private takeQueuedInputs;
    private restoreQueuedInputToEditor;
}
