export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
export function withCodexTurnState(body, turnState) {
    const current = turnState?.current();
    return current
        ? { ...body, client_metadata: { ...(body.client_metadata ?? {}), [CODEX_TURN_STATE_HEADER]: current } }
        : body;
}
export function withCodexTurnStateHeader(headers, turnState) {
    const attemptHeaders = new Headers(headers);
    const current = turnState?.current();
    if (current)
        attemptHeaders.set(CODEX_TURN_STATE_HEADER, current);
    return attemptHeaders;
}
export function createCodexTurnState() {
    let value;
    let prewarmed = false;
    const capture = (next) => {
        if (value !== undefined || !next?.trim())
            return;
        value = next.trim();
    };
    return {
        current: () => value,
        capture,
        capturePrewarm(next) {
            capture(next);
            if (value !== undefined)
                prewarmed = true;
        },
        beginTurn() {
            if (prewarmed) {
                prewarmed = false;
                return;
            }
            value = undefined;
        },
        reset() {
            value = undefined;
            prewarmed = false;
        },
    };
}
export function extractCodexTurnStateFromWebSocketEvent(event) {
    if (!event || typeof event !== "object")
        return undefined;
    const type = event.type;
    if (type !== "response.metadata" && type !== "codex.response.metadata")
        return undefined;
    const headers = event.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers))
        return undefined;
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === CODEX_TURN_STATE_HEADER && typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
