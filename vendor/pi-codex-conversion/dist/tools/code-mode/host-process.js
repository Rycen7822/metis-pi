import { spawn } from "node:child_process";
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_QUEUED_WRITE_BYTES = 128 * 1024 * 1024;
export class CodeModeHostProcess {
    binary;
    onMessage;
    onFailure;
    child;
    buffer = Buffer.alloc(0);
    stderr = "";
    queuedWriteBytes = 0;
    constructor(options) {
        this.binary = options.binary;
        this.onMessage = options.onMessage;
        this.onFailure = options.onFailure;
    }
    get running() {
        return this.child !== undefined;
    }
    start() {
        const child = spawn(this.binary, [], {
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
        });
        this.child = child;
        this.buffer = Buffer.alloc(0);
        this.stderr = "";
        child.stdout.on("data", (chunk) => {
            if (this.child === child)
                this.onData(chunk);
        });
        child.stderr.on("data", (chunk) => {
            if (this.child === child)
                this.stderr = (this.stderr + chunk.toString()).slice(-16_384);
        });
        child.on("error", (error) => {
            if (this.child === child)
                this.onFailure(error);
        });
        child.on("close", (code) => {
            if (this.child === child)
                this.onFailure(new Error(`Code-mode host exited with code ${code ?? "unknown"}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
        });
    }
    send(message) {
        const child = this.child;
        if (!child?.stdin.writable)
            throw new Error("Code-mode host is not running");
        const payload = Buffer.from(JSON.stringify(message));
        if (payload.length > MAX_FRAME_BYTES)
            throw new Error(`Code-mode frame exceeds ${MAX_FRAME_BYTES} bytes`);
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32LE(payload.length);
        const frame = Buffer.concat([header, payload]);
        if (this.queuedWriteBytes + frame.length > MAX_QUEUED_WRITE_BYTES)
            throw new Error(`Code-mode write queue exceeds ${MAX_QUEUED_WRITE_BYTES} bytes`);
        this.queuedWriteBytes += frame.length;
        child.stdin.write(frame, (error) => {
            this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - frame.length);
            if (error && this.child === child)
                this.onFailure(error);
        });
    }
    kill() {
        this.queuedWriteBytes = 0;
        const child = this.child;
        this.child = undefined;
        if (child && !child.killed)
            child.kill();
    }
    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (length > MAX_FRAME_BYTES) {
                this.onFailure(new Error(`Code-mode frame exceeds ${MAX_FRAME_BYTES} bytes`));
                return;
            }
            if (this.buffer.length < length + 4)
                return;
            const payload = this.buffer.subarray(4, length + 4);
            this.buffer = this.buffer.subarray(length + 4);
            try {
                this.onMessage(JSON.parse(payload.toString("utf8")));
            }
            catch (error) {
                this.onFailure(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
}
