import { withPlainCommandOutput } from "./command-output.js";
import { CodeModeHostCellOperations } from "./host-cell-operations.js";
import { CodeModeHostDelegation } from "./host-delegation.js";
import { abortError, cancelOperation, throwIfAborted, toError, } from "./host-operation.js";
import { DEFAULT_CODE_MODE_EXEC_YIELD_MS, executionCellId, parseExecSource, parseRuntimeResponse, toWireToolDefinition, } from "./host-protocol.js";
import { CodeModeHostSession } from "./host-session.js";
import { directToolYieldTime, scopeAllToolsToDeferredCustom, } from "./tool-source.js";
export { scopeAllToolsToDeferredCustom } from "./tool-source.js";
export class CodeModeHostClient {
    tools;
    session;
    delegation;
    cells;
    constructor(options) {
        this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
        let session;
        this.delegation = new CodeModeHostDelegation((message) => session.send(message), options.renderStore);
        session = new CodeModeHostSession({
            binary: options.binary,
            shutdownGraceMs: options.shutdownGraceMs,
            onMessage: (message) => this.delegation.handleMessage(message),
            onFailure: () => this.delegation.clear(),
        });
        this.session = session;
        this.cells = new CodeModeHostCellOperations(session, this.delegation);
    }
    async start() {
        return this.session.start();
    }
    async execute(source, context, signal, tools = [...this.tools.values()]) {
        throwIfAborted(signal);
        await this.start();
        throwIfAborted(signal);
        const { code, yieldTimeMs, maxOutputTokens } = parseExecSource(source);
        const effectiveYieldTimeMs = directToolYieldTime(code, tools) ??
            yieldTimeMs ??
            DEFAULT_CODE_MODE_EXEC_YIELD_MS;
        const id = this.session.nextRequestId();
        const initial = this.session.expectInitial(id);
        void initial.catch(() => undefined);
        const toolSet = new Map(tools.map((tool) => [tool.name, tool]));
        const started = this.session.requestWithId(id, {
            method: "session/execute",
            sessionId: this.session.id,
            request: {
                tool_call_id: `exec-${id}`,
                enabled_tools: tools.map(toWireToolDefinition),
                source: scopeAllToolsToDeferredCustom(withPlainCommandOutput(code, tools), tools),
                yield_time_ms: effectiveYieldTimeMs,
                max_output_tokens: maxOutputTokens,
            },
        }, (value) => this.delegation.bindResponse(value, context, toolSet));
        let cellId;
        const abort = () => {
            cancelOperation(this.session, id);
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
            const response = this.delegation.attach(parseRuntimeResponse(await initial));
            return {
                ...(await this.waitForBlockers(response, context, effectiveYieldTimeMs, signal)),
                maxOutputTokens: maxOutputTokens ?? 10_000,
            };
        }
        catch (error) {
            this.session.rejectOperation(id, toError(error));
            throw error;
        }
        finally {
            signal?.removeEventListener("abort", abort);
        }
    }
    async waitForBlockers(response, context, yieldTimeMs, signal) {
        let current = response;
        while (current.kind === "yielded" && this.delegation.isBlocked(current.cellId)) {
            await this.delegation.waitUntilUnblocked(current.cellId, signal);
            current = await this.cells.wait(current.cellId, yieldTimeMs, context, signal);
        }
        return current;
    }
    async wait(cellId, yieldTimeMs, context, signal) {
        return this.waitForBlockers(await this.cells.wait(cellId, yieldTimeMs, context, signal), context, yieldTimeMs, signal);
    }
    async terminate(cellId, context, signal) {
        return this.cells.terminate(cellId, context, signal);
    }
    async shutdown() {
        return this.session.shutdown();
    }
}
