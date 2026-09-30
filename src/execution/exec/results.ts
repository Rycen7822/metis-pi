import { Type } from "typebox";
export const EXEC_OUTPUT_SCHEMA = Type.Object({
  output: Type.String(), chunk_id: Type.String(), wall_time_seconds: Type.Number(),
  session_id: Type.Optional(Type.Number()), exit_code: Type.Optional(Type.Number()),
  original_token_count: Type.Optional(Type.Number()), interrupted: Type.Optional(Type.Boolean()),
  fullOutputPath: Type.Optional(Type.String()), fullOutputBytes: Type.Optional(Type.Number()),
  fullOutputComplete: Type.Optional(Type.Boolean()), fullOutputAppendOnly: Type.Optional(Type.Boolean()),
  fullOutputError: Type.Optional(Type.String()),
});
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

function fromSnapshot(session: ExecResultSessionState, waitMs: number, snapshot: { output: string; original_token_count?: number | undefined }, originalChars: number): UnifiedExecResult {
	const result: UnifiedExecResult = { chunk_id: generateChunkId(), wall_time_seconds: waitMs / 1000, output: snapshot.output };
	if (snapshot.original_token_count !== undefined) result.original_token_count = snapshot.original_token_count;
	if (session.exitCode === undefined || session.exitCode === null) result.session_id = session.id;
	else result.exit_code = session.exitCode;
	if (snapshot.output.length < originalChars) session.buffer.archive?.preserve();
	Object.assign(result, session.buffer.archive?.info());
	return result;
}

export function makeExecResult(session: ExecResultSessionState, waitMs: number, maxOutputTokens: number | undefined): UnifiedExecResult {
	const originalChars = session.buffer.endOffset - session.emittedOffset;
	return fromSnapshot(session, waitMs, consumeOutput(session, maxOutputTokens), originalChars);
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
	const start = unconsumedOnly ? session.emittedOffset : session.buffer.startOffset;
	return fromSnapshot(session, waitMs, snapshot, session.buffer.endOffset - start);
}

export function makeSnapshotSince(session: ExecResultSessionState, waitMs: number, baselineOffset: number, maxOutputTokens?: number): UnifiedExecResult {
	return fromSnapshot(session, waitMs, peekOutputSince(session, baselineOffset, maxOutputTokens), session.buffer.endOffset - baselineOffset);
}

export function execStructuredContent(result: UnifiedExecResult): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(result).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined));
}
