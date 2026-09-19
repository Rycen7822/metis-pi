import { runCustomTool } from "./custom-tool-runner.js";
import { isCustomToolDefinition } from "./host-protocol.js";
import { runCodeModeToolWithHooks } from "./nested-tool-completion.js";
import { codeModeNameForToolIdentity } from "./tool-identity.js";
import { CodeModeNestedRenderStore } from "./trace-render-state.js";
import { CodeModeTraceStore } from "./trace-store.js";
import { toolResultFromValue, truncateTraceText } from "./trace-values.js";
const MAX_TRACE_ERROR_CHARS = 16_384;
const MAX_NOTIFICATION_CHARS = 16_384;
const MAX_NOTIFICATIONS_PER_CELL = 100;
export class CodeModeDelegateRuntime {
    traceRuntimeGeneration = crypto.randomUUID();
    cellContexts = new Map();
    cellTools = new Map();
    controllers = new Map();
    notifications = new Map();
    // Continuation routing must survive bounded display traces.
    execSessions = new Map();
    blockers = new Map();
    blockerChanges = new Map();
    sequentialTails = new Map();
    traces = new CodeModeTraceStore();
    cleanupTimers = new Map();
    send;
    renderStore;
    constructor(send, renderStore = new CodeModeNestedRenderStore()) {
        this.send = send;
        this.renderStore = renderStore;
    }
    bindCell(cellId, context, tools) {
        this.cellContexts.set(cellId, context);
        if (tools)
            this.cellTools.set(cellId, tools);
    }
    updateCellContext(cellId, context) {
        this.cellContexts.set(cellId, context);
    }
    closeCell(cellId) {
        this.cellContexts.delete(cellId);
        this.cellTools.delete(cellId);
        this.blockers.delete(cellId);
        this.blockerChanges.get(cellId)?.resolve();
        this.blockerChanges.delete(cellId);
        this.sequentialTails.delete(cellId);
        const previous = this.cleanupTimers.get(cellId);
        if (previous)
            clearTimeout(previous);
        this.cleanupTimers.set(cellId, setTimeout(() => {
            this.cleanupTimers.delete(cellId);
            this.notifications.delete(cellId);
            this.execSessions.delete(cellId);
            this.traces.delete(cellId);
        }, 1_000));
    }
    clear() {
        for (const { controller } of this.controllers.values())
            controller.abort();
        this.controllers.clear();
        this.cellContexts.clear();
        this.cellTools.clear();
        this.traces.clear();
        this.renderStore.clear();
        this.notifications.clear();
        this.execSessions.clear();
        for (const change of this.blockerChanges.values())
            change.resolve();
        this.blockers.clear();
        this.blockerChanges.clear();
        this.sequentialTails.clear();
        for (const timer of this.cleanupTimers.values())
            clearTimeout(timer);
        this.cleanupTimers.clear();
    }
    isBlocked(cellId) {
        return (this.blockers.get(cellId)?.size ?? 0) > 0;
    }
    async waitUntilUnblocked(cellId, signal) {
        while (this.isBlocked(cellId)) {
            const change = this.blockerChanges.get(cellId) ?? deferred();
            this.blockerChanges.set(cellId, change);
            await waitForChange(change.promise, signal);
        }
    }
    cancel(id) {
        const key = hostControllerKey(id);
        const pending = this.controllers.get(key);
        this.controllers.delete(key);
        pending?.controller.abort();
    }
    cancelCell(cellId) {
        for (const [key, pending] of this.controllers) {
            if (pending.cellId !== cellId)
                continue;
            this.controllers.delete(key);
            pending.controller.abort();
        }
    }
    handleRequest(message) {
        const key = hostControllerKey(message.id);
        if (this.controllers.has(key))
            throw new Error(`Duplicate code-mode delegate request: ${message.id}`);
        const controller = new AbortController();
        const cellId = message.request.type === "notification/send"
            ? message.request.cellId
            : message.request.invocation.cell_id;
        this.controllers.set(key, { cellId, controller });
        void this.invoke(message, key, controller);
    }
    async invokeDirect(cellId, requestId, toolName, input) {
        const key = directControllerKey(cellId, requestId);
        if (this.controllers.has(key))
            throw new Error(`Duplicate code-mode delegate request: ${requestId}`);
        const controller = new AbortController();
        this.controllers.set(key, { cellId, controller });
        try {
            return await this.invokeTool(cellId, toolName, input, String(requestId), controller);
        }
        finally {
            this.controllers.delete(key);
        }
    }
    notifyDirect(cellId, value) {
        const context = this.cellContexts.get(cellId);
        if (!context)
            throw new Error("Code-mode notification cell is unavailable");
        const notifications = this.notifications.get(cellId) ?? [];
        const text = value.slice(0, MAX_NOTIFICATION_CHARS);
        notifications.push(text);
        if (notifications.length > MAX_NOTIFICATIONS_PER_CELL)
            notifications.splice(0, notifications.length - MAX_NOTIFICATIONS_PER_CELL);
        this.notifications.set(cellId, notifications);
        context.onUpdate?.({
            content: [{ type: "text", text }],
            details: { cellId, notification: true },
        });
    }
    attach(response) {
        const cleanupTimer = this.cleanupTimers.get(response.cellId);
        if (cleanupTimer)
            clearTimeout(cleanupTimer);
        this.cleanupTimers.delete(response.cellId);
        const notifications = this.notifications.get(response.cellId) ?? [];
        this.notifications.delete(response.cellId);
        const execSessionIds = [...(this.execSessions.get(response.cellId) ?? [])];
        if (response.kind !== "yielded")
            this.execSessions.delete(response.cellId);
        const withTraces = this.traces.attach(response);
        return {
            ...withTraces,
            ...(execSessionIds.length > 0 ? { execSessionIds } : {}),
            contentItems: [
                ...notifications.map((text) => ({ type: "input_text", text })),
                ...response.contentItems,
            ],
        };
    }
    async invoke(message, key, controller) {
        const request = message.request;
        if (request.type === "notification/send") {
            this.handleNotification(message.id, key, request);
            return;
        }
        const invocation = request.invocation;
        const cellId = invocation.cell_id;
        const toolName = codeModeNameForToolIdentity(invocation.tool_name);
        const input = invocation?.input;
        try {
            const result = await this.invokeTool(cellId, toolName, input, String(invocation?.runtime_tool_call_id ?? message.id), controller);
            this.respond(message.id, {
                status: "ok",
                value: { type: "tool/result", result },
            });
        }
        catch (error) {
            this.respond(message.id, {
                status: "error",
                message: error instanceof Error ? error.message : String(error),
            });
        }
        finally {
            this.controllers.delete(key);
        }
    }
    async invokeTool(cellId, toolName, input, traceId, controller) {
        const tool = this.cellTools.get(cellId)?.get(toolName);
        const context = this.cellContexts.get(cellId);
        if (!tool)
            throw new Error(`Unknown custom tool: ${toolName}`);
        if (!context)
            throw new Error("Code-mode cell context is unavailable");
        const currentContext = () => this.cellContexts.get(cellId) ?? context;
        const emitTrace = () => this.traces.emitUpdate(cellId, currentContext());
        const trace = this.traces.start(cellId, `${this.traceRuntimeGeneration}:${cellId}:${traceId}`, tool.name, input);
        const captureRendererValues = !isCustomToolDefinition(tool) &&
            Boolean(tool.renderCall || tool.renderResult);
        let finalResultCaptured = false;
        let resultSessionId;
        if (captureRendererValues)
            this.renderStore.captureInput(trace.id, input);
        const invocationContext = {
            ...context,
            toolCallId: trace.id,
            onUpdate: (update) => {
                if (captureRendererValues)
                    this.renderStore.captureResult(trace.id, update);
                trace.result = this.traces.captureResult(cellId, trace, update);
                emitTrace();
            },
            captureResult: (result) => {
                finalResultCaptured = true;
                resultSessionId = numericSessionId(result.details);
                if (captureRendererValues)
                    this.renderStore.captureResult(trace.id, result);
                trace.result = this.traces.captureResult(cellId, trace, result);
                emitTrace();
            },
            refreshTrace: emitTrace,
        };
        let blocking = false;
        let blockerActive = false;
        try {
            blocking =
                !isCustomToolDefinition(tool) &&
                    (tool.blocking === true || tool.isBlocking?.(input) === true);
            if (blocking) {
                blockerActive = true;
                trace.status = "blocked";
                this.setBlocked(cellId, trace.id, true);
                emitTrace();
            }
            const result = await runCodeModeToolWithHooks(tool.name, input, invocationContext, controller.signal, async (hookContext) => {
                if (isCustomToolDefinition(tool))
                    emitTrace();
                controller.signal.throwIfAborted();
                const run = async () => {
                    return isCustomToolDefinition(tool)
                        ? await runCustomTool(tool, input, hookContext.cwd, controller.signal)
                        : await tool.invoke(input, hookContext, controller.signal);
                };
                return !isCustomToolDefinition(tool) && tool.executionMode === "sequential"
                    ? await this.invokeSequential(cellId, controller.signal, run)
                    : await run();
            });
            if (!trace.result)
                trace.result = this.traces.captureResult(cellId, trace, toolResultFromValue(result));
            trace.status = "done";
            this.recordExecSession(cellId, tool.name, input, finalResultCaptured ? resultSessionId : numericSessionId(result));
            emitTrace();
            return result;
        }
        catch (error) {
            const errorText = error instanceof Error ? error.message : String(error);
            if (captureRendererValues && !finalResultCaptured) {
                const errorResult = {
                    content: [{ type: "text", text: errorText }],
                    details: {},
                };
                this.renderStore.captureResult(trace.id, errorResult);
                trace.result = this.traces.captureResult(cellId, trace, errorResult);
            }
            trace.status = "error";
            trace.error = truncateTraceText(errorText, MAX_TRACE_ERROR_CHARS);
            emitTrace();
            throw error;
        }
        finally {
            if (blockerActive)
                this.setBlocked(cellId, trace.id, false);
        }
    }
    recordExecSession(cellId, toolName, input, resultSessionId) {
        if (toolName !== "exec_command" && toolName !== "write_stdin")
            return;
        const sessions = this.execSessions.get(cellId) ?? new Set();
        const inputSessionId = numericSessionId(input);
        if (toolName === "write_stdin" && inputSessionId !== undefined)
            sessions.delete(inputSessionId);
        if (resultSessionId !== undefined)
            sessions.add(resultSessionId);
        if (sessions.size > 0)
            this.execSessions.set(cellId, sessions);
        else
            this.execSessions.delete(cellId);
    }
    async invokeSequential(cellId, signal, run) {
        let release;
        const turn = new Promise((resolve) => {
            release = resolve;
        });
        const previous = this.sequentialTails.get(cellId) ?? Promise.resolve();
        this.sequentialTails.set(cellId, previous.then(() => turn));
        try {
            await waitForChange(previous, signal);
            return await run();
        }
        finally {
            release();
        }
    }
    setBlocked(cellId, blockerId, active) {
        const blockers = this.blockers.get(cellId) ?? new Set();
        const changed = active ? !blockers.has(blockerId) : blockers.delete(blockerId);
        if (active)
            blockers.add(blockerId);
        if (!changed)
            return;
        if (blockers.size === 0)
            this.blockers.delete(cellId);
        else
            this.blockers.set(cellId, blockers);
        this.cellContexts.get(cellId)?.setBlocked?.(blockerId, active);
        this.blockerChanges.get(cellId)?.resolve();
        this.blockerChanges.set(cellId, deferred());
    }
    handleNotification(id, key, request) {
        const cellId = request.cellId;
        try {
            this.notifyDirect(cellId, request.text);
        }
        catch (error) {
            this.respond(id, {
                status: "error",
                message: error instanceof Error ? error.message : String(error),
            });
            this.controllers.delete(key);
            return;
        }
        this.respond(id, {
            status: "ok",
            value: { type: "notification/delivered" },
        });
        this.controllers.delete(key);
    }
    respond(id, result) {
        try {
            this.send({ type: "delegate/response", id, result });
        }
        catch (error) {
            try {
                this.send({
                    type: "delegate/response",
                    id,
                    result: {
                        status: "error",
                        message: `Failed to serialize nested tool result: ${error instanceof Error ? error.message : String(error)}`,
                    },
                });
            }
            catch {
                // Host teardown will reject the owning operation.
            }
        }
    }
}
function numericSessionId(value) {
    return value && typeof value === "object" && "session_id" in value && typeof value.session_id === "number"
        ? value.session_id
        : undefined;
}
function hostControllerKey(id) {
    return `host:${id}`;
}
function directControllerKey(cellId, requestId) {
    return `direct:${cellId}:${requestId}`;
}
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}
function waitForChange(change, signal) {
    if (!signal)
        return change;
    if (signal.aborted)
        return Promise.reject(signal.reason ?? new Error("Operation aborted"));
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Operation aborted"));
        signal.addEventListener("abort", abort, { once: true });
        void change.then(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
        });
    });
}
