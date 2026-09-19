import type { ExecSessionSnapshot, UnifiedExecResult } from "./session-manager.ts";
import { type ExecOutputSessionState } from "./output.ts";
export interface ExecResultSessionState extends ExecOutputSessionState {
    id: number;
    command: string;
    exitCode: number | null | undefined;
    startedAt: number;
    updatedAt: number;
    terminating: boolean;
}
export declare function makeExecResult<TSession extends ExecResultSessionState>(session: TSession, waitMs: number, maxOutputTokens: number | undefined, exposeSession: (session: TSession) => void, deleteSessionIfDrained: (sessionId: number) => void): UnifiedExecResult;
export declare function snapshotSession(session: ExecResultSessionState, maxOutputChars?: number): ExecSessionSnapshot;
export declare function makeSnapshotResult(session: ExecResultSessionState, waitMs: number, maxOutputTokens?: number, unconsumedOnly?: boolean): UnifiedExecResult;
export declare function makeSnapshotSince(session: ExecResultSessionState, waitMs: number, baselineOffset: number, maxOutputTokens?: number): UnifiedExecResult;
