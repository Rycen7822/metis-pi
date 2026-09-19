import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexRealtimeConversation } from "./conversation/session.ts";
import type { RealtimeVoiceEventDetails } from "./conversation/wire.ts";
import type { RealtimeVoiceTurn } from "./turns.ts";
import { type CodexVoiceMode } from "./ui.ts";
export interface PreparedVoiceDelegation {
    commit(): boolean;
    rollback(): void;
}
export interface CodexVoiceSessionMessageCallbacks {
    canDelegate(): boolean;
    prepareDelegation(ctx: ExtensionContext, signal: AbortSignal): Promise<PreparedVoiceDelegation | undefined>;
    onDelegation(id: string, input: string, source: CodexRealtimeConversation | undefined): void;
    onDelegationFailed(id: string): void;
    onWorking(): void;
}
export declare class CodexVoiceSessionMessages {
    private readonly pi;
    private readonly callbacks;
    private context;
    private piTurnActive;
    private dictationAnnounced;
    private delegationTail;
    private delegationAbortController;
    private compactionBarrier;
    private contextGeneration;
    private readonly refreshBarriers;
    constructor(pi: ExtensionAPI, callbacks: CodexVoiceSessionMessageCallbacks);
    setContext(ctx: ExtensionContext): void;
    contextSummary(summary: string): void;
    realtimeEvent(event: RealtimeVoiceEventDetails): void;
    userTranscript(transcript: string): void;
    modeStarted(mode: CodexVoiceMode): void;
    resetContextAnnouncements(): void;
    resetSessionContext(): void;
    conversationInputStopped(): void;
    voiceStopped(mode?: CodexVoiceMode): void;
    voiceTurn(turn: RealtimeVoiceTurn, source?: CodexRealtimeConversation): Promise<void>;
    waitForDelegations(): Promise<void>;
    cancelPendingDelegations(): void;
    holdDelegationsForRefresh(): () => void;
    compactionStarted(): void;
    compactionFinished(): void;
    retainTranscriptTail(transcriptDelta: string): void;
    filterContext(messages: ContextEvent["messages"]): ContextEvent["messages"];
    agentStarted(): void;
    agentSettled(): void;
    private appendMode;
    private replaceContext;
    private deliverDelegation;
}
