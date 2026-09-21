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
import type { Context, Message, SystemMessage, Tool, ToolReference, TranscriptContext } from "@earendil-works/pi-ai";
/** A context whose prompt and tool declarations live in `system` messages. */
export interface ResolvedTranscript {
    messages: Message[];
}
/** Any message list; the replay helpers only inspect entries whose role is `"system"`. */
export type TranscriptMessages = readonly {
    role: string;
}[];
type SystemContent = string | readonly {
    type?: string;
    text?: string;
}[];
/** Extract and join text from message content. */
export declare function contentText(content: SystemContent, separator?: string): string;
/** Render a system message as a complete prompt: its content followed by its sections. */
export declare function getSystemMessageText(message: SystemMessage): string;
/**
 * Render a later system message for APIs that accept system messages mid-conversation.
 * Section changes are framed by name so the model can relate them to the leading prompt.
 */
export declare function renderSystemMessageUpdate(message: SystemMessage): string;
/**
 * Build the leading system message for a prompt and tool set. Returns undefined when
 * both are empty, so an empty transcript stays empty.
 */
export declare function createInitialSystemMessage(systemPrompt: string | undefined, tools: Tool[] | undefined): SystemMessage | undefined;
/**
 * Fold legacy `Context.systemPrompt` / `Context.tools` into a leading system message.
 * Idempotent: a context that already carries its prompt in system messages is returned
 * unchanged, which keeps provider entry points safe when the host normalized first.
 */
export declare function normalizeProviderContext(context: Context): ResolvedTranscript;
/**
 * Context for host APIs that consume a normalized transcript (Pi 0.86 `streamSimple`
 * entry points). Internal callers that bypass the model registry (voice context, remote
 * compaction v2, portable summaries) build plain `Context` objects, so fold them here.
 * The transcript brand exists only in the host type; the runtime value is the folded
 * `{ messages }` shape the host produces itself.
 */
export declare function toProviderTranscript(context: Context): TranscriptContext;
/**
 * Return the leading system message, if the transcript starts with one. A slice that continues
 * a longer transcript (`startsAtTranscriptHead === false`) has no leading prompt: its first
 * system message is a mid-conversation update, not the head.
 */
export declare function getInitialSystemMessage(messages: TranscriptMessages, startsAtTranscriptHead?: boolean): SystemMessage | undefined;
/** Resolve the tools available after applying every transcript delta in order. */
export declare function getCurrentTools(messages: TranscriptMessages): Tool[];
/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, sections are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
export declare function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined;
/**
 * Rebuild the transcript for APIs without mid-conversation system messages: the replayed
 * system message leads, and every later system message is dropped.
 */
export declare function collapseSystemMessages(context: ResolvedTranscript): ResolvedTranscript;
/** Keep later system messages in place when the model accepts them; otherwise collapse them. */
export declare function resolveTranscript(context: ResolvedTranscript, supportsMidConvoSystemMessages: boolean | undefined): ResolvedTranscript;
/** Every definition referenced by transcript tool state, in first-declaration order. */
export declare function getDeclaredTools(messages: TranscriptMessages): Tool[];
/**
 * Declarations reachable from a provider context, removed tools included. Grammar-tool
 * mappings must still cover a historical call to a tool that has since been removed.
 */
export declare function declaredToolsOf(context: Context): Tool[];
/** Names of the tools that are currently available for a provider context. */
export declare function currentToolNamesOf(context: Pick<Context, "messages">): Set<string>;
/** Whether tool history contains a removal or same-name redeclaration that an addition-only transport cannot replay. */
export declare function hasNonAdditiveToolChanges(messages: TranscriptMessages): boolean;
/**
 * Tool names a pre-0.86 transcript recorded on an individual tool result. Pi 0.85 put
 * dynamic tool introductions on `ToolResultMessage.addedToolNames`; 0.86 replaced that
 * field with system-message `toolsAdded`, so this reads the legacy shape defensively.
 */
export declare function legacyAddedToolNames(message: {
    role: string;
}): readonly string[];
export type { ToolReference };
