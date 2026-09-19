import { CodeModeDelegateRuntime } from "./delegate-runtime.js";
import { executionCellId } from "./host-protocol.js";
export class CodeModeHostDelegation {
    runtime;
    constructor(send, renderStore) {
        this.runtime = new CodeModeDelegateRuntime(send, renderStore);
    }
    bindResponse(value, context, tools) {
        const cellId = executionCellId(value);
        if (cellId && context)
            this.runtime.bindCell(cellId, context, tools);
    }
    updateCellContext(cellId, context) {
        this.runtime.updateCellContext(cellId, context);
    }
    isBlocked(cellId) {
        return this.runtime.isBlocked(cellId);
    }
    waitUntilUnblocked(cellId, signal) {
        return this.runtime.waitUntilUnblocked(cellId, signal);
    }
    attach(response) {
        return this.runtime.attach(response);
    }
    clear() {
        this.runtime.clear();
    }
    handleMessage(message) {
        if (message.type === "delegate/request") {
            this.runtime.handleRequest(message);
            return;
        }
        if (message.type === "delegate/cancel") {
            this.runtime.cancel(message.id);
            return;
        }
        if (message.type === "cell/closed")
            this.runtime.closeCell(message.cellId);
    }
}
