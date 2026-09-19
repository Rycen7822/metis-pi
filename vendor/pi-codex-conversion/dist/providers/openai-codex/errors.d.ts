import type { AssistantMessage } from "@earendil-works/pi-ai";
export declare class NonRetryableProviderError extends Error {
}
export declare function formatCodexUsageLimitError(value: unknown): string | undefined;
export declare function isTerminalRateLimitError(errorText: string): boolean;
export declare function isRetryableRequestStatus(status: number): boolean;
export declare function isRetryableStreamStatus(status: number): boolean;
export declare function buildProviderErrorMessage(error: unknown): string;
export declare function createErrorMessage(message: AssistantMessage, error: unknown, aborted: boolean): AssistantMessage;
export declare function parseErrorResponse(response: Response): Promise<{
    message: string;
    friendlyMessage?: string | undefined;
    code?: string | undefined;
}>;
