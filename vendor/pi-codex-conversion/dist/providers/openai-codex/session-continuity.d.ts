import type { CanonicalHistoryDecision, ResponsesBody } from "./types.ts";
import type { CodexCompactionReplayDecision } from "../../adapter/compaction/diagnostics.ts";
export type CanonicalSessionToken = {
    laneIdentity: symbol;
    requestSequence: number;
};
export declare function recordCanonicalSessionResponse(args: {
    sessionId?: string | undefined;
    url: string;
    accountId: string;
    requestBody: ResponsesBody;
    reconstructedRequestBody?: ResponsesBody | undefined;
    responseItems: readonly unknown[];
    token?: CanonicalSessionToken | undefined;
}): void;
export declare function captureCanonicalSessionToken(sessionId: string | undefined): CanonicalSessionToken | undefined;
export declare function validateCanonicalSessionRequest(sessionId: string | undefined, url: string, accountId: string, preparedBody: ResponsesBody): CanonicalHistoryDecision | undefined;
export declare function canonicalCompactionPromptInput(sessionId: string, model: string, identity?: {
    url: string;
    accountId: string;
} | undefined, reconstructedInput?: readonly unknown[] | undefined): unknown[] | undefined;
export declare function resolveCanonicalCompactionPromptInput(sessionId: string, model: string, identity?: {
    url: string;
    accountId: string;
} | undefined, reconstructedInput?: readonly unknown[] | undefined): {
    input?: unknown[] | undefined;
    decision: CodexCompactionReplayDecision;
};
export declare function canonicalCompactionRequestBody(sessionId: string, model: string, identity: {
    url: string;
    accountId: string;
}): ResponsesBody | undefined;
export declare function clearCanonicalSessions(sessionId?: string): void;
