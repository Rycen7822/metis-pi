import { serializeMessagesToResponsesInput } from "../compaction/serializer.js";
import { areEquivalentValues, cloneResponsesInputSlice, isRecord } from "./payload-structured.js";
import { toPiReplayAgentMessage, toReplayAgentMessage } from "./replay-message-conversion.js";
const GENERATED_PI_MESSAGE_ID = /^msg_pi_\d+(?:_\d+)?$/;
function replayPrefixValuesEquivalent(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
        return false;
    // Segment serialization restarts its message index. Ignore only the resulting
    // generated assistant ID while requiring the rest of the item to match.
    return left.every((leftItem, index) => {
        const rightItem = right[index];
        if (isRecord(leftItem)
            && isRecord(rightItem)
            && leftItem["type"] === "message"
            && rightItem["type"] === "message"
            && leftItem["role"] === "assistant"
            && rightItem["role"] === "assistant"
            && typeof leftItem["id"] === "string"
            && typeof rightItem["id"] === "string"
            && GENERATED_PI_MESSAGE_ID.test(leftItem["id"])
            && GENERATED_PI_MESSAGE_ID.test(rightItem["id"])) {
            return areEquivalentValues({ ...leftItem, id: "msg_pi_generated" }, { ...rightItem, id: "msg_pi_generated" });
        }
        return areEquivalentValues(leftItem, rightItem);
    });
}
export function collectReplayMessages(entries) {
    const messages = [];
    for (const entry of entries) {
        const message = toReplayAgentMessage(entry);
        if (message) {
            messages.push(message);
        }
    }
    return messages;
}
function collectPiReplayMessages(entries) {
    const messages = [];
    for (const entry of entries) {
        const message = toPiReplayAgentMessage(entry);
        if (message)
            messages.push(message);
    }
    return messages;
}
export function createCompactionSummaryAgentMessage(entry) {
    return {
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: new Date(entry.timestamp).getTime(),
    };
}
export function createReplaySlice(entries, messages, input) {
    return {
        entries: [...entries],
        messages: [...messages],
        input: [...input],
    };
}
function createReplayMessageSet(model, messages, options) {
    return {
        messages,
        input: serializeMessagesToResponsesInput(model, messages, options),
    };
}
function createReplayVariants(args) {
    const contextMessages = collectReplayMessages(args.entries);
    const piMessages = collectPiReplayMessages(args.entries);
    const contextSet = createReplayMessageSet(args.model, contextMessages, args.serializationOptions);
    if (areEquivalentValues(contextMessages, piMessages))
        return [contextSet];
    return [contextSet, createReplayMessageSet(args.model, piMessages, args.serializationOptions)];
}
function clonePayloadConversationInput(args) {
    const tailEndIndex = args.payloadInput.length - args.freshPreamble.trailingInput.length;
    if (tailEndIndex < args.freshPreamble.leadingInput.length)
        return undefined;
    return cloneResponsesInputSlice(args.payloadInput.slice(args.freshPreamble.leadingInput.length, tailEndIndex));
}
function stripLeadingCompactionSummaryPlaceholder(args) {
    if (args.compactionSummaryInput.length === 0)
        return [...args.conversationInput];
    if (!areEquivalentValues(args.conversationInput.slice(0, args.compactionSummaryInput.length), args.compactionSummaryInput)) {
        return [...args.conversationInput];
    }
    return [...args.conversationInput.slice(args.compactionSummaryInput.length)];
}
export function buildLenientNativeReplayPayload(args) {
    const conversationInput = clonePayloadConversationInput({ payloadInput: args.payload.input, freshPreamble: args.freshPreamble });
    if (!conversationInput)
        return undefined;
    const replayConversationInput = stripLeadingCompactionSummaryPlaceholder({ conversationInput, compactionSummaryInput: args.compactionSummaryInput });
    return {
        conversationInput: replayConversationInput,
        input: [
            ...args.freshPreamble.leadingInput,
            ...args.compactedWindow,
            ...replayConversationInput,
            ...args.freshPreamble.trailingInput,
        ],
    };
}
export function findReplayMatch(args) {
    const compactionSummaryInput = serializeMessagesToResponsesInput(args.model, [args.compactionSummaryMessage], args.serializationOptions);
    const preCompactionVariants = [
        ...createReplayVariants({ model: args.model, entries: args.preCompactionEntries, serializationOptions: args.serializationOptions }),
        createReplayMessageSet(args.model, [], args.serializationOptions),
    ];
    const postCompactionVariants = createReplayVariants({ model: args.model, entries: args.postCompactionEntries, serializationOptions: args.serializationOptions });
    for (const preCompactionKept of preCompactionVariants) {
        for (const postCompactionTail of postCompactionVariants) {
            const expectedBeforeTrailing = [
                ...args.freshPreamble.leadingInput,
                ...compactionSummaryInput,
                ...preCompactionKept.input,
                ...postCompactionTail.input,
            ];
            const originalPiReplayInput = [...expectedBeforeTrailing, ...args.freshPreamble.trailingInput];
            const tailEndIndex = args.payloadInput.length - args.freshPreamble.trailingInput.length;
            const prefixMatches = replayPrefixValuesEquivalent(args.payloadInput.slice(0, expectedBeforeTrailing.length), expectedBeforeTrailing);
            const trailingMatches = areEquivalentValues(args.payloadInput.slice(tailEndIndex), args.freshPreamble.trailingInput);
            if (prefixMatches && trailingMatches && tailEndIndex >= expectedBeforeTrailing.length) {
                const actualPostCompactionTail = cloneResponsesInputSlice(args.payloadInput.slice(args.freshPreamble.leadingInput.length + compactionSummaryInput.length + preCompactionKept.input.length, tailEndIndex));
                const extraPostCompactionTail = cloneResponsesInputSlice(args.payloadInput.slice(expectedBeforeTrailing.length, tailEndIndex));
                if (!actualPostCompactionTail || !extraPostCompactionTail)
                    return undefined;
                return { originalPiReplayInput, preCompactionKept, postCompactionTail, actualPostCompactionTail, extraPostCompactionTail };
            }
        }
    }
    return undefined;
}
