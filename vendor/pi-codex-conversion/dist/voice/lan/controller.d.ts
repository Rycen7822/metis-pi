import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { CodexVoiceController } from "../controller.ts";
export interface CodexLanVoiceServerStatus {
    running: boolean;
    urls: string[];
}
export declare class CodexLanVoiceServerController {
    private readonly voice;
    private readonly getConfig;
    private readonly sendUserMessage;
    private readonly agentDir;
    private server;
    private pendingAssistantText;
    private operation;
    constructor(voice: CodexVoiceController, getConfig: () => CodexConversionConfig, sendUserMessage: (text: string, ctx: ExtensionContext) => void, agentDir: string);
    status(): CodexLanVoiceServerStatus;
    setEnabled(enabled: boolean, ctx: ExtensionContext): Promise<CodexLanVoiceServerStatus>;
    stop(ctx?: ExtensionContext): Promise<void>;
    agentStarted(): void;
    uiPromptStarted(title?: string): void;
    uiPromptEnded(agentRunning: boolean): void;
    assistantMessage(message: AssistantMessage): void;
    agentSettled(): void;
    private stopCurrent;
    private enqueue;
}
