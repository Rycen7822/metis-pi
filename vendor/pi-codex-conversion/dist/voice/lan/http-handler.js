import { getLanVoiceAppAsset } from "./app-assets.js";
import { LanVoiceDraftError } from "./draft.js";
const MAX_REQUEST_BYTES = 300 * 1024;
export async function handleLanVoiceHttpRequest(request, response, handlers) {
    let path = "/";
    try {
        const url = new URL(request.url ?? "/", "https://lan-voice.local");
        path = url.pathname;
        if (request.method === "GET" && path === "/") {
            sendText(response, "text/html; charset=utf-8", handlers.renderPage(), true);
            return;
        }
        if (request.method === "GET" && path === "/manifest.webmanifest") {
            sendText(response, "application/manifest+json; charset=utf-8", handlers.renderManifest());
            return;
        }
        const appAsset = request.method === "GET" ? getLanVoiceAppAsset(path) : undefined;
        if (appAsset) {
            sendBinary(response, appAsset.contentType, appAsset.body);
            return;
        }
        if (!handlers.ownerIsActive() || handlers.closing) {
            sendJson(response, 409, { error: "The Pi session that started this voice server is no longer active" });
            return;
        }
        if (request.method === "GET" && path === "/api/events") {
            const clientId = boundedString(url.searchParams.get("client"), 128);
            if (!clientId)
                throw new LanVoiceRequestError(400, "A browser client ID is required");
            response.writeHead(200, {
                "cache-control": "no-store",
                connection: "keep-alive",
                "content-type": "text/event-stream; charset=utf-8",
                "x-accel-buffering": "no",
            });
            response.write("event: ready\ndata: {}\n\n");
            handlers.clients.connectEvents(clientId, response);
            handlers.clients.sendControl(clientId, handlers.draft.snapshot());
            handlers.clients.sendControl(clientId, handlers.activity.snapshot());
            handlers.clients.sendControl(clientId, { type: "mute", muted: handlers.inputMuted() });
            return;
        }
        if (request.method !== "POST") {
            sendJson(response, 404, { error: "Not found" });
            return;
        }
        const body = await readJson(request);
        if (!handlers.ownerIsActive() || handlers.closing) {
            sendJson(response, 409, { error: "The Pi session that started this voice server is no longer active" });
            return;
        }
        const clientId = requiredClientId(body);
        if (path === "/api/stop") {
            handlers.clients.release(clientId, undefined, body["terminateConversation"] === true);
            sendJson(response, 200, { ok: true });
            return;
        }
        if (path === "/api/draft") {
            const revision = handlers.draft.update(clientId, body["text"], body["revision"]);
            sendJson(response, 200, { ok: true, revision });
            return;
        }
        if (path === "/api/send") {
            handlers.draft.send(clientId, body["text"], body["revision"]);
            sendJson(response, 200, { ok: true });
            return;
        }
        sendJson(response, 404, { error: "Not found" });
    }
    catch (error) {
        const status = error instanceof LanVoiceRequestError ? error.status : error instanceof LanVoiceDraftError ? 400 : 500;
        if (!response.headersSent)
            sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
        else
            response.end();
    }
}
export function boundedString(value, maxBytes) {
    return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes ? value : undefined;
}
class LanVoiceRequestError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
async function readJson(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_REQUEST_BYTES)
            throw new LanVoiceRequestError(413, "LAN voice request is too large");
        chunks.push(buffer);
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error();
        return value;
    }
    catch {
        throw new LanVoiceRequestError(400, "LAN voice request must be a JSON object");
    }
}
function requiredClientId(body) {
    const clientId = boundedString(body["clientId"], 128);
    if (!clientId)
        throw new LanVoiceRequestError(400, "A browser client ID is required");
    return clientId;
}
function sendText(response, contentType, body, html = false) {
    response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": contentType,
        "x-content-type-options": "nosniff",
        ...(html ? {
            "content-security-policy": "default-src 'self'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; connect-src 'self' wss:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            "permissions-policy": "microphone=(self), camera=()",
        } : {}),
    });
    response.end(body);
}
function sendJson(response, status, value) {
    response.writeHead(status, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify(value));
}
function sendBinary(response, contentType, body) {
    response.writeHead(200, {
        "cache-control": "public, max-age=86400",
        "content-length": body.byteLength,
        "content-type": contentType,
        "x-content-type-options": "nosniff",
    });
    response.end(body);
}
