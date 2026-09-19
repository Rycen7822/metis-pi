import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readNotebookBridgeRequest, writeNotebookBridgeJson } from "./bridge-protocol.js";
const BRIDGE_SHUTDOWN_GRACE_MS = 1_500;
export class NotebookBridgeServer {
    token = randomBytes(32).toString("hex");
    exitToken = randomBytes(32).toString("hex");
    handlers;
    server;
    origin;
    constructor(handlers) {
        this.handlers = handlers;
    }
    async start() {
        if (this.origin)
            return this.origin;
        const server = createServer((request, response) => {
            void this.handle(request, response);
        });
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Notebook bridge did not bind a TCP port");
        this.origin = `http://127.0.0.1:${address.port}`;
        return this.origin;
    }
    async shutdown() {
        const server = this.server;
        this.server = undefined;
        this.origin = undefined;
        if (!server)
            return;
        const closed = new Promise((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        if (await settlesWithin(closed, BRIDGE_SHUTDOWN_GRACE_MS))
            return;
        server.closeAllConnections();
        await settlesWithin(closed, BRIDGE_SHUTDOWN_GRACE_MS);
    }
    async handle(request, response) {
        try {
            if (request.method !== "POST" || request.url !== "/bridge") {
                writeNotebookBridgeJson(response, 404, { ok: false, error: "Not found" });
                return;
            }
            if (request.headers.authorization !== `Bearer ${this.token}`) {
                writeNotebookBridgeJson(response, 401, { ok: false, error: "Unauthorized" });
                return;
            }
            const value = await readNotebookBridgeRequest(request);
            switch (value.kind) {
                case "tool": {
                    const result = await this.handlers.callTool(value.cellId, value.requestId, value.toolName, value.input);
                    writeNotebookBridgeJson(response, 200, { ok: true, result });
                    return;
                }
                case "cancel_tools":
                    this.handlers.cancelTools(value.cellId);
                    break;
                case "emit":
                    this.handlers.emit(value.cellId, value.items);
                    break;
                case "notify":
                    this.handlers.notify(value.cellId, value.text);
                    break;
                case "yield":
                    this.handlers.yield(value.cellId);
                    break;
                case "memory":
                    this.handlers.memory(value.cellId, value.usage);
                    break;
            }
            writeNotebookBridgeJson(response, 200, { ok: true });
        }
        catch (error) {
            writeNotebookBridgeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    }
}
async function settlesWithin(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise.then(() => true),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
