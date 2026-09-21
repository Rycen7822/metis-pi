/**
 * Local transcript replay helpers (vendored from Pi 0.86.1).
 *
 * Pi 0.86 moved the provider-facing prompt and tool declarations out of
 * `Context.systemPrompt` / `Context.tools` and into a transcript that carries
 * `system` messages. Providers now receive a normalized transcript whose later
 * system messages can add or remove tools and patch prompt sections.
 *
 * The vendored upstream (3.0.34) predates that change, and the host helpers are
 * not exported by 0.85.x (where this bundle must keep working), so this file
 * keeps the subset of replay semantics from
 * `packages/ai/src/utils/transcript.ts` and `utils/text.ts` at Pi v0.86.1 that the
 * vendored transport consumes; helpers without a caller are not carried along
 * (see `PATCHES.md`, patch 2). Every entry point takes a plain `{ messages }`, so
 * the same code path serves legacy `Context` objects (compaction, replay) and
 * normalized transcripts.
 */
function isSystemMessage(message) {
    return message.role === "system";
}
/** Extract and join text from message content. */
export function contentText(content, separator = "\n") {
    if (typeof content === "string")
        return content;
    return content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(separator);
}
/** Render a system message as a complete prompt: its content followed by its sections. */
export function getSystemMessageText(message) {
    const parts = [contentText(message.content)];
    for (const text of Object.values(message.sections ?? {})) {
        if (text !== null)
            parts.push(text);
    }
    return parts.filter((part) => part.length > 0).join("\n\n");
}
/**
 * Render a later system message for APIs that accept system messages mid-conversation.
 * Section changes are framed by name so the model can relate them to the leading prompt.
 */
export function renderSystemMessageUpdate(message) {
    const parts = [];
    const text = contentText(message.content);
    if (text.length > 0)
        parts.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
        parts.push(value === null
            ? `Removed system prompt section "${name}".`
            : `Updated system prompt section "${name}":\n\n${value}`);
    }
    return parts.join("\n\n");
}
/**
 * Build the leading system message for a prompt and tool set. Returns undefined when
 * both are empty, so an empty transcript stays empty.
 */
export function createInitialSystemMessage(systemPrompt, tools) {
    const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
    const hasTools = tools !== undefined && tools.length > 0;
    if (!hasSystemPrompt && !hasTools)
        return undefined;
    return {
        role: "system",
        content: systemPrompt ?? "",
        ...(hasTools ? { toolsAdded: tools } : {}),
        timestamp: 0,
    };
}
/**
 * Fold legacy `Context.systemPrompt` / `Context.tools` into a leading system message.
 * Idempotent: a context that already carries its prompt in system messages is returned
 * unchanged, which keeps provider entry points safe when the host normalized first.
 */
export function normalizeProviderContext(context) {
    const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
    const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
    return { messages };
}
/**
 * Context for host APIs that consume a normalized transcript (Pi 0.86 `streamSimple`
 * entry points). Internal callers that bypass the model registry (voice context, remote
 * compaction v2, portable summaries) build plain `Context` objects, so fold them here.
 * The transcript brand exists only in the host type; the runtime value is the folded
 * `{ messages }` shape the host produces itself.
 */
export function toProviderTranscript(context) {
    return normalizeProviderContext(context);
}
/**
 * Return the leading system message, if the transcript starts with one. A slice that continues
 * a longer transcript (`startsAtTranscriptHead === false`) has no leading prompt: its first
 * system message is a mid-conversation update, not the head.
 */
