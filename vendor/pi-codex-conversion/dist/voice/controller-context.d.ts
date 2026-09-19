import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import { type PreparedRealtimeContext, type RealtimePeerPlan, type VoiceControllerRuntime } from "./controller-start.ts";
import type { CodexRealtimeConversation } from "./conversation/session.ts";
export interface RealtimeContextRefreshOptions {
    sourceLeafId?: string | undefined;
    signal?: AbortSignal | undefined;
}
interface RealtimeContextRefreshCallbacks {
    inputMuted(): boolean;
    holdDelegations(): () => void;
    replace(ctx: ExtensionContext, config: CodexConversionConfig, previous: CodexRealtimeConversation, plan: RealtimePeerPlan | undefined, inputMuted: boolean, prepared: PreparedRealtimeContext, signal: AbortSignal): Promise<void>;
}
export declare class RealtimeContextRefresh {
    private readonly runtime;
    private readonly callbacks;
    private abortController;
    constructor(runtime: VoiceControllerRuntime, callbacks: RealtimeContextRefreshCallbacks);
    cancel(): void;
    run(ctx: ExtensionContext, config: CodexConversionConfig, options?: RealtimeContextRefreshOptions): Promise<void>;
    private isCurrent;
}
export {};
