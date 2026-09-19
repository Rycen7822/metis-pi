export interface WaitableSession {
    exitCode: number | null | undefined;
    outputVersion: number;
    listeners: Set<() => void>;
}
export declare function registerAbortHandler(signal: AbortSignal | undefined, onAbort: () => void): () => void;
export declare function waitForExitOrInactivity(session: WaitableSession, idleTimeMs: number, maxWaitMs?: number, signal?: AbortSignal, onUpdate?: (elapsedMs: number) => void): Promise<number>;
