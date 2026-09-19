export function rewriteWindowPayload(payload, ctx, identity) {
    if (!identity || !isRecord(payload))
        return payload;
    const metadata = requestMetadata(ctx, identity);
    const clientMetadata = isRecord(payload["client_metadata"])
        ? payload["client_metadata"]
        : {};
    return {
        ...payload,
        client_metadata: {
            ...clientMetadata,
            "x-codex-window-id": metadata.window_id,
            "x-codex-turn-metadata": JSON.stringify(metadata),
        },
    };
}
export function rewriteWindowHeaders(headers, ctx, identity) {
    if (!identity)
        return;
    const metadata = requestMetadata(ctx, identity);
    headers["x-codex-window-id"] = metadata.window_id;
    headers["x-codex-turn-metadata"] = JSON.stringify(metadata);
}
function requestMetadata(ctx, identity) {
    const sessionId = ctx.sessionManager.getSessionId();
    return {
        session_id: sessionId,
        thread_id: sessionId,
        agent_name: "/root",
        window_id: `${sessionId}:${identity.windowNumber}`,
        window_number: identity.windowNumber,
        context_window_id: identity.currentWindowId,
        request_kind: "turn",
        history_ingest_requested: true,
    };
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
