import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type StartContextWindowOptions, CodexContextWindowManager } from "./window-manager.ts";
export interface StartContextWindowKickoffOptions extends StartContextWindowOptions {
    triggerTurn: boolean;
}
export declare class CodexContextWindowKickoff {
    private readonly windows;
    private readonly onContinue;
    private continuation;
    private postCompactionWindow;
    constructor(windows: CodexContextWindowManager, onContinue?: (input: Parameters<ExtensionAPI["sendUserMessage"]>[0]) => void);
    reset(): void;
    get pending(): boolean;
    startWindow(pi: ExtensionAPI, ctx: ExtensionContext, options: StartContextWindowKickoffOptions): Promise<boolean>;
    schedulePostCompactionWindow(ctx: ExtensionContext, options: StartContextWindowKickoffOptions): void;
    settlePostCompaction(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean>;
    queueInput(content: Parameters<ExtensionAPI["sendUserMessage"]>[0]): void;
    continue(pi: ExtensionAPI, ctx: ExtensionContext): boolean;
}
