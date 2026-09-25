import type { ExecSessionSnapshot, UnifiedExecResult } from "./session-manager.ts";
import { consumeOutput, generateChunkId, peekOutputSince, peekUnconsumedOutput, type ExecOutputSessionState } from "./output.ts";

export interface ExecResultSessionState extends ExecOutputSessionState {
	id: number;
	command: string;
	exitCode: number | null | undefined;
	startedAt: number;
	updatedAt: number;
	terminating: boolean;
}

function fromSnapshot(session: ExecResultSessionState, waitMs: number, snapshot: { output: string; original_token_count?: number | undefined }): UnifiedExecResult {
	const result: UnifiedExecResult = { chunk_id: generateChunkId(), wall_time_seconds: waitMs / 1000, output: snapshot.output };
	if (snapshot.original_token_count !== undefined) result.original_token_count = snapshot.original_token_count;
	if (session.exitCode === undefined || session.exitCode === null) result.session_id = session.id;
	else result.exit_code = session.exitCode;
	return result;
}

export function makeExecResult(session: ExecResultSessionState, waitMs: number, maxOutputTokens: number | undefined): UnifiedExecResult {
	return fromSnapshot(session, waitMs, consumeOutput(session, maxOutputTokens));
}

export function snapshotSession(session: ExecResultSessionState, maxOutputChars = 8_000): ExecSessionSnapshot {
	return {
		id: session.id,
		command: session.command,
		running: session.exitCode === undefined || session.exitCode === null,
		exitCode: session.exitCode ?? undefined,
		startedAt: session.startedAt,
		updatedAt: session.updatedAt,
		outputTail: session.buffer.slice(-maxOutputChars),
		terminating: session.terminating,
	};
}

export function makeSnapshotResult(session: ExecResultSessionState, waitMs: number, maxOutputTokens?: number, unconsumedOnly = false): UnifiedExecResult {
	const snapshot = unconsumedOnly ? peekUnconsumedOutput(session, maxOutputTokens) : peekOutputSince(session, session.buffer.startOffset, maxOutputTokens);
	return fromSnapshot(session, waitMs, snapshot);
}

export function makeSnapshotSince(session: ExecResultSessionState, waitMs: number, baselineOffset: number, maxOutputTokens?: number): UnifiedExecResult {
	return fromSnapshot(session, waitMs, peekOutputSince(session, baselineOffset, maxOutputTokens));
}
