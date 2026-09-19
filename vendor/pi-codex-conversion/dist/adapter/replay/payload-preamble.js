import { areEquivalentValues, cloneResponsesInputMessageItem, isPreambleRole, isResponsesInputMessageItem } from "./payload-structured.js";
function isPromptEnvelopeItem(item, persisted) {
    return isResponsesInputMessageItem(item) && isPreambleRole(item.role) &&
        !persisted.some((known) => areEquivalentValues(item, known));
}
export function extractFreshAuthoritativePreamble(payload, persisted = []) {
    if (payload.instructions !== undefined && typeof payload.instructions !== "string")
        return undefined;
    let leadingBoundary = 0;
    while (leadingBoundary < payload.input.length && isPromptEnvelopeItem(payload.input[leadingBoundary], persisted))
        leadingBoundary += 1;
    let trailingBoundary = payload.input.length;
    while (trailingBoundary > leadingBoundary && isPromptEnvelopeItem(payload.input[trailingBoundary - 1], persisted))
        trailingBoundary -= 1;
    for (let index = leadingBoundary; index < trailingBoundary; index++) {
        if (isPromptEnvelopeItem(payload.input[index], persisted))
            return undefined;
    }
    return {
        ...(typeof payload.instructions === "string" ? { instructions: payload.instructions } : {}),
        leadingInput: payload.input.slice(0, leadingBoundary).map((item) => cloneResponsesInputMessageItem(item)),
        trailingInput: payload.input.slice(trailingBoundary).map((item) => cloneResponsesInputMessageItem(item)),
    };
}
