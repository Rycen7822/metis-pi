import { createHash } from "node:crypto";
import { closeWebSocketSilently, connectWebSocket, isWebSocketReusable, resolveWebSocketProxyForTarget } from "./websocket-connection.js";
import { clearCanonicalSessions } from "./session-continuity.js";
const websocketSessionCache = new Map();
const websocketSseFallbackSessions = new Set();
const CONTINUATION_HEADERS = new Set([
    "openai-beta",
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-codex-beta-features",
]);
function routeIdentityHeaders(headers) {
    return [...headers.entries()]
        .filter(([name]) => !CONTINUATION_HEADERS.has(name.toLowerCase()))
        .sort(([left], [right]) => left.localeCompare(right));
}
async function websocketRouteKey(url, headers, accountId, env) {
    const proxy = await resolveWebSocketProxyForTarget(url, env);
    const handshakeIdentity = JSON.stringify([
        accountId,
        new URL(url).href,
        proxy ?? null,
        routeIdentityHeaders(headers),
    ]);
    return createHash("sha256").update(handshakeIdentity).digest("base64url");
}
export function isWebSocketSseFallbackActive(sessionId) {
    return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}
export function recordWebSocketSseFallback(sessionId) {
    if (sessionId)
        websocketSseFallbackSessions.add(sessionId);
}
function closeWebSocketSessions(sessionId) {
    const closeEntry = (entry) => {
        closeWebSocketSilently(entry.socket, 1000, "session_shutdown");
    };
    if (sessionId) {
        for (const entry of websocketSessionCache.get(sessionId)?.values() ?? [])
            closeEntry(entry);
        websocketSessionCache.delete(sessionId);
        return;
    }
    for (const routeEntries of websocketSessionCache.values()) {
        for (const entry of routeEntries.values())
            closeEntry(entry);
    }
    websocketSessionCache.clear();
}
export function resetOpenAICodexWebSocketSessions(sessionId) {
    closeWebSocketSessions(sessionId);
    clearCanonicalSessions(sessionId);
}
export function closeOpenAICodexWebSocketSessions(sessionId) {
    closeWebSocketSessions(sessionId);
    clearCanonicalSessions(sessionId);
    if (sessionId) {
        websocketSseFallbackSessions.delete(sessionId);
        return;
    }
    websocketSseFallbackSessions.clear();
}
export async function acquireWebSocket(url, headers, sessionId, accountId, signal, connectTimeoutMs, env) {
    if (!sessionId) {
        const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
        return {
            socket,
            reused: false,
            socketAgeMs: 0,
            release: ({ keep } = {}) => {
                if (keep === false) {
                    closeWebSocketSilently(socket);
                    return;
                }
                closeWebSocketSilently(socket);
            },
        };
    }
    const routeKey = await websocketRouteKey(url, headers, accountId, env);
    let routeEntries = websocketSessionCache.get(sessionId);
    const cached = routeEntries?.get(routeKey);
    if (cached) {
        if (!cached.busy && isWebSocketReusable(cached.socket)) {
            cached.busy = true;
            return {
                socket: cached.socket,
                entry: cached,
                reused: true,
                socketAgeMs: Math.max(0, Date.now() - cached.createdAtMs),
                release: ({ keep } = {}) => {
                    if (!keep || !isWebSocketReusable(cached.socket)) {
                        closeWebSocketSilently(cached.socket);
                        const currentEntries = websocketSessionCache.get(sessionId);
                        if (currentEntries?.get(routeKey) === cached)
                            currentEntries.delete(routeKey);
                        if (currentEntries?.size === 0)
                            websocketSessionCache.delete(sessionId);
                        return;
                    }
                    cached.busy = false;
                },
            };
        }
        if (cached.busy) {
            const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
            return {
                socket,
                reused: false,
                socketAgeMs: 0,
                release: () => {
                    closeWebSocketSilently(socket);
                },
            };
        }
        if (!isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            routeEntries?.delete(routeKey);
            if (routeEntries?.size === 0)
                websocketSessionCache.delete(sessionId);
        }
    }
    const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
    const entry = { socket, busy: true, createdAtMs: Date.now() };
    routeEntries = websocketSessionCache.get(sessionId);
    if (!routeEntries) {
        routeEntries = new Map();
        websocketSessionCache.set(sessionId, routeEntries);
    }
    routeEntries.set(routeKey, entry);
    return {
        socket,
        entry,
        reused: false,
        socketAgeMs: 0,
        release: ({ keep } = {}) => {
            if (!keep || !isWebSocketReusable(entry.socket)) {
                closeWebSocketSilently(entry.socket);
                const currentEntries = websocketSessionCache.get(sessionId);
                if (currentEntries?.get(routeKey) === entry)
                    currentEntries.delete(routeKey);
                if (currentEntries?.size === 0)
                    websocketSessionCache.delete(sessionId);
                return;
            }
            entry.busy = false;
        },
    };
}
