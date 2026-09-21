import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ResponsesCompatibleRequestPayload } from "../compaction/compaction-runtime.ts";
import type { NativeCompactionEntry } from "../compaction/types.js";
import { resolveToolPlacement, type DeferredToolPlacement } from "../../providers/openai-responses/shared.ts";
import { compareResponsesInputParity, serializeMessagesToResponsesInput, type ResponsesInputItem, type ResponsesInputMessageItem, type SerializeResponsesMessagesOptions } from "../compaction/serializer.js";
import { applyContextEdits, inspectCheckpointWindow } from "./context-edits.ts";
import { cloneOpaqueCompactedWindow, cloneResponsesInputSlice } from "./payload-structured.ts";
import { extractFreshAuthoritativePreamble } from "./payload-preamble.ts";
import { buildLenientNativeReplayPayload, collectReplayMessages, createCompactionSummaryAgentMessage, createReplaySlice, findReplayMatch, type SerializedReplaySlice } from "./native-replay-matching.ts";
import { CODEX_REASONING_UPDATE_TYPE } from "../reasoning-updates.ts";

export type NativeReplaySegments = {
	boundaryIndex: number;
	firstKeptEntryIndex: number;
	instructions?: string | undefined;
	freshPreamble: ResponsesInputMessageItem[];
	trailingPreamble: ResponsesInputMessageItem[];
	compactionSummary: ResponsesInputItem[];
	preCompactionKeptWindow: SerializedReplaySlice;
	compactedWindow: unknown[];
	postCompactionTail: SerializedReplaySlice;
	originalPiReplayInput: ResponsesInputItem[];
	replayInput: unknown[];
};

export type NativeReplayPayloadRewrite = {
	ok: true;
	segments: NativeReplaySegments;
	rewrittenPayload: ResponsesCompatibleRequestPayload;
};

export type NativeReplayPayloadRewriteFailureReason =
	| "compaction-boundary-not-found"
	| "first-kept-entry-not-found"
	| "context-edit-targets-compacted-content"
	| "unsupported-instructions"
	| "invalid-compacted-window"
	| "unexpected-compaction-after-boundary"
	| "expected-pi-replay-mismatch";

export type NativeReplayPayloadRewriteFailure = {
	ok: false;
	reason: NativeReplayPayloadRewriteFailureReason;
	parity?: {
		actual: string[];
		expected: string[];
		mismatches: string[];
	} | undefined;
};

export type NativeReplayPayloadRewriteResult =
	| NativeReplayPayloadRewrite
	| NativeReplayPayloadRewriteFailure;

export function findCompactionBoundaryIndex(
	entries: readonly SessionEntry[],
	compactionEntryId: string,
): number | undefined {
	const boundaryIndex = entries.findIndex((entry) => entry.id === compactionEntryId);
	return boundaryIndex >= 0 ? boundaryIndex : undefined;
}

export function serializeLiveTailToResponsesInput<TApi extends Api>(args: {
	model: Model<TApi>;
	entries: readonly SessionEntry[];
	serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): ResponsesInputItem[] {
	return serializeMessagesToResponsesInput(args.model, collectReplayMessages(args.entries), {
		...args.serializationOptions,
		// The tail continues the transcript whose head is stored in the checkpoint.
		startsAtTranscriptHead: false,
	});
}

/**
 * Session entries a checkpoint keeps as replayed history. Pi's `buildContextEntries` drops
 * system message entries from the kept window: their prompt and tool deltas are already folded
 * into the checkpoint's stored system message, so replaying them would duplicate or contradict it.
 */
function keptWindowEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter((entry) => !(entry.type === "message" && entry.message.role === "system"));
}

/**
 * Placement for every tool in the transcript a checkpoint will replay: the stored system message
 * plus the kept window and the live tail. One decision keeps all slices of that transcript aligned
 * with the payload the provider built from it.
 */
/**
 * Tool placement for a transcript a checkpoint replays: its stored system message leads, the given
 * entries follow. Both the replay rewrite and the reconstructed compaction request decide through
 * here, so a transcript assembled in pieces has exactly one placement.
 */
export function resolveReplayedToolPlacement<TApi extends Api>(args: {
	model: Model<TApi>;
	checkpointSystemMessage?: NativeCompactionEntry["systemMessage"] | undefined;
	entries: readonly SessionEntry[];
}): DeferredToolPlacement {
	return resolveToolPlacement(args.model, [
		...(args.checkpointSystemMessage ? [args.checkpointSystemMessage] : []),
		...collectReplayMessages(args.entries),
	]);
}

