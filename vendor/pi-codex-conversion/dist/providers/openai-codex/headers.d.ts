export { headersToRecord } from "./header-record.ts";
type ProviderHeaders = Record<string, string | null>;
export declare const PI_CODEX_CONVERSION_ORIGINATOR = "pi-codex-conversion";
export declare const CODEX_FAST_MODE_ORIGINATOR = "codex_cli_rs";
export declare const X_CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
export interface CodexRequestRouting {
    originator: string;
    routingHint?: string | undefined;
}
export declare function resolveCodexRequestRouting(options: {
    model: string;
    fast: boolean;
    serviceTier?: string | undefined;
    normalOriginator?: string | undefined;
}): CodexRequestRouting;
export declare function extractAccountId(token: string): string;
export declare function resolveCodexUrl(baseUrl: string | undefined): string;
export declare function resolveCodexWebSocketUrl(baseUrl: string | undefined): string;
export declare function createCodexRequestId(): string;
export declare function buildSSEHeaders(modelHeaders: Record<string, string> | undefined, additionalHeaders: ProviderHeaders | undefined, accountId: string, token: string, sessionId: string | undefined, responsesLite?: boolean, originator?: string, routingHint?: string | undefined): Headers;
export declare function buildWebSocketHeaders(modelHeaders: Record<string, string> | undefined, additionalHeaders: ProviderHeaders | undefined, accountId: string, token: string, requestId: string, originator?: string, routingHint?: string | undefined): Headers;
