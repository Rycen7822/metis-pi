import { CodeModeHostProcess } from "./host-process.js";
import { parseHostMessage } from "./host-protocol.js";
export class CodeModeHostConnection {
    process;
    onMessage;
    onFailure;
    requestId = 0;
    ready;
    pending = new Map();
    initial = new Map();
    constructor(options) {
        this.onMessage = options.onMessage;
        this.onFailure = options.onFailure;
        this.process = new CodeModeHostProcess({
            binary: options.binary,
            onMessage: (message) => this.handleMessage(parseHostMessage(message)),
            onFailure: (error) => this.failAll(error),
        });
    }
    get running() {
        return this.process.running;
    }
    nextRequestId() {
        return ++this.requestId;
    }
    async start() {
        if (this.ready)
            return this.ready;
        const ready = this.startProcess();
        this.ready = ready;
        try {
            await ready;
        }
        catch (error) {
            this.failAll(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }
    async startProcess() {
        this.process.start();
        const handshake = new Promise((resolve, reject) => {
            this.pending.set(0, { resolve: () => resolve(), reject });
        });
        this.send({
            type: "connection/hello",
            supportedVersions: [1],
            requiredCapabilities: [],
            optionalCapabilities: [],
        });
        await handshake;
    }
    request(request, onValue) {
        return this.requestWithId(this.nextRequestId(), request, onValue);
    }
    requestWithId(id, request, onValue) {
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, onValue });
            try {
                this.send({ type: "operation/request", id, request });
            }
            catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    expectInitial(id) {
        return new Promise((resolve, reject) => {
            this.initial.set(id, { resolve, reject });
        });
    }
    send(message) {
        this.process.send(message);
    }
    rejectOperation(id, error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
        const initial = this.initial.get(id);
        this.initial.delete(id);
        initial?.reject(error);
    }
    close(error) {
        this.failAll(error);
    }
    handleMessage(message) {
        if (message.type === "connection/ready") {
            const pending = this.pending.get(0);
            this.pending.delete(0);
            pending?.resolve(undefined);
            return;
        }
        if (message.type === "connection/rejected") {
            const pending = this.pending.get(0);
            this.pending.delete(0);
            pending?.reject(new Error(`Code-mode handshake rejected: ${JSON.stringify(message.reason)}`));
            return;
        }
        if (message.type === "operation/response") {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (!pending)
                return;
            if (message.result.status === "error") {
                pending.reject(new Error(message.result.message));
                return;
            }
            const value = message.result.value;
            pending.onValue?.(value);
            pending.resolve(value);
            return;
        }
        if (message.type === "execute/initialResponse") {
            const pending = this.initial.get(message.id);
            this.initial.delete(message.id);
            if (!pending)
                return;
            if (message.result.status === "error")
                pending.reject(new Error(message.result.message));
            else
                pending.resolve(message.result.value);
            return;
        }
        this.onMessage(message);
    }
    failAll(error) {
        for (const pending of [...this.pending.values(), ...this.initial.values()])
            pending.reject(error);
        this.pending.clear();
        this.initial.clear();
        this.ready = undefined;
        this.process.kill();
        this.onFailure(error);
    }
}
