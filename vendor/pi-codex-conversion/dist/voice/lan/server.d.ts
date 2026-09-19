import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { CodexVoiceAuth } from "../auth.ts";
import type { CodexVoiceController } from "../controller.ts";
export interface CodexLanVoiceServer {
    readonly ownerSessionId: string;
    readonly urls: string[];
    agentStarted(): void;
    agentSettled(text?: string): void;
    uiPromptStarted(title?: string): void;
    uiPromptEnded(agentRunning: boolean): void;
    close(): Promise<void>;
}
export declare function startCodexLanVoiceServer(options: {
    ctx: ExtensionContext;
    getConfig: () => CodexConversionConfig;
    voice: CodexVoiceController;
    resolveAuth(): Promise<CodexVoiceAuth>;
    sendUserMessage(text: string): void;
    ownerSessionId: string;
    port?: number | undefined;
    certificateAgentDir: string;
}): Promise<CodexLanVoiceServer>;
