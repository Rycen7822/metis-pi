const MAX_NESTED_RENDER_STATES = 512;
const MAX_NESTED_RENDER_BYTES = 32 * 1024 * 1024;
const MAX_ESTIMATE_NODES = 4_096;
export class CodeModeNestedRenderStore {
    states = new Map();
    weights = new Map();
    retainedBytes = 0;
    maxBytes;
    constructor(maxBytes = MAX_NESTED_RENDER_BYTES) {
        this.maxBytes = Math.max(0, maxBytes);
    }
    get(traceId) {
        const existing = this.states.get(traceId);
        if (existing) {
            this.states.delete(traceId);
            this.states.set(traceId, existing);
            return existing;
        }
        const created = { state: {} };
        this.states.set(traceId, created);
        this.weights.set(traceId, 0);
        this.trim();
        return created;
    }
    captureInput(traceId, input) {
        const state = this.get(traceId);
        state.input = input;
        this.rebalance(traceId);
    }
    captureResult(traceId, result) {
        const state = this.get(traceId);
        state.result = result;
        this.rebalance(traceId);
    }
    rebalance(traceId) {
        const state = this.states.get(traceId);
        if (!state)
            return;
        const previous = this.weights.get(traceId) ?? 0;
        const next = retainedPayloadBytes(state, this.maxBytes + 1);
        this.weights.set(traceId, next);
        this.retainedBytes += next - previous;
        this.trim();
    }
    clear() {
        this.states.clear();
        this.weights.clear();
        this.retainedBytes = 0;
    }
    delete(traceId) {
        if (!this.states.delete(traceId))
            return;
        this.retainedBytes -= this.weights.get(traceId) ?? 0;
        this.weights.delete(traceId);
    }
    trim() {
        while (this.states.size > MAX_NESTED_RENDER_STATES ||
            this.retainedBytes > this.maxBytes) {
            const oldest = this.states.keys().next().value;
            if (oldest === undefined)
                return;
            this.delete(oldest);
        }
    }
}
function retainedPayloadBytes(state, limit) {
    const budget = {
        remaining: limit,
        nodes: MAX_ESTIMATE_NODES,
        seen: new WeakSet(),
    };
    let bytes = retainedValueBytes(state.input, budget);
    bytes += retainedValueBytes(state.result, budget);
    bytes += retainedValueBytes(state.state, budget);
    return Math.min(limit, bytes);
}
function retainedValueBytes(value, budget) {
    if (budget.remaining <= 0)
        return 0;
    if (budget.nodes <= 0) {
        const bytes = budget.remaining;
        budget.remaining = 0;
        return bytes;
    }
    if (value === null || value === undefined)
        return 0;
    if (typeof value === "string") {
        const bytes = Math.min(budget.remaining, Buffer.byteLength(value));
        budget.remaining -= bytes;
        return bytes;
    }
    if (typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "bigint") {
        const bytes = Math.min(budget.remaining, 8);
        budget.remaining -= bytes;
        return bytes;
    }
    if (typeof value !== "object")
        return 0;
    if (budget.seen.has(value))
        return 0;
    budget.seen.add(value);
    budget.nodes--;
    let bytes = 0;
    let entries;
    try {
        entries = Object.entries(value);
    }
    catch {
        const uninspectable = budget.remaining;
        budget.remaining = 0;
        return uninspectable;
    }
    for (const [key, item] of entries) {
        bytes += retainedValueBytes(key, budget);
        bytes += retainedValueBytes(item, budget);
        if (budget.remaining <= 0 || budget.nodes <= 0)
            break;
    }
    return bytes;
}
