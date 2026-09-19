import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import { type RealtimePeerPlan } from "./controller-start.ts";
import { type RealtimeContextRefreshOptions } from "./controller-context.ts";
import type { CodexRealtimeConversation } from "./conversation/session.ts";
import { type PreparedVoiceDelegation } from "./session-messages.ts";
import type { CodexVoiceMode } from "./ui.ts";
export declare class CodexVoiceController {
    private readonly runtime;
    private readonly messages;
    private readonly contextRefresh;
    private readonly inputMuteListeners;
    private readonly activePrompts;
    private delegationPreflight;
    constructor(pi: ExtensionAPI);
    setDelegationPreflight(preflight: (ctx: ExtensionContext, signal: AbortSignal) => Promise<PreparedVoiceDelegation | undefined>): void;
    setPrompt(report: {
        id: string;
        active: boolean;
        prompt: string;
    }): void;
    announceContextTransition(reason: "threshold" | "overflow" | "rollover"): void;
    compactionStarted(): void;
    compactionFinished(): void;
    get status(): string;
    get active(): boolean;
    get activeMode(): CodexVoiceMode | undefined;
    get inputMuted(): boolean;
    onInputMuteChange(listener: (muted: boolean) => void): () => void;
    setInputMuted(muted: boolean): boolean;
    setInputTooQuiet(inputTooQuiet: boolean): void;
    resetContextAnnouncements(): void;
    resetSessionContext(): void;
    announceDictation(ctx: ExtensionContext): void;
    start(ctx: ExtensionContext, config: CodexConversionConfig, mode: CodexVoiceMode): Promise<void>;
    startRealtimeWithPeerPlan(ctx: ExtensionContext, config: CodexConversionConfig, plan: RealtimePeerPlan, signal?: AbortSignal): Promise<CodexRealtimeConversation | undefined>;
    refreshRealtimeContext(ctx: ExtensionContext, config: CodexConversionConfig, options?: RealtimeContextRefreshOptions): Promise<void>;
    prepareRealtimePrompt(ctx: ExtensionContext): string | undefined;
    stopConversation(session: CodexRealtimeConversation, options?: {
        announce?: boolean;
    }): Promise<void>;
    stopRealtimeWithPeerPlan(plan: RealtimePeerPlan, options?: {
        announce?: boolean;
    }): Promise<void>;
    setConversationInputActive(session: CodexRealtimeConversation, active: boolean): void;
    private startMode;
    stop(options?: {
        announce?: boolean;
    }): Promise<void>;
    finishDictation(options?: {
        announce?: boolean;
    }): Promise<void>;
    agentStarted(): void;
    filterContext(messages: ContextEvent["messages"]): ContextEvent["messages"];
    piInput(input: unknown, streamingBehavior?: "steer" | "followUp"): boolean;
    piUserMessage(message: unknown): boolean;
    streamDelta(delta: string): void;
    finishAgentMessage(message: AssistantMessage, forwardReasoningSummaries: boolean): void;
    settleTurn(): void;
    private currentSession;
    private replaceRealtimeContext;
    private fail;
    private drop;
    private renderStatus;
    private renderCurrentStatus;
}
