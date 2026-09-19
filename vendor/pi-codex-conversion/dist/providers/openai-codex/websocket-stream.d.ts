import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { CanonicalHistoryDecision, CodexDiagnosticsLane, CodexDiagnosticsSink, CodexPrewarmDiagnostics, CodexPrewarmResult, OpenAICodexStreamOptions, ResponsesBody } from "./types.ts";
import type { CodexTurnState } from "./turn-state.ts";
import { type CanonicalSessionToken } from "./session-continuity.ts";
export declare function codexCacheKeepaliveSocketSessionId(sessionId: string): string;
export declare function processWebSocketStream<TApi extends Api>(url: string, body: ResponsesBody, headers: Headers, output: AssistantMessage, stream: AssistantMessageEventStream, model: Model<TApi>, accountId: string, onStart: () => void, options: OpenAICodexStreamOptions | undefined, turnState?: CodexTurnState, diagnostics?: {
    lane: Exclude<CodexDiagnosticsLane, "prewarm">;
    attempt: number;
    record: CodexDiagnosticsSink;
} | undefined, canonical?: {
    reconstructedRequestBody: ResponsesBody;
    token?: CanonicalSessionToken | undefined;
    decision?: CanonicalHistoryDecision | undefined;
} | undefined): Promise<void>;
export declare function prewarmWebSocket(url: string, body: ResponsesBody, headers: Headers, accountId: string, options: OpenAICodexStreamOptions, turnState?: CodexTurnState, diagnostics?: CodexDiagnosticsSink | undefined, preserveContinuation?: boolean, prewarm?: CodexPrewarmDiagnostics, generate?: boolean, retainSocket?: boolean): Promise<CodexPrewarmResult>;
