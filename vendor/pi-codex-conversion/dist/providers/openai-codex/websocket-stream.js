import { normalizeTimeoutMs } from "./sse.js";
import { buildCachedWebSocketRequestBody } from "./websocket-continuation.js";
import { acquireWebSocket, parseWebSocket, startWebSocketOutputOnFirstEvent } from "./websocket.js";
import { assertSuccessfulCodexOutput, assertSuccessfulCodexStatus, mapCodexEvents, processMappedCodexResponsesStream } from "./stream-events.js";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS } from "./constants.js";
import { codexDiagnosticsFailure, noThrowCodexDiagnosticsSink } from "./diagnostic-failure.js";
import { recordCanonicalSessionResponse } from "./session-continuity.js";
export function codexCacheKeepaliveSocketSessionId(sessionId) {
    return `${sessionId}:cache-keepalive`;
}
export async function processWebSocketStream(url, body, headers, output, stream, model, accountId, onStart, options, turnState, diagnostics, canonical) {
    let streamStarted = false;
    const idleTimeoutMs = normalizeTimeoutMs(options?.timeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS, "timeoutMs");
    const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
    const { socket, entry, release, reused, socketAgeMs } = await acquireWebSocket(url, headers, options?.sessionId, accountId, options?.signal, websocketConnectTimeoutMs, options?.env);
    // Checkpoint validation happens after streaming; retire its server-side response state.
    let keepConnection = !options?.canonicalCompaction;
    let released = false;
    const responseItems = [];
    const transport = options?.transport ?? "auto";
    const useCachedContext = transport === "websocket-cached" || transport === "auto";
    // ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
    // WebSocket continuation still works via connection-scoped previous_response_id state.
    const fullBody = body;
    const cachedRequest = useCachedContext && entry
        ? buildCachedWebSocketRequestBody(entry.continuation, fullBody)
        : { body: fullBody, decision: useCachedContext ? "no_session_cache_entry" : "disabled" };
    const requestBody = cachedRequest.body;
    const recordDiagnostics = noThrowCodexDiagnosticsSink(diagnostics?.record);
    if (options?.compactionDiagnostics) {
        Object.assign(options.compactionDiagnostics, {
            transport: "websocket",
            continuation: cachedRequest.decision,
            previousResponseId: Boolean(requestBody.previous_response_id),
            fullInputItems: fullBody.input.length,
            sentInputItems: requestBody.input.length,
        });
    }
    const releaseOnce = (releaseOptions) => {
        if (released)
            return;
        released = true;
        release(releaseOptions);
    };
    try {
        if (diagnostics && recordDiagnostics) {
            recordDiagnostics({
                type: "request",
                lane: diagnostics.lane,
                transport: "websocket",
                attempt: diagnostics.attempt,
                fullInputItems: fullBody.input.length,
                sentInputItems: requestBody.input.length,
                model: fullBody.model,
                socketReused: reused,
                socketAgeMs,
                socketLane: "main",
                continuation: cachedRequest.decision,
                ...(entry?.continuation ? {
                    continuationBaselineInputItems: entry.continuation.lastRequestBody.input.length,
                    continuationBaselineResponseItems: entry.continuation.lastResponseItems.length,
                } : {}),
                ...(canonical?.decision ? { canonicalHistory: canonical.decision } : {}),
                ...(options?.compactionDiagnostics ? { compaction: structuredClone(options.compactionDiagnostics) } : {}),
                previousResponseId: Boolean(requestBody.previous_response_id),
            });
        }
        socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
        await processMappedCodexResponsesStream(startWebSocketOutputOnFirstEvent(mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs, (value) => turnState?.capture(value)), output), () => {
            if (!streamStarted) {
                streamStarted = true;
                onStart();
            }
        }), output, stream, model, {
            ...options,
            onOutputItemDone: (item) => responseItems.push(item),
        });
        if (options?.signal?.aborted) {
            keepConnection = false;
        }
        else {
            assertSuccessfulCodexOutput(output);
            for (const item of responseItems)
                options?.onOutputItemDone?.(item);
            // Compaction callers validate and store checkpoints. Until then its output
            // must not replace the sampling baseline, including on invalid-output failure.
            if (!options?.canonicalCompaction && useCachedContext && entry && output.responseId) {
                entry.continuation = {
                    lastRequestBody: fullBody,
                    lastResponseId: output.responseId,
                    lastResponseItems: responseItems,
                };
            }
            // A transient socket means another request already owns this session lane.
            // Its concurrent history has no canonical ordering, so only the retained
            // cached lane may advance the baseline used by later compaction.
            if (entry && !options?.canonicalCompaction) {
                recordCanonicalSessionResponse({
                    sessionId: options?.sessionId,
                    url,
                    accountId,
                    requestBody: fullBody,
                    reconstructedRequestBody: canonical?.reconstructedRequestBody,
                    responseItems,
                    token: canonical?.token,
                });
            }
        }
        releaseOnce({ keep: keepConnection });
    }
    catch (error) {
        if (entry)
            entry.continuation = undefined;
        keepConnection = false;
        releaseOnce({ keep: false });
        throw error;
    }
    finally {
        releaseOnce({ keep: keepConnection });
    }
}
export async function prewarmWebSocket(url, body, headers, accountId, options, turnState, diagnostics, preserveContinuation = false, prewarm = { kind: "ordinary" }, generate = false, retainSocket = true) {
    const recordDiagnostics = noThrowCodexDiagnosticsSink(diagnostics);
    const websocketConnectTimeoutMs = normalizeTimeoutMs(options.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
    const socketSessionId = preserveContinuation && options.sessionId
        ? codexCacheKeepaliveSocketSessionId(options.sessionId)
        : options.sessionId;
    const socketLane = preserveContinuation ? "keepalive" : "main";
    const { socket, entry, release, reused, socketAgeMs } = await acquireWebSocket(url, headers, socketSessionId, accountId, options.signal, websocketConnectTimeoutMs, options.env);
    let keepConnection = true;
    const responseItems = [];
    let responseId;
    let responseStatus;
    let usage;
    const idleTimeoutMs = normalizeTimeoutMs(options.timeoutMs ?? options.websocketConnectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, "timeoutMs");
    try {
        recordDiagnostics?.({
            type: "request",
            lane: "prewarm",
            transport: "websocket",
            attempt: 1,
            fullInputItems: body.input.length,
            sentInputItems: body.input.length,
            model: body.model,
            socketReused: reused,
            socketAgeMs,
            socketLane,
            prewarm,
            previousResponseId: Boolean(body.previous_response_id),
        });
        socket.send(JSON.stringify({ type: "response.create", ...body, ...(generate ? {} : { generate: false }) }));
        for await (const event of mapCodexEvents(parseWebSocket(socket, options.signal, idleTimeoutMs, (value) => {
            if (!preserveContinuation)
                turnState?.capturePrewarm(value);
        }))) {
            if (event.type === "response.created" && event.response?.id)
                responseId = event.response.id;
            if (event.type === "response.output_item.done" && event.item)
                responseItems.push(event.item);
            if (event.type === "response.completed") {
                if (event.response?.id)
                    responseId = event.response.id;
                responseStatus = event.response?.status;
                const responseUsage = event.response?.usage;
                if (responseUsage) {
                    const cacheRead = responseUsage.input_tokens_details?.cached_tokens ?? 0;
                    const cacheWrite = responseUsage.input_tokens_details?.cache_write_tokens ?? 0;
                    usage = {
                        inputTokens: Math.max(0, (responseUsage.input_tokens ?? 0) - cacheRead - cacheWrite),
                        cachedInputTokens: cacheRead,
                        cacheWriteInputTokens: cacheWrite,
                        ...(generate ? { outputTokens: responseUsage.output_tokens ?? 0 } : {}),
                    };
                }
            }
        }
        assertSuccessfulCodexStatus(responseStatus);
        if (!preserveContinuation && entry && responseId) {
            entry.continuation = { lastRequestBody: body, lastResponseId: responseId, lastResponseItems: responseItems };
        }
        recordDiagnostics?.({
            type: "prewarm-ready",
            transport: "websocket",
            socketReused: reused,
            socketAgeMs,
            socketLane,
            prewarm,
            ...(usage ? { usage } : {}),
        });
        return { socketReused: reused, ...(usage ? { usage } : {}) };
    }
    catch (error) {
        keepConnection = false;
        recordDiagnostics?.({
            type: "failure",
            lane: "prewarm",
            transport: "websocket",
            failure: codexDiagnosticsFailure(error),
        });
        throw error;
    }
    finally {
        release({ keep: keepConnection && retainSocket });
    }
}
