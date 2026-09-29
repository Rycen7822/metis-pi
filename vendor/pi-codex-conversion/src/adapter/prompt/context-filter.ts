import type { CustomMessageEntry } from "@earendil-works/pi-coding-agent";
import { NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE } from "../compaction/types.ts";
import { EXECUTION_MODE_SESSION_ENTRY } from "../activation/execution-mode.ts";
import { CONTEXT_WINDOW_COMPACTION_SUMMARY } from "../../context-management/messages.ts";

const ADAPTER_CONTEXT_EXCLUDED_CUSTOM_MESSAGE_TYPES = new Set([
	NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE,
	EXECUTION_MODE_SESSION_ENTRY,
]);

export function isProviderContextExcludedMessage(message: {
	role: string;
	customType?: string | undefined;
	content?: unknown;
	summary?: unknown;
}): boolean {
	return (message.role === "compactionSummary" && message.summary === CONTEXT_WINDOW_COMPACTION_SUMMARY)
		// Retired session entries can still appear when an older conversation is reopened.
		|| (message.role === "custom" && (message.customType === "codex-realtime-voice"
			|| (message.customType === "codex-voice-mode"
				&& (typeof message.content !== "string" || !message.content.startsWith('<realtime_voice_session state="')))))
		|| (message.role === "custom" && typeof message.customType === "string" && ADAPTER_CONTEXT_EXCLUDED_CUSTOM_MESSAGE_TYPES.has(message.customType));
}

export function isProviderContextExcludedCustomMessageEntry(entry: CustomMessageEntry): boolean {
	return isProviderContextExcludedMessage({
		role: "custom",
		customType: entry.customType,
		content: entry.content,
	});
}
