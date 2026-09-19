export function requestBodyForWebSocketContinuationComparison(body) {
    const { input: _input, previous_response_id: _previousResponseId, 
    // Request metadata may carry per-turn transport fields such as the
    // Responses Lite marker. It does not change conversation continuity.
    client_metadata: _clientMetadata, ...rest } = body;
    return rest;
}
export function responseInputsEqual(a, b) {
    const left = a ?? [];
    const right = b ?? [];
    return left.length === right.length && left.every((item, index) => responsesValuesEqual(item, right[index]));
}
function canonicalResponseValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalResponseValue);
    if (!value || typeof value !== "object")
        return value;
    const record = value;
    const canonical = {};
    for (const key of Object.keys(record).sort()) {
        if (key === "internal_chat_message_metadata_passthrough")
            continue;
        if (key === "logprobs" && record["type"] === "output_text" && Array.isArray(record[key]) && record[key].length === 0)
            continue;
        if (key === "status" && record[key] === "completed" && (record["type"] === "function_call" || record["type"] === "custom_tool_call"))
            continue;
        canonical[key] = canonicalResponseValue(record[key]);
    }
    return canonical;
}
function responsesValuesEqual(a, b) {
    return JSON.stringify(canonicalResponseValue(a)) === JSON.stringify(canonicalResponseValue(b));
}
function requestBodiesMatchExceptInput(a, b) {
    return responsesValuesEqual(requestBodyForWebSocketContinuationComparison(a), requestBodyForWebSocketContinuationComparison(b));
}
function getFunctionCallId(item) {
    return item && typeof item === "object" && (item.type === "function_call" || item.type === "custom_tool_call") && typeof item.call_id === "string"
        ? item.call_id
        : undefined;
}
function getFunctionCallOutputId(item) {
    return item && typeof item === "object" && (item.type === "function_call_output" || item.type === "custom_tool_call_output") && typeof item.call_id === "string"
        ? item.call_id
        : undefined;
}
function getPendingToolOutputDelta(body, continuation) {
    const pendingCallIds = continuation.lastResponseItems.map(getFunctionCallId).filter((id) => id !== undefined);
    if (pendingCallIds.length === 0)
        return undefined;
    const pending = new Set(pendingCallIds);
    const currentInput = body.input ?? [];
    let firstOutputIndex;
    for (const [index, item] of currentInput.entries()) {
        const callId = getFunctionCallOutputId(item);
        if (!callId || !pending.has(callId))
            continue;
        firstOutputIndex ??= index;
        pending.delete(callId);
    }
    return pending.size === 0 && firstOutputIndex !== undefined ? currentInput.slice(firstOutputIndex) : undefined;
}
function getCachedWebSocketInputDelta(body, continuation) {
    if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
        return { decision: "body_mismatch" };
    }
    const currentInput = body.input ?? [];
    const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
    if (currentInput.length < baseline.length) {
        return { decision: "input_shorter_than_baseline" };
    }
    const prefix = currentInput.slice(0, baseline.length);
    if (!responseInputsEqual(prefix, baseline)) {
        const pendingToolOutputDelta = getPendingToolOutputDelta(body, continuation);
        if (pendingToolOutputDelta) {
            return { delta: pendingToolOutputDelta, decision: "delta" };
        }
        return { decision: "input_prefix_mismatch" };
    }
    return { delta: currentInput.slice(baseline.length), decision: "delta" };
}
export function buildCachedWebSocketRequestBody(continuation, body) {
    if (!continuation) {
        return { body, decision: "no_continuation" };
    }
    const { delta, decision } = getCachedWebSocketInputDelta(body, continuation);
    if (!delta) {
        return { body, decision };
    }
    if (!continuation.lastResponseId) {
        return { body, decision: "missing_previous_response_id" };
    }
    return {
        body: {
            ...body,
            previous_response_id: continuation.lastResponseId,
            input: delta,
        },
        decision: "delta",
    };
}
