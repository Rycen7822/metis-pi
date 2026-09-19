import type { CodeModeHostSession } from "./host-session.js";
export declare function cancelOperation(session: CodeModeHostSession, id: number): Error;
export declare function operationAbort(session: CodeModeHostSession, id: number): () => void;
export declare function abortError(): Error;
export declare function throwIfAborted(signal?: AbortSignal): void;
export declare function toError(error: unknown): Error;
