import { consumeOutput, generateChunkId, peekOutputSince, peekUnconsumedOutput } from "./output.js";
function fromSnapshot(session, waitMs, snapshot, originalChars) {
    const result = { chunk_id: generateChunkId(), wall_time_seconds: waitMs / 1000, output: snapshot.output };
    if (snapshot.original_token_count !== undefined)
        result.original_token_count = snapshot.original_token_count;
    if (session.exitCode === undefined || session.exitCode === null)
        result.session_id = session.id;
    else
        result.exit_code = session.exitCode;
    if (snapshot.output.length < originalChars)
        session.buffer.archive?.preserve();
    Object.assign(result, session.buffer.archive?.info());
    return result;
}
export function makeExecResult(session, waitMs, maxOutputTokens) {
    const originalChars = session.buffer.endOffset - session.emittedOffset;
    return fromSnapshot(session, waitMs, consumeOutput(session, maxOutputTokens), originalChars);
}
export function snapshotSession(session, maxOutputChars = 8_000) {
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
export function makeSnapshotResult(session, waitMs, maxOutputTokens, unconsumedOnly = false) {
    const snapshot = unconsumedOnly ? peekUnconsumedOutput(session, maxOutputTokens) : peekOutputSince(session, session.buffer.startOffset, maxOutputTokens);
    const start = unconsumedOnly ? session.emittedOffset : session.buffer.startOffset;
    return fromSnapshot(session, waitMs, snapshot, session.buffer.endOffset - start);
}
export function makeSnapshotSince(session, waitMs, baselineOffset, maxOutputTokens) {
    return fromSnapshot(session, waitMs, peekOutputSince(session, baselineOffset, maxOutputTokens), session.buffer.endOffset - baselineOffset);
}
