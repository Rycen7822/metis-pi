import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
const DELIMITER = Buffer.from("<IDS|MSG>");
const PROTOCOL_VERSION = "5.3";
export function createJupyterMessage(type, content, session) {
    return {
        header: {
            msg_id: randomUUID(),
            session,
            username: "pi-codex-conversion",
            date: new Date().toISOString(),
            msg_type: type,
            version: PROTOCOL_VERSION,
        },
        parent_header: {},
        metadata: {},
        content,
    };
}
export function encodeJupyterMessage(message, key) {
    const parts = [
        Buffer.from(JSON.stringify(message.header)),
        Buffer.from(JSON.stringify(message.parent_header)),
        Buffer.from(JSON.stringify(message.metadata)),
        Buffer.from(JSON.stringify(message.content)),
    ];
    return [DELIMITER, signature(parts, key), ...parts];
}
export function decodeJupyterMessage(frames, key) {
    const delimiterIndex = frames.findIndex((frame) => frame.equals(DELIMITER));
    if (delimiterIndex < 0 || delimiterIndex + 5 >= frames.length)
        return undefined;
    const supplied = frames[delimiterIndex + 1];
    const parts = frames.slice(delimiterIndex + 2, delimiterIndex + 6);
    const expected = signature(parts, key);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return undefined;
    try {
        return {
            header: JSON.parse(parts[0].toString()),
            parent_header: JSON.parse(parts[1].toString()),
            metadata: JSON.parse(parts[2].toString()),
            content: JSON.parse(parts[3].toString()),
        };
    }
    catch {
        return undefined;
    }
}
function signature(parts, key) {
    const hmac = createHmac("sha256", key);
    for (const part of parts)
        hmac.update(part);
    return Buffer.from(hmac.digest("hex"));
}
