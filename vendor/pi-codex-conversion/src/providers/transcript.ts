/** Host transcript helpers with local slicing and historical-session compatibility. */
import {
	collapseSystemMessages as collapseHostSystemMessages,
	getCurrentTools,
	getDeclaredTools,
	getInitialSystemMessage as getHostInitialSystemMessage,
	normalizeContext,
	resolveTranscript as resolveHostTranscript,
	type Context, type Message, type SystemMessage, type TranscriptContext, type TranscriptMessages,
} from "@earendil-works/pi-ai";

export {
	contentText, createInitialSystemMessage, getCurrentSystemMessage, getCurrentTools,
	getDeclaredTools, getSystemMessageText, hasNonAdditiveToolChanges, renderSystemMessageUpdate,
	normalizeContext as normalizeProviderContext, normalizeContext as toProviderTranscript,
} from "@earendil-works/pi-ai";
export type { ToolReference, TranscriptMessages } from "@earendil-works/pi-ai";

/** Internal compaction callers can still construct an unbranded transcript. */
export interface ResolvedTranscript {
	messages: Message[];
}

/** A continuing slice's first system message is an update, not the original head. */
export function getInitialSystemMessage(messages: TranscriptMessages, startsAtTranscriptHead = true): SystemMessage | undefined {
	return startsAtTranscriptHead ? getHostInitialSystemMessage(messages) : undefined;
}

export function collapseSystemMessages(context: ResolvedTranscript): ResolvedTranscript {
	return collapseHostSystemMessages(context as TranscriptContext);
}

export function resolveTranscript(context: ResolvedTranscript, supportsMidConvoSystemMessages: boolean | undefined): ResolvedTranscript {
	return resolveHostTranscript(context as TranscriptContext, supportsMidConvoSystemMessages);
}

/** Removed tools remain reachable for replaying historical grammar calls. */
export function declaredToolsOf(context: Context) {
	return getDeclaredTools(normalizeContext(context).messages);
}

export function currentToolNamesOf(context: Pick<Context, "messages">): Set<string> {
	return new Set(getCurrentTools(normalizeContext(context as Context).messages).map((tool) => tool.name));
}

/** Upgrading Pi does not remove pre-0.86 addedToolNames from saved tool results. */
export function legacyAddedToolNames(message: { role: string }): readonly string[] {
	const value = (message as { addedToolNames?: unknown }).addedToolNames;
	if (!Array.isArray(value)) return [];
	return value.filter((name): name is string => typeof name === "string");
}
