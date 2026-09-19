import { randomUUID } from "node:crypto";
import { CodeModeHostConnection } from "./host-connection.js";
const DEFAULT_SHUTDOWN_GRACE_MS = 250;
export class CodeModeHostSession {
    id = randomUUID();
    connection;
    shutdownGraceMs;
    onFailure;
    ready;
    constructor(options) {
        this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
        this.onFailure = options.onFailure;
        this.connection = new CodeModeHostConnection({
            binary: options.binary,
            onMessage: options.onMessage,
            onFailure: (error) => {
                this.ready = undefined;
                this.onFailure(error);
            },
        });
    }
    async start() {
        if (this.ready)
            return this.ready;
        const ready = this.startSession();
        this.ready = ready;
        try {
            await ready;
        }
        catch (error) {
            this.connection.close(toError(error));
            throw error;
        }
    }
    async startSession() {
        await this.connection.start();
        await this.connection.request({
            method: "session/open",
            sessionId: this.id,
        });
    }
    nextRequestId() {
        return this.connection.nextRequestId();
    }
    expectInitial(id) {
        return this.connection.expectInitial(id);
    }
    requestWithId(id, request, onValue) {
        return this.connection.requestWithId(id, request, onValue);
    }
    send(message) {
        this.connection.send(message);
    }
    rejectOperation(id, error) {
        this.connection.rejectOperation(id, error);
    }
    async shutdown() {
        if (!this.connection.running)
            return;
        try {
            await Promise.race([
                this.connection.request({
                    method: "session/shutdown",
                    sessionId: this.id,
                }),
                shutdownDeadline(this.shutdownGraceMs),
            ]);
        }
        catch {
            // Process teardown below is authoritative.
        }
        this.connection.close(new Error("Code-mode host shut down"));
    }
}
function shutdownDeadline(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
