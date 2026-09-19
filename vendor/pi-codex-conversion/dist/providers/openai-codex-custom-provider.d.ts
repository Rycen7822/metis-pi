import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { CodexDiagnosticsSink, CodexPrewarmDiagnostics, CodexPrewarmResult, OpenAICodexStreamOptions, ResponsesBody } from "./openai-codex/types.ts";
import { closeOpenAICodexWebSocketSessions } from "./openai-codex/websocket.ts";
import { type CodexTurnState } from "./openai-codex/turn-state.ts";
import { type CodexProviderRuntimeConfig } from "./openai-codex/transport-recovery.ts";
export { buildRequestBody } from "./openai-codex/request-body.ts";
export { parseSSE } from "./openai-codex/sse.ts";
export { buildCachedWebSocketRequestBody } from "./openai-codex/websocket-continuation.ts";
export { closeOpenAICodexWebSocketSessions };
export type { ResponsesBody } from "./openai-codex/types.ts";
export declare function closeOpenAICodexKeepaliveWebSocketSession(sessionId: string): void;
export declare function prewarmOpenAICodexWebSocket<TApi extends Api>(model: Model<TApi>, context: Context, options: OpenAICodexStreamOptions, deps: {
    getConfig?: () => CodexProviderRuntimeConfig | undefined;
    useResponsesLite?: (model: Model<Api>) => boolean;
    turnState?: CodexTurnState | undefined;
    getDiagnostics?: (() => CodexDiagnosticsSink | undefined) | undefined;
    preserveContinuation?: boolean | undefined;
    retainSocket?: boolean | undefined;
    generate?: boolean | undefined;
    prewarmDiagnostics?: CodexPrewarmDiagnostics | undefined;
}): Promise<CodexPrewarmResult | undefined>;
export declare function registerOpenAICodexCustomProvider(pi: ExtensionAPI, options: {
    getConfig?: () => CodexProviderRuntimeConfig | undefined;
    useResponsesLite?: (model: Model<Api>) => boolean;
    turnState?: CodexTurnState | undefined;
    onPreparedPayload?: ((payload: ResponsesBody) => void) | undefined;
    getDiagnostics?: (() => CodexDiagnosticsSink | undefined) | undefined;
}): void;