export function getInitialSystemMessage(messages, startsAtTranscriptHead = true) {
    if (!startsAtTranscriptHead)
        return undefined;
    const first = messages[0];
    return first && isSystemMessage(first) ? first : undefined;
}
/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools(messages) {
    const tools = new Map();
    for (const message of messages) {
        if (!isSystemMessage(message))
            continue;
        const systemMessage = message;
        for (const tool of systemMessage.toolsRemoved ?? [])
            tools.delete(tool.name);
        for (const tool of systemMessage.toolsAdded ?? [])
            tools.set(tool.name, tool);
    }
    return [...tools.values()];
}
/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, sections are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
export function getCurrentSystemMessage(messages) {
    const content = [];
    const sections = new Map();
    let timestamp;
    for (const message of messages) {
        if (!isSystemMessage(message))
            continue;
        const systemMessage = message;
        timestamp ??= systemMessage.timestamp;
        const text = contentText(systemMessage.content);
        if (text.length > 0)
            content.push(text);
        for (const [name, value] of Object.entries(systemMessage.sections ?? {})) {
            if (value === null)
                sections.delete(name);
            else
                sections.set(name, value);
        }
    }
    const tools = getCurrentTools(messages);
    if (timestamp === undefined && tools.length === 0)
        return undefined;
    return {
        role: "system",
        content: content.join("\n\n"),
        ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
        ...(tools.length > 0 ? { toolsAdded: tools } : {}),
        timestamp: timestamp ?? 0,
    };
}
/**
 * Rebuild the transcript for APIs without mid-conversation system messages: the replayed
 * system message leads, and every later system message is dropped.
 */
export function collapseSystemMessages(context) {
    const head = getCurrentSystemMessage(context.messages);
    const messages = context.messages.filter((message) => message.role !== "system");
    return { messages: head ? [head, ...messages] : messages };
}
/** Keep later system messages in place when the model accepts them; otherwise collapse them. */
export function resolveTranscript(context, supportsMidConvoSystemMessages) {
    return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}
/** Every definition referenced by transcript tool state, in first-declaration order. */
export function getDeclaredTools(messages) {
    const definitions = new Map();
    for (const message of messages) {
        if (!isSystemMessage(message))
            continue;
        for (const tool of message.toolsAdded ?? [])
            definitions.set(tool.name, tool);
    }
    return [...definitions.values()];
}
/**
 * Declarations reachable from a provider context, removed tools included. Grammar-tool
 * mappings must still cover a historical call to a tool that has since been removed.
 */
export function declaredToolsOf(context) {
    return getDeclaredTools(normalizeProviderContext(context).messages);
}
/** Names of the tools that are currently available for a provider context. */
export function currentToolNamesOf(context) {
    return new Set(getCurrentTools(normalizeProviderContext(context).messages).map((tool) => tool.name));
}
/** Whether tool history contains a removal or same-name redeclaration that an addition-only transport cannot replay. */
export function hasNonAdditiveToolChanges(messages) {
    const declared = new Set();
    for (const message of messages) {
        if (!isSystemMessage(message))
            continue;
        const systemMessage = message;
        if ((systemMessage.toolsRemoved?.length ?? 0) > 0)
            return true;
        for (const tool of systemMessage.toolsAdded ?? []) {
            if (declared.has(tool.name))
                return true;
            declared.add(tool.name);
        }
    }
    return false;
}
/**
 * Split tool declarations between the top-level request field and in-place additions.
 * Transports that can anchor additions at a system message keep the initial tools at the
 * top and load later ones where they appear; that only works when no tool was removed or
 * redeclared, so everything else sends the current tool list.
 */
export function resolveTranscriptTools(messages, supportsToolAdditions, startsAtTranscriptHead = true) {
    const anchorsAdditions = supportsToolAdditions && !hasNonAdditiveToolChanges(messages);
    return {
        requestTools: anchorsAdditions
            ? (getInitialSystemMessage(messages, startsAtTranscriptHead)?.toolsAdded ?? [])
            : getCurrentTools(messages),
        anchorsAdditions,
    };
}
/**
 * Tool names a pre-0.86 transcript recorded on an individual tool result. Pi 0.85 put
 * dynamic tool introductions on `ToolResultMessage.addedToolNames`; 0.86 replaced that
 * field with system-message `toolsAdded`, so this reads the legacy shape defensively.
 */
export function legacyAddedToolNames(message) {
    const value = message.addedToolNames;
    if (!Array.isArray(value))
        return [];
    return value.filter((name) => typeof name === "string");
}
/** Tools that later system messages introduce on top of the leading declaration. */
export function getAnchoredToolAdditions(messages, startsAtTranscriptHead = true) {
    const initial = getInitialSystemMessage(messages, startsAtTranscriptHead);
    const additions = [];
    for (const message of messages) {
        if (!isSystemMessage(message) || message === initial)
            continue;
        for (const tool of message.toolsAdded ?? [])
            additions.push(tool);
    }
    return additions;
}
