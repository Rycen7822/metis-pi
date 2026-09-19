import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { AdapterState } from "../adapter/activation/state.ts";
import { type PiSystemPromptOptions } from "../prompt/build-system-prompt.ts";
import type { CodexPrewarmUsage } from "../providers/openai-codex/types.ts";
import { createExecCommandTracker } from "../tools/exec/command-state.ts";
import { createExecSessionManager } from "../tools/exec/session-manager.ts";
import type { BackgroundBashWidgetState } from "../ui/background-bash-widget.ts";
import { CodexVoiceController } from "../voice/controller.ts";
import { CodexLanVoiceServerController } from "../voice/lan/controller.ts";
import type { CodexDiagnosticsSink } from "../providers/openai-codex/types.ts";
import { createAutoReasoning } from "../adapter/auto-reasoning.ts";
export type CodexContext = ExtensionContext;
export type CodexPrewarmResult = {
    status: "ready";
    usage?: CodexPrewarmUsage | undefined;
    socketReused?: boolean | undefined;
} | {
    status: "skipped";
} | {
    status: "aborted";
} | {
    status: "failed";
    error: Error;
};
export interface CodexExtensionRuntime {
    autoReasoning: ReturnType<typeof createAutoReasoning>;
    state: AdapterState;
    tracker: ReturnType<typeof createExecCommandTracker>;
    sessions: ReturnType<typeof createExecSessionManager>;
    backgroundWidget: BackgroundBashWidgetState;
    voice: CodexVoiceController;
    lanVoice: CodexLanVoiceServerController;
    projectContextMessages(ctx: CodexContext, messages?: readonly AgentMessage[]): AgentMessage[];
    execEnv(config?: CodexConversionConfig): NodeJS.ProcessEnv;
    codexSystemPrompt(basePrompt: string, ctx: CodexContext, skills?: AdapterState["promptSkills"], systemPromptOptions?: PiSystemPromptOptions): string;
    startPrewarm(ctx: CodexContext, systemPrompt?: string, prepared?: boolean): Promise<CodexPrewarmResult> | undefined;
    startCompactionPrewarm(ctx: CodexContext): Promise<CodexPrewarmResult> | undefined;
    startKeepalivePrewarm(ctx: CodexContext): Promise<CodexPrewarmResult> | undefined;
    armCacheKeepalive(ctx: CodexContext): void;
    cancelCacheKeepalive(): void;
    resetTransport(sessionId?: string): void;
    resetTransportAfterCompaction(sessionId: string): void;
    shutdownTransport(sessionId: string): void;
    waitForPrewarm(ctx: CodexContext, systemPrompt: string): Promise<CodexPrewarmResult> | undefined;
    prewarmIdentity(ctx: CodexContext, systemPrompt: string): string | undefined;
    configureDiagnostics(ctx: CodexContext, announceLog?: boolean): Promise<void>;
    diagnosticsSink(): CodexDiagnosticsSink | undefined;
    shutdownDiagnostics(): Promise<void>;
}
export declare function createCodexExtensionRuntime(pi: ExtensionAPI): CodexExtensionRuntime;