function buildNativeReplaySegmentsInternal<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesCompatibleRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
	serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): NativeReplayPayloadRewriteResult {
	const boundaryIndex = findCompactionBoundaryIndex(args.branchEntries, args.compactionEntry.id);
	if (boundaryIndex === undefined) {
		return {
			ok: false,
			reason: "compaction-boundary-not-found",
		};
	}

	// The checkpoint's boundary and its absorbed edits are one decision: a later edit to a
	// kept-window target would be lost inside the opaque window, so replay must fail instead of
	// serializing stale content.
	const checkpointWindow = inspectCheckpointWindow({
		branchEntries: args.branchEntries,
		checkpoint: args.compactionEntry,
		checkpointIndex: boundaryIndex,
	});
	if (!checkpointWindow.ok) {
		return {
			ok: false,
			reason: checkpointWindow.reason,
		};
	}

	const firstKeptEntryIndex = checkpointWindow.firstKeptEntryIndex;
	const keptRegionEntries = args.branchEntries.slice(firstKeptEntryIndex, boundaryIndex);
	const rawPostCompactionEntries = args.branchEntries.slice(boundaryIndex + 1);
	const contextEdits = checkpointWindow.edits;

	const preCompactionEntries = keptWindowEntries(
		applyContextEdits(keptRegionEntries, contextEdits)
			.filter((entry) => (entry.type !== "custom" && entry.type !== "custom_message") || entry.customType !== CODEX_REASONING_UPDATE_TYPE),
	);
	const postCompactionEntries = applyContextEdits(rawPostCompactionEntries, contextEdits);
	// Every slice below is part of one transcript: the checkpoint's stored system message leads it,
	// and the kept window plus the live tail follow. Decide tool placement once for that transcript
	// so no slice declares a tool the provider declared elsewhere.
	const replaySerializationOptions: SerializeResponsesMessagesOptions = {
		...args.serializationOptions,
		startsAtTranscriptHead: false,
		toolPlacement: resolveReplayedToolPlacement({
			model: args.model,
			checkpointSystemMessage: args.compactionEntry.systemMessage,
			entries: [...preCompactionEntries, ...postCompactionEntries],
		}),
	};
	// Window markers and persisted developer updates belong to history, not the fresh prompt envelope.
	const persistedInput = serializeMessagesToResponsesInput(args.model,
		collectReplayMessages([...preCompactionEntries, ...postCompactionEntries]), replaySerializationOptions);
	const freshPreamble = extractFreshAuthoritativePreamble(args.payload, persistedInput);
	if (!freshPreamble) {
		return {
			ok: false,
			reason: "unsupported-instructions",
		};
	}

	const compactedWindow = cloneOpaqueCompactedWindow(args.compactionEntry.details?.compactedWindow ?? []);
	if (!compactedWindow) {
		return {
			ok: false,
			reason: "invalid-compacted-window",
		};
	}

	const newerCompactionEntry = rawPostCompactionEntries
		.some((entry) => entry.type === "compaction");
	if (newerCompactionEntry) {
		const compactionSummaryInput = serializeMessagesToResponsesInput(args.model, [createCompactionSummaryAgentMessage(args.compactionEntry)], replaySerializationOptions);
		const lenientReplay = buildLenientNativeReplayPayload({ payload: args.payload, freshPreamble, compactedWindow, compactionSummaryInput });
		const originalPiReplayInput = cloneResponsesInputSlice(args.payload.input);
		if (!lenientReplay || !originalPiReplayInput) {
			return {
				ok: false,
				reason: "unexpected-compaction-after-boundary",
			};
		}

		return {
			ok: true,
			segments: {
				boundaryIndex,
				firstKeptEntryIndex,
				instructions: freshPreamble.instructions,
				freshPreamble: freshPreamble.leadingInput,
				trailingPreamble: freshPreamble.trailingInput,
				compactionSummary: [],
				preCompactionKeptWindow: createReplaySlice([], [], []),
				compactedWindow,
				postCompactionTail: createReplaySlice(postCompactionEntries, [], lenientReplay.conversationInput),
				originalPiReplayInput,
				replayInput: lenientReplay.input,
			},
			rewrittenPayload: {
				...args.payload,
				...(freshPreamble.instructions !== undefined ? { instructions: freshPreamble.instructions } : {}),
				input: lenientReplay.input,
			},
		};
	}

	const contextPostCompactionTailMessages = collectReplayMessages(postCompactionEntries);
	const compactionSummaryMessage = createCompactionSummaryAgentMessage(args.compactionEntry);
	const replayMatch = findReplayMatch({
		model: args.model,
		payloadInput: args.payload.input,
		freshPreamble,
		compactionSummaryMessage,
		preCompactionEntries,
		postCompactionEntries,
		serializationOptions: replaySerializationOptions,
	});

	if (!replayMatch) {
		const compactionSummaryInput = serializeMessagesToResponsesInput(args.model, [compactionSummaryMessage], replaySerializationOptions);
		const lenientReplay = buildLenientNativeReplayPayload({ payload: args.payload, freshPreamble, compactedWindow, compactionSummaryInput });
		if (lenientReplay) {
			return {
				ok: true,
				segments: {
					boundaryIndex,
					firstKeptEntryIndex,
					instructions: freshPreamble.instructions,
					freshPreamble: freshPreamble.leadingInput,
					trailingPreamble: freshPreamble.trailingInput,
					compactionSummary: compactionSummaryInput,
					preCompactionKeptWindow: createReplaySlice(preCompactionEntries, [], []),
					compactedWindow,
					postCompactionTail: createReplaySlice(postCompactionEntries, [], lenientReplay.conversationInput),
					originalPiReplayInput: cloneResponsesInputSlice(args.payload.input) ?? [],
					replayInput: lenientReplay.input,
				},
				rewrittenPayload: {
					...args.payload,
					...(freshPreamble.instructions !== undefined ? { instructions: freshPreamble.instructions } : {}),
					input: lenientReplay.input,
				},
			};
		}
		const expectedInput = [
			...freshPreamble.leadingInput,
			...compactionSummaryInput,
			...serializeMessagesToResponsesInput(args.model, collectReplayMessages(preCompactionEntries), replaySerializationOptions),
			...serializeMessagesToResponsesInput(args.model, collectReplayMessages(postCompactionEntries), replaySerializationOptions),
			...freshPreamble.trailingInput,
		];
		const parity = compareResponsesInputParity(args.payload.input, expectedInput);
		return {
			ok: false,
			reason: "expected-pi-replay-mismatch",
			parity: {
				actual: parity.actual,
				expected: parity.expected,
				mismatches: parity.mismatches,
			},
		};
	}

	const freshPreambleCount = freshPreamble.leadingInput.length;
	const compactionSummaryCount = serializeMessagesToResponsesInput(args.model, [compactionSummaryMessage], replaySerializationOptions).length;
	const preCompactionKeptCount = replayMatch.preCompactionKept.input.length;
	const actualCompactionSummary = cloneResponsesInputSlice(
		args.payload.input.slice(freshPreambleCount, freshPreambleCount + compactionSummaryCount),
	);
	const actualPreCompactionKeptWindow = cloneResponsesInputSlice(
		args.payload.input.slice(
			freshPreambleCount + compactionSummaryCount,
			freshPreambleCount + compactionSummaryCount + preCompactionKeptCount,
		),
	);
	const actualPostCompactionTail = replayMatch.actualPostCompactionTail;
	const contextPostCompactionTail = [
		...serializeMessagesToResponsesInput(args.model, contextPostCompactionTailMessages, replaySerializationOptions),
		...replayMatch.extraPostCompactionTail,
	];
	if (!actualCompactionSummary || !actualPreCompactionKeptWindow || !actualPostCompactionTail) {
		return {
			ok: false,
			reason: "expected-pi-replay-mismatch",
		};
	}

	const preCompactionKeptWindow = createReplaySlice(
		preCompactionEntries,
		replayMatch.preCompactionKept.messages,
		actualPreCompactionKeptWindow,
	);
	const postCompactionTail = createReplaySlice(
		postCompactionEntries,
		contextPostCompactionTailMessages,
		contextPostCompactionTail,
	);

	return {
		ok: true,
		segments: {
			boundaryIndex,
			firstKeptEntryIndex,
			instructions: freshPreamble.instructions,
			freshPreamble: freshPreamble.leadingInput,
			trailingPreamble: freshPreamble.trailingInput,
			compactionSummary: actualCompactionSummary,
			preCompactionKeptWindow,
			compactedWindow,
			postCompactionTail,
			originalPiReplayInput: replayMatch.originalPiReplayInput,
			replayInput: [
				...freshPreamble.leadingInput,
				...compactedWindow,
				...contextPostCompactionTail,
				...freshPreamble.trailingInput,
			],
		},
		rewrittenPayload: {
			...args.payload,
			...(freshPreamble.instructions !== undefined ? { instructions: freshPreamble.instructions } : {}),
			input: [
				...freshPreamble.leadingInput,
				...compactedWindow,
				...contextPostCompactionTail,
				...freshPreamble.trailingInput,
			],
		},
	};
}

export function buildNativeReplaySegments<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesCompatibleRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
	serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): NativeReplayPayloadRewriteResult {
	return buildNativeReplaySegmentsInternal(args);
}

export function rewriteResponsesPayloadWithNativeReplay<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesCompatibleRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
	serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): NativeReplayPayloadRewriteResult {
	return buildNativeReplaySegmentsInternal(args);
}
