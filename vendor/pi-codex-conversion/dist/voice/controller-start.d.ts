import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import { type RealtimeInitialMessageItem } from "./context.ts";
import { type VoiceState } from "./controller-support.ts";
import type { CodexRealtimePeer } from "./conversation/peer.ts";
import type { CodexRealtimeConversation } from "./conversation/session.ts";
import type { CodexVoiceSessionMessages } from "./session-messages.ts";
import type { CodexVoiceMode } from "./ui.ts";
export interface RealtimePeerPlan {
    createPeer(): CodexRealtimePeer;
    onActive?(session: CodexRealtimeConversation, peer: CodexRealtimePeer): void;
    onInactive?(session: CodexRealtimeConversation, error: Error, resuming: boolean): void;
    onStatus?(status: string): void;
}
export interface VoiceControllerRuntime {
    state: VoiceState;
    context?: ExtensionContext | undefined;
    config?: CodexConversionConfig | undefined;
    announcedMode?: CodexVoiceMode | undefined;
    startGeneration: number;
    startAbortController?: AbortController | undefined;
    voiceStatus: string;
    inputTooQuiet: boolean;
    realtimePeerPlan?: RealtimePeerPlan | undefined;
}
export interface PreparedRealtimeContext {
    initialItems: RealtimeInitialMessageItem[] | undefined;
    summary?: string | undefined;
}
export declare function prepareControllerRealtimeContext(options: {
    ctx: ExtensionContext;
    config: CodexConversionConfig;
    signal?: AbortSignal | undefined;
    onSummaryStatus?: ((active: boolean) => void) | undefined;
    sourceLeafId?: string | undefined;
    forceSummary?: boolean | undefined;
}): Promise<PreparedRealtimeContext>;
export declare function startControllerMode(options: {
    runtime: VoiceControllerRuntime;
    messages: CodexVoiceSessionMessages;
    ctx: ExtensionContext;
    config: CodexConversionConfig;
    mode: CodexVoiceMode;
    realtimePeerPlan?: RealtimePeerPlan | undefined;
    resume?: boolean | undefined;
    inputMuted?: boolean | undefined;
    preparedRealtimeContext?: PreparedRealtimeContext | undefined;
    signal?: AbortSignal | undefined;
    prepareRealtimePrompt(ctx: ExtensionContext): string | undefined;
    stopCurrent(): Promise<void>;
    finishCurrentDictation(): Promise<void>;
    onError(error: Error, session?: CodexRealtimeConversation | undefined): void;
    onDrop(session: CodexRealtimeConversation, error: Error): void;
    onStatus(status: string): void;
}): Promise<CodexRealtimeConversation | undefined>;
