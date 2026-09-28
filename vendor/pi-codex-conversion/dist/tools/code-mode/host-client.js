import { randomUUID } from "node:crypto";
import { withPlainCommandOutput } from "./command-output.js";
import { CodeModeDelegateRuntime } from "./delegate-runtime.js";
import { CodeModeHostConnection } from "./host-connection.js";
import { abortError, cancelOperation, throwIfAborted, toError, } from "./host-operation.js";
import { DEFAULT_CODE_MODE_EXEC_YIELD_MS, executionCellId, isMissingRuntimeOutcome, parseExecSource, parseRuntimeResponse, runtimeOutcome, toWireToolDefinition, } from "./host-protocol.js";
import { directToolYieldTime, scopeAllToolsToDeferredCustom, } from "./tool-source.js";
export { scopeAllToolsToDeferredCustom } from "./tool-source.js";
const DEFAULT_SHUTDOWN_GRACE_MS = 250;
/**
 * V8 host client: owns the framed process connection and the session protocol
 * (session/open, session/execute, session/wait, session/terminate, session/shutdown)
 * plus the delegate/cell replies arriving from the host.
 */
export class CodeModeHostClient {
    id = randomUUID();
    tools;
    connection;
    delegate;
    shutdownGraceMs;
    ready;
    constructor(options) {
        this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
        this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
        this.delegate = new CodeModeDelegateRuntime((message) => this.connection.send(message), options.renderStore);
        this.connection = new CodeModeHostConnection({
            binary: options.binary,
            onMessage: (message) => this.handleMessage(message),
            onFailure: () => {
                this.ready = undefined;
                this.delegate.clear();
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
    async execute(source, context, signal, tools = [...this.tools.values()]) {
        throwIfAborted(signal);
        await this.start();
        throwIfAborted(signal);
        const { code, yieldTimeMs, maxOutputTokens } = parseExecSource(source);
        const effectiveYieldTimeMs = directToolYieldTime(code, tools) ??
            yieldTimeMs ??
            DEFAULT_CODE_MODE_EXEC_YIELD_MS;
        const id = this.connection.nextRequestId();
        const initial = this.connection.expectInitial(id);
        void initial.catch(() => undefined);
        const toolSet = new Map(tools.map((tool) => [tool.name, tool]));
        const started = this.connection.requestWithId(id, {
            method: "session/execute",
            sessionId: this.id,
            request: {
                tool_call_id: `exec-${id}`,
                enabled_tools: tools.map(toWireToolDefinition),
                source: scopeAllToolsToDeferredCustom(withPlainCommandOutput(code, tools), tools),
                yield_time_ms: effectiveYieldTimeMs,
                max_output_tokens: maxOutputTokens,
            },
        }, (value) => this.bindCell(value, context, toolSet));
        let cellId;
        const abort = () => {
            cancelOperation(this.connection, id);
            if (cellId)
                void this.terminate(cellId, context).catch(() => undefined);
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const startedValue = await started;
            cellId = executionCellId(startedValue);
            if (signal?.aborted) {
                abort();
                throw abortError();
            }
            const response = this.delegate.attach(parseRuntimeResponse(await initial));
            return {
                ...(await this.waitForBlockers(response, context, effectiveYieldTimeMs, signal)),
                maxOutputTokens: maxOutputTokens ?? 10_000,
            };
        }
        catch (error) {
            this.connection.rejectOperation(id, toError(error));
            throw error;
        }
        finally {
            signal?.removeEventListener("abort", abort);
        }
    }
    async wait(cellId, yieldTimeMs, context, signal) {
        return this.waitForBlockers(await this.cellOperation(cellId, context, signal, {
            method: "session/wait",
            sessionId: this.id,
            request: { cell_id: cellId, yield_time_ms: yieldTimeMs },
        }, "Code-mode host returned an invalid wait outcome"), context, yieldTimeMs, signal);
    }
    async terminate(cellId, context, signal) {
        return this.cellOperation(cellId, context, signal, {
            method: "session/terminate",
            sessionId: this.id,
            cellId,
        }, "Code-mode host returned an invalid termination outcome");
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
    async startSession() {
        await this.connection.start();
        await this.connection.request({
            method: "session/open",
            sessionId: this.id,
        });
    }
    async waitForBlockers(response, context, yieldTimeMs, signal) {
        let current = response;
        while (current.kind === "yielded" && this.delegate.isBlocked(current.cellId)) {
            await this.delegate.waitUntilUnblocked(current.cellId, signal);
            current = await this.cellOperation(current.cellId, context, signal, {
                method: "session/wait",
                sessionId: this.id,
                request: { cell_id: current.cellId, yield_time_ms: yieldTimeMs },
            }, "Code-mode host returned an invalid wait outcome");
        }
        return current;
    }
    /** Run one session/wait or session/terminate request against the host cell. */
    async cellOperation(cellId, context, signal, request, invalidOutcomeMessage) {
        throwIfAborted(signal);
        await this.start();
        throwIfAborted(signal);
        this.delegate.updateCellContext(cellId, context);
        const id = this.connection.nextRequestId();
        const abort = () => { cancelOperation(this.connection, id); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const value = await this.connection.requestWithId(id, request, (response) => this.bindCell(response, context));
            const wrapped = runtimeOutcome(value);
            if (!wrapped)
                throw new Error(invalidOutcomeMessage);
            return {
                ...this.delegate.attach(parseRuntimeResponse(wrapped)),
                ...(isMissingRuntimeOutcome(value) ? { missingCell: true } : {}),
            };
        }
        finally {
            signal?.removeEventListener("abort", abort);
        }
    }
    /** Bind a host-reported cell to its execution context before replies arrive. */
    bindCell(value, context, tools) {
        const cellId = executionCellId(value);
        if (cellId && context)
            this.delegate.bindCell(cellId, context, tools);
    }
    handleMessage(message) {
        if (message.type === "delegate/request") {
            this.delegate.handleRequest(message);
            return;
        }
        if (message.type === "delegate/cancel") {
            this.delegate.cancel(message.id);
            return;
        }
        if (message.type === "cell/closed")
            this.delegate.closeCell(message.cellId);
    }
}
function shutdownDeadline(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
