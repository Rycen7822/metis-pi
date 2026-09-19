import type { StreamEventShape } from "./types.ts";
export declare function compressRequestBodyZstd(bodyJson: string): Uint8Array | null;
export declare function sleep(ms: number, signal: AbortSignal | undefined): Promise<void>;
export declare function normalizeTimeoutMs(value: number | undefined, optionName: string): number | undefined;
export declare function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
    signal: AbortSignal;
    cleanup: () => void;
};
export declare function createSSEHeaderTimeout(timeoutMs: number): {
    signal: AbortSignal;
    clear: () => void;
    error: () => Error | undefined;
};
export declare function parseSSE(response: Response, signal?: AbortSignal, idleTimeoutMs?: number): AsyncIterable<StreamEventShape>;
