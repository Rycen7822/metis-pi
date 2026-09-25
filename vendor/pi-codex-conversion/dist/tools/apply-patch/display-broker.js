import { APPLY_PATCH_DISPLAY_AVAILABLE_CHANNEL, APPLY_PATCH_DISPLAY_PROTOCOL, APPLY_PATCH_DISPLAY_REQUEST_CHANNEL, isApplyPatchDisplayRequest, } from "./display-protocol.js";
import { isApplyPatchToolDetails, } from "./render-state.js";
const MAX_DISPLAY_IDS = 256;
// The appearance entry must see the tool entry's controller even when Pi's
// per-extension Jiti contexts cannot share a native ESM module instance.
const displayKey = Symbol.for(`metis-pi.apply-patch-display:${import.meta.url}`);
const sharedDisplay = globalThis;
const display = sharedDisplay[displayKey] ??= { active: undefined };
export function shouldCompactApplyPatchDisplay(toolCallId, executionStarted) {
    return display.active?.shouldCompact(toolCallId, executionStarted) ?? false;
}
export function recordApplyPatchDisplayInput(toolCallId, input) {
    display.active?.recordInput(toolCallId, input);
}
export function recordApplyPatchDisplayOutcome(toolCallId, outcome) {
    display.active?.recordOutcome(toolCallId, outcome);
}
export function registerApplyPatchDisplayBroker(pi) {
    const registrations = new Map();
    const captured = new Map();
    const pending = new Map();
    const emitted = new Set();
    const activeCalls = new Set();
    const displayedCalls = new Set();
    let active = true;
    const broker = {
        protocol: APPLY_PATCH_DISPLAY_PROTOCOL,
        isActive: () => active,
        register(customType) {
            if (!active)
                return () => { };
            registrations.set(customType, (registrations.get(customType) ?? 0) + 1);
            return () => {
                const count = registrations.get(customType) ?? 0;
                if (count <= 1)
                    registrations.delete(customType);
                else
                    registrations.set(customType, count - 1);
            };
        },
    };
    const controller = {
        shouldCompact(toolCallId, executionStarted) {
            if (!active || !toolCallId)
                return false;
            if (displayedCalls.has(toolCallId))
                return true;
            if (registrations.size === 0)
                return false;
            if (executionStarted === false)
                return false;
            return activeCalls.has(toolCallId);
        },
        recordInput(toolCallId, input) {
            if (!active || registrations.size === 0)
                return;
            activeCalls.add(toolCallId);
            captured.set(toolCallId, { ...captured.get(toolCallId), input });
            boundMap(captured);
        },
        recordOutcome(toolCallId, outcome) {
            if (!active || registrations.size === 0)
                return;
            activeCalls.add(toolCallId);
            const call = captured.get(toolCallId);
            if (!call)
                return;
            captured.set(toolCallId, { ...call, ...outcome });
        },
    };
    display.active = controller;
    const announce = () => {
        if (active)
            pi.events.emit(APPLY_PATCH_DISPLAY_AVAILABLE_CHANNEL, broker);
    };
    pi.events.on(APPLY_PATCH_DISPLAY_REQUEST_CHANNEL, (value) => {
        if (isApplyPatchDisplayRequest(value))
            announce();
    });
    pi.on("tool_execution_start", (event) => {
        if (event.toolName === "apply_patch" && active && registrations.size > 0)
            activeCalls.add(event.toolCallId);
    });
    pi.on("tool_result", (event) => {
        if (!active || registrations.size === 0)
            return undefined;
        for (const data of collectApplyPatchDisplayData(event, captured)) {
            if (!emitted.has(data.toolCallId))
                pending.set(data.toolCallId, data);
        }
        return undefined;
    });
    pi.on("turn_end", () => {
        for (const [toolCallId, data] of pending) {
            let appended = false;
            for (const customType of registrations.keys()) {
                pi.appendEntry(customType, data);
                appended = true;
            }
            if (appended) {
                emitted.add(toolCallId);
                boundSet(emitted);
                displayedCalls.add(toolCallId);
            }
            captured.delete(toolCallId);
        }
        pending.clear();
        activeCalls.clear();
    });
    pi.on("session_start", (_event, ctx) => {
        for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type !== "custom" ||
                !registrations.has(entry.customType) ||
                !entry.data ||
                typeof entry.data !== "object" ||
                typeof entry.data.toolCallId !== "string")
                continue;
            displayedCalls.add(entry.data.toolCallId);
        }
    });
    pi.on("session_before_switch", () => {
        captured.clear();
        pending.clear();
        emitted.clear();
        activeCalls.clear();
        displayedCalls.clear();
    });
    pi.on("session_shutdown", () => {
        active = false;
        registrations.clear();
        captured.clear();
        pending.clear();
        emitted.clear();
        activeCalls.clear();
        displayedCalls.clear();
        if (display.active === controller)
            display.active = undefined;
    });
    announce();
}
function collectApplyPatchDisplayData(event, captured) {
    if (event.toolName === "apply_patch") {
        const input = patchInput(event.input);
        if (input === undefined)
            return [];
        const text = textContent(event.content);
        const isError = event.isError || isPartialFailure(event.details);
        return [
            {
                toolCallId: event.toolCallId,
                input,
                ...(isApplyPatchToolDetails(event.details)
                    ? { details: event.details }
                    : {}),
                ...text,
                ...(isError && text.content ? { error: text.content } : {}),
                isError,
                source: "direct",
            },
        ];
    }
    if (event.toolName !== "exec" && event.toolName !== "wait")
        return [];
    return nestedTraces(event.details).flatMap((trace) => {
        if (trace.name !== "apply_patch" ||
            trace.status === "running" ||
            typeof trace.id !== "string")
            return [];
        const call = captured.get(trace.id);
        const input = call?.input ?? patchInput(trace.input);
        if (input === undefined)
            return [];
        const result = trace.result;
        const traceDetails = result && typeof result === "object" && "details" in result
            ? result.details
            : undefined;
        const traceContent = result && typeof result === "object" && "content" in result
            ? textContent(result.content).content
            : undefined;
        const details = isApplyPatchToolDetails(traceDetails)
            ? traceDetails
            : call?.details;
        const content = traceContent ?? call?.content;
        const error = call?.error ??
            (typeof trace.error === "string" ? trace.error : undefined);
        return [
            {
                toolCallId: trace.id,
                input,
                ...(details ? { details } : {}),
                ...(content ? { content } : {}),
                ...(error ? { error } : {}),
                isError: trace.status === "error" ||
                    call?.isError === true ||
                    isPartialFailure(details),
                source: "nested",
            },
        ];
    });
}
function isPartialFailure(value) {
    return isApplyPatchToolDetails(value) && value.status === "partial_failure";
}
function nestedTraces(details) {
    if (!details || typeof details !== "object" || !("traces" in details))
        return [];
    const traces = details.traces;
    return Array.isArray(traces)
        ? traces.filter((trace) => Boolean(trace && typeof trace === "object"))
        : [];
}
function patchInput(input) {
    if (typeof input === "string")
        return input;
    if (!input || typeof input !== "object")
        return undefined;
    for (const key of ["input", "patchText", "patch"]) {
        const value = input[key];
        if (typeof value === "string")
            return value;
    }
    return undefined;
}
function textContent(content) {
    if (!Array.isArray(content))
        return {};
    const text = content
        .filter((item) => Boolean(item &&
        typeof item === "object" &&
        item.type === "text" &&
        typeof item.text === "string"))
        .map((item) => item.text)
        .join("\n");
    return text ? { content: text } : {};
}
function boundMap(map) {
    if (map.size <= MAX_DISPLAY_IDS)
        return;
    const oldest = map.keys().next().value;
    if (typeof oldest === "string")
        map.delete(oldest);
}
function boundSet(set) {
    if (set.size <= MAX_DISPLAY_IDS)
        return;
    const oldest = set.values().next().value;
    if (typeof oldest === "string")
        set.delete(oldest);
}
