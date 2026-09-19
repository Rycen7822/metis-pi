import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { RealtimePeerPlan, VoiceControllerRuntime } from "./controller-start.ts";
import type { VoiceSession } from "./controller-support.ts";
import type { CodexRealtimeConversation } from "./conversation/session.ts";
import type { CodexVoiceSessionMessages } from "./session-messages.ts";
interface RealtimeReconnectCallbacks {
    currentSession(): VoiceSession | undefined;
    fail(error: Error): void;
    inputMuted(): boolean;
    renderCurrentStatus(): void;
    renderStatus(status: string): void;
    startReplacement(ctx: ExtensionContext, config: CodexConversionConfig, plan: RealtimePeerPlan | undefined, inputMuted: boolean): Promise<CodexRealtimeConversation | undefined>;
}
/** Replaces an established realtime call without transferring LAN ownership. */
export declare function resumeDroppedConversation(options: {
    runtime: VoiceControllerRuntime;
    messages: CodexVoiceSessionMessages;
    session: CodexRealtimeConversation;
    error: Error;
    callbacks: RealtimeReconnectCallbacks;
}): void;
export declare function markRealtimePeerInactive(runtime: VoiceControllerRuntime, session: CodexRealtimeConversation, error: Error, resuming: boolean, plan?: RealtimePeerPlan | undefined): void;
export {};
