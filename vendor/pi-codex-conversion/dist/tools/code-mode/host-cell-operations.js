import { operationAbort, throwIfAborted } from "./host-operation.js";
import { isMissingRuntimeOutcome, parseRuntimeResponse, runtimeOutcome, } from "./host-protocol.js";
export class CodeModeHostCellOperations {
    session;
    delegation;
    constructor(session, delegation) {
        this.session = session;
        this.delegation = delegation;
    }
    async wait(cellId, yieldTimeMs, context, signal) {
        return this.run(cellId, context, signal, {
            method: "session/wait",
            sessionId: this.session.id,
            request: { cell_id: cellId, yield_time_ms: yieldTimeMs },
        }, "Code-mode host returned an invalid wait outcome");
    }
    async terminate(cellId, context, signal) {
        return this.run(cellId, context, signal, {
            method: "session/terminate",
            sessionId: this.session.id,
            cellId,
        }, "Code-mode host returned an invalid termination outcome");
    }
    async run(cellId, context, signal, request, invalidOutcomeMessage) {
        throwIfAborted(signal);
        await this.session.start();
        throwIfAborted(signal);
        this.delegation.updateCellContext(cellId, context);
        const id = this.session.nextRequestId();
        const abort = operationAbort(this.session, id);
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const value = await this.session.requestWithId(id, request, (response) => this.delegation.bindResponse(response, context));
            const wrapped = runtimeOutcome(value);
            if (!wrapped)
                throw new Error(invalidOutcomeMessage);
            return {
                ...this.delegation.attach(parseRuntimeResponse(wrapped)),
                ...(isMissingRuntimeOutcome(value)
                    ? { missingCell: true }
                    : {}),
            };
        }
        finally {
            signal?.removeEventListener("abort", abort);
        }
    }
}
