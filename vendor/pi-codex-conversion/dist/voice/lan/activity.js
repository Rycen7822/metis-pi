const MAX_ACTIVITY_BYTES = 16 * 1024;
export class LanVoiceActivity {
    publish;
    state;
    constructor(options) {
        this.publish = options.publish;
        this.state = { type: "activity", state: options.initialWorking ? "working" : "idle" };
    }
    snapshot() {
        return this.state;
    }
    working() {
        this.state = { type: "activity", state: "working" };
        this.publish(this.state);
    }
    waiting(text) {
        const bounded = text ? truncateUtf8(text.trim(), MAX_ACTIVITY_BYTES) : "";
        this.state = bounded
            ? { type: "activity", state: "waiting", text: bounded }
            : { type: "activity", state: "waiting" };
        this.publish(this.state);
    }
    settled(text) {
        const bounded = text ? truncateUtf8(text.trim(), MAX_ACTIVITY_BYTES) : "";
        this.state = bounded
            ? { type: "activity", state: "settled", text: bounded }
            : { type: "activity", state: "idle" };
        this.publish(this.state);
    }
}
export function boundedAssistantText(parts) {
    const text = parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
    return text ? truncateUtf8(text, MAX_ACTIVITY_BYTES) : undefined;
}
function truncateUtf8(value, maxBytes) {
    const buffer = Buffer.from(value);
    if (buffer.byteLength <= maxBytes)
        return value;
    let end = maxBytes - Buffer.byteLength("…");
    while (end > 0 && (buffer[end] & 0xc0) === 0x80)
        end -= 1;
    return `${buffer.subarray(0, end).toString("utf8").trimEnd()}…`;
}
