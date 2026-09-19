import { fetch as undiciFetch, ProxyAgent } from "undici";
import { resolveWebSocketProxyForTarget } from "../../providers/openai-codex/websocket-connection.js";
import { MAX_REALTIME_SDP_BYTES } from "./peer.js";
const V3_MODEL = "gpt-live-1-codex";
export function buildRealtimeCallRequest(sdp, config, instructions, initialItems) {
    return {
        sdp,
        session: {
            model: V3_MODEL,
            instructions,
            audio: { output: { voice: config.voice.v3Voice } },
            delegation: {
                type: "client",
                ack_filler: config.voice.delegationAcknowledgements,
            },
            ...(initialItems?.length ? { initial_items: initialItems } : {}),
        },
    };
}
export const setupRealtimeCall = async (endpoint, headers, signal, body, env) => {
    const proxy = await resolveWebSocketProxyForTarget(endpoint, env);
    const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
    try {
        const response = await undiciFetch(endpoint, {
            method: "POST",
            headers: Object.fromEntries(headers),
            signal,
            body,
            ...(dispatcher ? { dispatcher } : {}),
        });
        return { status: response.status, answer: await readBoundedResponseText(response, MAX_REALTIME_SDP_BYTES) };
    }
    finally {
        await dispatcher?.close();
    }
};
async function readBoundedResponseText(response, maxBytes) {
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
        throw new Error(`Codex voice response exceeded ${maxBytes} bytes`);
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            const chunk = Buffer.from(value);
            bytes += chunk.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel().catch(() => { });
                throw new Error(`Codex voice response exceeded ${maxBytes} bytes`);
            }
            chunks.push(chunk);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
}
