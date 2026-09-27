import { normalizePath } from "./protected.js";
import { occKey, resultTimestampOf } from "./occurrence-key.js";
export function createSupersedeState() {
    return { floor: undefined, activated: new Set() };
}
export function lowerFloor(state, t) {
    if (t === undefined)
        return;
    state.floor = state.floor === undefined ? t : Math.min(state.floor, t);
}
export function earliestResultTimestamp(toolCalls) {
    let min;
    for (const tc of toolCalls) {
        if (tc.resultTimestamp !== undefined && (min === undefined || tc.resultTimestamp < min))
            min = tc.resultTimestamp;
    }
    return min;
}
export function earliestChainStart(entries) {
    let min;
    for (const e of entries)
        if (min === undefined || e.startUserTimestamp < min)
            min = e.startUserTimestamp;
    return min;
}
export function supersededStub(path) {
    return `[Superseded: ${path} was read again later in this conversation - see the newer read. Re-read the file if this earlier content is needed.]`;
}
export function findSuperseded(messages, isProtected) {
    // Provider ids repeat across turns and an aborted call has no result, so pairing
    // uses the same per-turn open-set model as orphan-sweep, not a global per-id cursor.
    let open = new Map();
    const byPath = new Map();
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m?.role === "assistant" && Array.isArray(m.content)) {
            open = new Map();
            for (const block of m.content)
                if (block?.type === "toolCall")
                    open.set(block.id, block);
            continue;
        }
        if (m?.role === "toolResult") {
            const block = open.get(m.toolCallId);
            if (!block)
                continue;
            open.delete(m.toolCallId);
            const args = block.input ?? block.args ?? block.arguments ?? {};
            if (!isProtected(block.name, args))
                continue;
            const rawPath = args?.path;
            if (typeof rawPath !== "string")
                continue;
            const path = normalizePath(rawPath);
            const cand = {
                toolCallId: block.id,
                path,
                timestamp: resultTimestampOf(m.timestamp),
                resultIndex: i,
            };
            const list = byPath.get(path);
            if (list)
                list.push(cand);
            else
                byPath.set(path, [cand]);
            continue;
        }
        open = new Map();
    }
    const out = [];
    for (const list of byPath.values())
        for (let i = 0; i < list.length - 1; i++)
            out.push(list[i]);
    out.sort((a, b) => a.resultIndex - b.resultIndex);
    return out;
}
const keyOf = (c) => occKey(c.toolCallId, c.timestamp);
/**
 * Phase 1b of pruneMessages. Reference-preserving when nothing is stubbed.
 * Consumes `state.floor` exactly once per call.
 */
export function applySupersede(messages, state, isProtected) {
    const candidates = findSuperseded(messages, isProtected);
    if (state.floor !== undefined) {
        const floor = state.floor;
        for (const c of candidates) {
            if (floor === 0 || (c.timestamp !== undefined && c.timestamp >= floor))
                state.activated.add(keyOf(c));
        }
        state.floor = undefined;
    }
    let out = messages;
    for (const c of candidates) {
        if (!state.activated.has(keyOf(c)))
            continue;
        if (out === messages)
            out = messages.slice();
        const orig = messages[c.resultIndex];
        out[c.resultIndex] = { ...orig, content: [{ type: "text", text: supersededStub(c.path) }], isError: false };
    }
    return out;
}
