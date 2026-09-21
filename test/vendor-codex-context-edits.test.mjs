#!/usr/bin/env node
/**
 * Pi 0.87 context-edit and checkpoint-shape regressions for the vendored Codex conversion.
 *
 * The fixtures are real 0.87 `SessionManager` sessions: messages are appended through
 * `appendMessage`, edits through `appendContextEdit`, and compaction checkpoints through
 * `appendCompaction` (including the retain-none `null` boundary). Assertions compare the
 * vendor's reconstruction/replay with the payload Pi itself builds from the same session, so a
 * projection that diverges from the host fails here instead of passing a private mirror.
 *
 * The `compactedWindow` fixture is a handmade offline checkpoint stand-in, never a real
 * server-side encrypted window, and every capture hook runs with `globalThis.fetch` disabled.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	ExtensionRunner,
	SessionManager,
	buildSessionContext,
	convertToLlm,
} from "@earendil-works/pi-coding-agent";
import { FAKE_API_KEY, captureBody, loadRegistration, modelNamed } from "./helpers/vendor-codex-provider.mjs";
import { SEALED_WINDOW_ITEM, systemMessage, tool, userMessage } from "./helpers/vendor-codex-sessions.mjs";

const COMPACTION_ENTRY = new URL("../vendor/pi-codex-conversion/dist/adapter/compaction/compaction.js", import.meta.url).href;
const REPLAY_ENTRY = new URL("../vendor/pi-codex-conversion/dist/adapter/replay/payload-rewrite.js", import.meta.url).href;
const HEADERS_ENTRY = new URL("../vendor/pi-codex-conversion/dist/providers/openai-codex/headers.js", import.meta.url).href;
const CONTINUITY_ENTRY = new URL("../vendor/pi-codex-conversion/dist/providers/openai-codex/session-continuity.js", import.meta.url).href;
const CONFIG_CONTRACT_ENTRY = new URL("../vendor/pi-codex-conversion/dist/adapter/activation/config-contract.js", import.meta.url).href;
const PROVIDER_REQUEST_ENTRY = new URL("../vendor/pi-codex-conversion/dist/adapter/provider-request.js", import.meta.url).href;

const {
	buildNativeCompactionInput,
	handleCodexSessionBeforeCompact,
	injectNativeWindowIntoPiCompactionRequest,
	resolveCanonicalCompactionReplay,
	resolveOpaqueNativeCompactionFallbackEntry,
} = await import(COMPACTION_ENTRY);
const { buildNativeReplaySegments } = await import(REPLAY_ENTRY);
const { extractAccountId, resolveCodexWebSocketUrl } = await import(HEADERS_ENTRY);
const { clearCanonicalSessions, recordCanonicalSessionResponse } = await import(CONTINUITY_ENTRY);
const { DEFAULT_CODEX_CONVERSION_CONFIG } = await import(CONFIG_CONTRACT_ENTRY);
const { rewriteCodexProviderRequest } = await import(PROVIDER_REQUEST_ENTRY);

let fixtureSeq = 0;

/** Pi < 0.87 has no `context_edit` entries; the projection is a no-op there. */
const contextEditSkip = typeof SessionManager.prototype.appendContextEdit === "function"
	? undefined
	: "Pi < 0.87 does not support context_edit entries";
const contextEditTest = (name, fn) => test(name, { skip: contextEditSkip }, fn);

/** Real 0.87 session with a native checkpoint; the tail follows the checkpoint. */
function checkpointFixture(model, { retainNone = false, firstKeptId, tail = [] } = {}) {
	const sm = SessionManager.inMemory(`/tmp/offline-session-${fixtureSeq++}`);
	const headId = sm.appendMessage(systemMessage("BASE_PROMPT", 0, { toolsAdded: [tool("tool_alpha")] }));
	const preId = sm.appendMessage(userMessage("pre-kept", 1));
	const keptId = sm.appendMessage(userMessage("kept-window", 2));
	const compactionId = sm.appendCompaction(
		"[OpenAI native compaction checkpoint]",
		retainNone ? null : (firstKeptId ?? preId),
		100,
		{
			strategy: "openai-responses-compaction-v2",
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: model.baseUrl,
			createdAt: new Date(4).toISOString(),
			compactedWindow: [SEALED_WINDOW_ITEM],
		},
	);
	const tailIds = tail.map(([, message]) => sm.appendMessage(message));
	return { sm, headId, preId, keptId, compactionId, tailIds };
}

/** Raw checkpoint build result; `compactionInput` is the narrowed form most tests want. */
function buildNativeInput(model, fixture) {
	const branchEntries = fixture.sm.getBranch();
	const index = branchEntries.findIndex((entry) => entry.id === fixture.compactionId);
	assert.ok(index >= 0, "the checkpoint entry must be on the active branch");
	return buildNativeCompactionInput({
		model,
		branchEntries,
		allEntries: fixture.sm.getEntries(),
		leafId: fixture.sm.getLeafId(),
		latestNativeCompaction: { ok: true, index, entry: branchEntries[index] },
	});
}

/** The compaction input of a checkpoint that must build; asserts success before returning it. */
function compactionInput(model, fixture) {
	const built = buildNativeInput(model, fixture);
	assert.equal(built.ok, true, `the checkpoint input must build (${built.reason ?? "?"})`);
	return built;
}

function replayPayload(model, payload, fixture) {
	const branchEntries = fixture.sm.getBranch();
	const compactionEntry = branchEntries.find((entry) => entry.id === fixture.compactionId);
	return buildNativeReplaySegments({ model, payload, branchEntries, compactionEntry });
}

async function providerPayload(model, sm) {
	const context = buildSessionContext(sm.getEntries(), sm.getLeafId());
	return captureBody(model, normalizeContext({ messages: convertToLlm(context.messages) }));
}

const hostMessages = (sm) => buildSessionContext(sm.getEntries(), sm.getLeafId()).messages;
const wire = (value) => JSON.stringify(value);
const contains = (value, needle) => wire(value).includes(needle);
const occurrences = (value, needle) => wire(value).split(needle).length - 1;
/** A plaintext retained user item, the shape `buildRemoteCompactionV2Window` keeps alongside the encrypted item. */
const windowMessage = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const fallbackRuntime = (model) => ({ provider: model.provider, api: model.api, baseUrl: model.baseUrl.replace(/\/+$/, "") });
const fallbackContext = (model, sm) => ({
	model,
	sessionManager: sm,
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: FAKE_API_KEY, headers: {} }) },
});
const fallbackState = (pending) => ({ config: structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG), ...(pending ? { pendingPiCompactionNativeWindow: pending } : {}) });
const pendingWindow = (model, sm, checkpointId, windowItems) => ({
	window: structuredClone(windowItems),
	...fallbackRuntime(model),
	sessionId: sm.getSessionId(),
	sourceCompactionEntryId: checkpointId,
});
const summarizationRequest = (model) => ({ model: model.id, instructions: "Summarize this conversation", input: [{ role: "user", content: "VISIBLE_USER_TEXT" }] });
const noteText = (notes) => notes.map(([text]) => text).join("\n");
const wireItemIndex = (value, needle) => (Array.isArray(value?.input) ? value.input.findIndex((item) => wire(item).includes(needle)) : -1);

/**
 * Run the production `session_before_compact` handler offline. The registered provider captures the
 * native request in its payload hook and then throws, so nothing opens a transport; the portable
 * path is captured at the fetch boundary (its body is zstd-compressed JSON).
 */
async function runCompactHandler(model, fixture, {
	state = fallbackState(),
	portable = false,
	signal = new AbortController().signal,
	failSessionBranch = false,
} = {}) {
	state.config.compaction.responsesCompaction = true;
	state.config.compaction.portableSummary = portable;
	const notes = [];
	const registration = await loadRegistration();
	let providerCalls = 0;
	let captured;
	const capturingRegistration = {
		...registration,
		streamSimple: (compactionModel, context, options = {}) => {
			providerCalls++;
			return registration.streamSimple(compactionModel, context, {
				...options,
				transport: "sse",
				async onPayload(body) {
					captured = (await options.onPayload?.(body)) ?? body;
					throw new Error("OFFLINE_CAPTURE_COMPLETE");
				},
			});
		},
	};
	const sessionManager = failSessionBranch
		? new Proxy(fixture.sm, {
			get: (target, property) => (property === "getBranch"
				? () => { throw new Error("OFFLINE_SESSION_FAILURE"); }
				: Reflect.get(target, property)),
		})
		: fixture.sm;
	const ctx = {
		model,
		sessionManager,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: FAKE_API_KEY, headers: {} }),
			getRegisteredProviderConfig: () => undefined,
			getRegisteredNativeProvider: () => capturingRegistration,
		},
		getSystemPrompt: () => "BASE_PROMPT",
		ui: { notify: (...args) => notes.push(args) },
		thinkingLevel: "off",
	};
	const fetchBodies = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init) => {
		const raw = init?.body;
		fetchBodies.push(raw instanceof Uint8Array ? zstdDecompressSync(raw).toString("utf8") : String(raw ?? ""));
		throw new Error("OFFLINE_PORTABLE_CAPTURE");
	};
	let result;
	try {
		result = await handleCodexSessionBeforeCompact(
			{
				type: "session_before_compact",
				preparation: {
					firstKeptEntryId: fixture.sm.getEntry(fixture.compactionId).firstKeptEntryId,
					messagesToSummarize: [userMessage("SUMMARIZE_ME", 1)],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: 100,
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
				},
				signal,
			},
			ctx,
			state,
			{ getThinkingLevel: () => "off" },
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
	return { result, notes, state, ctx, captured, providerCalls, fetchBodies };
}

/**
 * Append a checkpoint whose window absorbed the content visible in the session at that time. Pi
 * stores the boundary and the provider-built window; the window item here stands in for the
 * plaintext user item that `buildRemoteCompactionV2Window` retains next to the encrypted item.
 */
function absorbCheckpoint(fixture, { firstKeptEntryId, windowItems, createdAt }) {
	const details = fixture.sm.getEntry(fixture.compactionId).details;
	const id = fixture.sm.appendCompaction("[OpenAI native compaction checkpoint]", firstKeptEntryId, 100, {
		...details,
		createdAt: new Date(createdAt).toISOString(),
		compactedWindow: windowItems,
	});
	fixture.compactionId = id;
	return id;
}
/** The strict replay path serializes the tail itself; the lenient fallback keeps Pi's input. */
const usedStrictReplay = (result) => result.ok && result.segments.postCompactionTail.messages.length > 0;

const assistantToolCall = (model, id, name) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: { value: "x" } }],
	provider: model.provider,
	api: model.api,
	model: model.id,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
	stopReason: "toolUse",
	timestamp: 2,
});

const toolResult = (id, name, text, timestamp) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	timestamp,
});

contextEditTest("a deleted tail entry is omitted from the rebuilt compaction input and the strict replay", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, {
		tail: [
			["old", userMessage("OLD_MESSAGE", 5)],
			["live", userMessage("LIVE_TAIL", 6)],
		],
	});
	fixture.sm.appendContextEdit(fixture.tailIds[0], null);

	const host = hostMessages(fixture.sm);
	assert.equal(contains(host, "OLD_MESSAGE"), false, "the host projection drops the edited entry");

	const built = compactionInput(model, fixture);
	assert.equal(built.checkpointReused, true, "the checkpoint is still reusable");
	assert.equal(contains(built.input, "OLD_MESSAGE"), false, "the rebuilt compaction input must not resurrect the deleted entry");
	assert.equal(contains(built.input, "LIVE_TAIL"), true, "the rest of the live tail stays");

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `strict replay must accept the edited session (${result.reason ?? "?"})`);
	assert.equal(usedStrictReplay(result), true, "the replay serializes the edited tail itself instead of falling back to Pi's input");
	assert.equal(contains(result.rewrittenPayload, "OLD_MESSAGE"), false, "the rewritten request keeps the deletion");
});

contextEditTest("a replacement tail entry uses the final content on both the rebuilt and replayed request", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["old", userMessage("OLD_MESSAGE", 5)]] });
	fixture.sm.appendContextEdit(fixture.tailIds[0], { content: "NEW_REPLACEMENT" });

	const built = compactionInput(model, fixture);
	assert.equal(contains(built.input, "OLD_MESSAGE"), false);
	assert.equal(contains(built.input, "NEW_REPLACEMENT"), true);

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `strict replay must accept the edited session (${result.reason ?? "?"})`);
	assert.equal(usedStrictReplay(result), true, "the replay serializes the edited tail itself");
	assert.equal(contains(result.rewrittenPayload, "OLD_MESSAGE"), false);
	assert.equal(contains(result.rewrittenPayload, "NEW_REPLACEMENT"), true);
});

contextEditTest("repeated edits on one entry resolve to the last one, like the host projection", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["old", userMessage("OLD_MESSAGE", 5)]] });
	const target = fixture.tailIds[0];
	fixture.sm.appendContextEdit(target, { content: "FIRST_DRAFT" });
	fixture.sm.appendContextEdit(target, null);
	fixture.sm.appendContextEdit(target, { content: "FINAL_CONTENT" });

	const host = wire(hostMessages(fixture.sm));
	assert.equal(host.includes("FINAL_CONTENT"), true, "the host keeps the last edit");
	assert.equal(host.includes("FIRST_DRAFT"), false, "the host drops the superseded edit");
	assert.equal(host.includes("OLD_MESSAGE"), false);

	const built = compactionInput(model, fixture);
	const builtWire = wire(built.input);
	assert.equal(builtWire.includes("FINAL_CONTENT"), true);
	assert.equal(builtWire.includes("FIRST_DRAFT"), false);
	assert.equal(builtWire.includes("OLD_MESSAGE"), false);

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(usedStrictReplay(result), true, "the replay must follow the final edit, not an intermediate one");
	assert.equal(contains(result.rewrittenPayload, "FINAL_CONTENT"), true);
	assert.equal(contains(result.rewrittenPayload, "FIRST_DRAFT"), false);
});

contextEditTest("a custom-message replacement follows the host projection", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 6)]] });
	const customId = fixture.sm.appendCustomMessageEntry("offline-custom", "CUSTOM_ORIGINAL", true);
	fixture.sm.appendContextEdit(customId, { content: "CUSTOM_REPLACEMENT" });

	const host = wire(hostMessages(fixture.sm));
	assert.equal(host.includes("CUSTOM_REPLACEMENT"), true, "the host projects the replaced custom content");
	assert.equal(host.includes("CUSTOM_ORIGINAL"), false);

	const built = compactionInput(model, fixture);
	assert.equal(contains(built.input, "CUSTOM_REPLACEMENT"), true);
	assert.equal(contains(built.input, "CUSTOM_ORIGINAL"), false);

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `strict replay must accept the custom edit (${result.reason ?? "?"})`);
	assert.equal(usedStrictReplay(result), true);
	assert.equal(contains(result.rewrittenPayload, "CUSTOM_REPLACEMENT"), true);
	assert.equal(contains(result.rewrittenPayload, "CUSTOM_ORIGINAL"), false);
});

contextEditTest("a tool result replacement keeps its call pairing and final content", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, {
		tail: [
			["call", assistantToolCall(model, "call_1", "tool_alpha")],
			["result", toolResult("call_1", "tool_alpha", "OLD_RESULT", 3)],
		],
	});
	fixture.sm.appendContextEdit(fixture.tailIds[1], { content: "REPLACED_RESULT" });

	const built = compactionInput(model, fixture);
	const builtWire = wire(built.input);
	assert.equal(builtWire.includes("REPLACED_RESULT"), true);
	assert.equal(builtWire.includes("OLD_RESULT"), false);
	assert.equal(builtWire.includes('"type":"function_call"'), true, "the call is still replayed");
	assert.equal(builtWire.includes('"type":"function_call_output"'), true, "the edited result is still paired with its call");
	assert.equal(builtWire.includes("call_1"), true, "the call id survives the edit");

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `the strict replay must accept the edited result (${result.reason ?? "?"})`);
	assert.equal(usedStrictReplay(result), true);
	const rewritten = wire(result.rewrittenPayload);
	assert.equal(rewritten.includes('"type":"function_call"'), true, "the call is still in place");
	assert.equal(rewritten.includes('"type":"function_call_output"'), true, "the result is still paired with its call");
	assert.equal(rewritten.includes("REPLACED_RESULT"), true);
	assert.equal(rewritten.includes("OLD_RESULT"), false);
});

contextEditTest("an edit that targets content inside the opaque window is rejected instead of replayed stale", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	fixture.sm.appendContextEdit(fixture.preId, { content: "NEW_KEPT_TEXT" });

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, false, "replaying the opaque window would resurrect the replaced kept entry");
	assert.equal(result.reason, "context-edit-targets-compacted-content");

	const built = compactionInput(model, fixture);
	assert.equal(built.checkpointReused, false, "the unsafe checkpoint is not reused for a new compaction");
	assert.equal(contains(built.input, "NEW_KEPT_TEXT"), true, "the rebuilt input uses the edited context");
	assert.equal(contains(built.input, "pre-kept"), false, "the replaced kept entry is gone from the rebuild");
	assert.equal(contains(built.input, "LIVE_TAIL"), true, "the live tail still follows the rebuilt context");
});

contextEditTest("a retain-none checkpoint (appendCompaction with null) replays the live tail only", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, {
		retainNone: true,
		tail: [
			["live", userMessage("LIVE_TAIL", 5)],
			["after", userMessage("AFTER_TAIL", 6)],
		],
	});
	const compactionEntry = fixture.sm.getBranch().find((entry) => entry.id === fixture.compactionId);
	assert.equal(compactionEntry.firstKeptEntryId, compactionEntry.id, "Pi stores the checkpoint's own id for retain-none");

	const built = compactionInput(model, fixture);
	assert.equal(built.checkpointReused, true);
	assert.equal(contains(built.input, "LIVE_TAIL"), true);
	assert.equal(contains(built.input, "kept-window"), false, "no kept entry is replayed");
	assert.equal(contains(built.input, "pre-kept"), false, "no pre-checkpoint entry is replayed");

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `retain-none must replay (${result.reason ?? "?"})`);
	assert.equal(usedStrictReplay(result), true);
	assert.equal(contains(result.rewrittenPayload, "LIVE_TAIL"), true);
	assert.equal(contains(result.rewrittenPayload, "AFTER_TAIL"), true);

	const segments = result.segments;
	assert.deepEqual(segments.compactedWindow, [SEALED_WINDOW_ITEM], "the opaque window is preserved");
	assert.equal(segments.preCompactionKeptWindow.messages.length, 0, "the kept window is empty");
	assert.equal(segments.postCompactionTail.messages.length, 2, "both tail entries are replayed");
});

contextEditTest("an unknown firstKeptEntryId is still rejected after retain-none support", () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { firstKeptId: "missing-entry", tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const result = replayPayload(model, { model: model.id, input: [] }, fixture);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "first-kept-entry-not-found", "a missing boundary is not an empty window");
});

contextEditTest("a regular kept window without edits keeps the previous reconstruction and replay", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const built = compactionInput(model, fixture);
	assert.notEqual(built.checkpointReused, false, "an unedited checkpoint stays reusable");
	assert.equal(contains(built.input, "kept-window"), false, "the kept window stays inside the opaque checkpoint");
	assert.equal(contains(built.input, "LIVE_TAIL"), true);

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `unedited sessions keep replaying (${result.reason ?? "?"})`);
	assert.equal(usedStrictReplay(result), true);
	assert.equal(result.segments.firstKeptEntryIndex < result.segments.boundaryIndex, true, "the kept window is present");
	assert.equal(contains(result.rewrittenPayload, "LIVE_TAIL"), true);
});

contextEditTest("system section updates survive an edit elsewhere in the transcript", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, {
		tail: [
			["change", systemMessage("UPDATE_TEXT", 5, { sections: { goal: "NEW_GOAL" } })],
			["old", userMessage("OLD_MESSAGE", 6)],
			["live", userMessage("LIVE_TAIL", 7)],
		],
	});
	fixture.sm.appendContextEdit(fixture.tailIds[1], null);

	const built = compactionInput(model, fixture);
	assert.equal(contains(built.input, "UPDATE_TEXT"), true, "the system update is still replayed");
	assert.equal(contains(built.input, "NEW_GOAL"), true, "the section change is still replayed");
	assert.equal(contains(built.input, "OLD_MESSAGE"), false);

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(usedStrictReplay(result), true);
	const rewritten = wire(result.rewrittenPayload);
	assert.equal(rewritten.includes("UPDATE_TEXT"), true);
	assert.equal(rewritten.includes("NEW_GOAL"), true);
	assert.equal(rewritten.includes("OLD_MESSAGE"), false);
	assert.deepEqual(
		(result.rewrittenPayload.tools ?? []).map((declaration) => declaration.name),
		["tool_alpha"],
		"the tool table is unaffected by the edited message",
	);
});

contextEditTest("a context handler filter keeps the prompt and tools while replay accepts the filtered payload", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, {
		tail: [
			["drop", userMessage("FILTERED_MESSAGE", 5)],
			["live", userMessage("LIVE_TAIL", 6)],
		],
	});
	const hostContext = buildSessionContext(fixture.sm.getEntries(), fixture.sm.getLeafId());
	const leadingSystemMessage = hostContext.messages[0];
	assert.equal(leadingSystemMessage.role, "system");

	const extension = {
		path: "/tmp/offline-context-handler.ts",
		resolvedPath: "/tmp/offline-context-handler.ts",
		sourceInfo: {},
		handlers: new Map([
			["context", [({ messages }) => ({ messages: messages.filter((message) => !contains(message, "FILTERED_MESSAGE")) })]],
		]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	const runtime = new Proxy({ getThinkingLevel: () => "medium" }, { get: (target, property) => target[property] ?? (() => undefined) });
	const runner = new ExtensionRunner([extension], runtime, "/tmp/offline-session", fixture.sm, {});
	const filtered = await runner.emitContext(hostContext.messages);

	assert.deepEqual(filtered[0], leadingSystemMessage, "the host restores the leading prompt/tool state");
	assert.equal(contains(filtered, "FILTERED_MESSAGE"), false, "the handler's filter is applied");
	assert.equal(contains(filtered, "LIVE_TAIL"), true);

	const payload = await captureBody(model, normalizeContext({ messages: convertToLlm(filtered) }));
	const result = replayPayload(model, payload, fixture);
	assert.equal(result.ok, true, `replay must accept a filtered payload (${result.reason ?? "?"})`);
	assert.equal(contains(result.rewrittenPayload, "FILTERED_MESSAGE"), false, "the filtered message stays out of the rewritten request");
	assert.equal(contains(result.rewrittenPayload, "LIVE_TAIL"), true);
	assert.deepEqual(result.rewrittenPayload.instructions, "BASE_PROMPT", "the prompt is preserved");
	assert.deepEqual(
		(result.rewrittenPayload.tools ?? []).map((declaration) => declaration.name),
		["tool_alpha"],
		"the tool table is preserved",
	);
});

contextEditTest("a missing canonical baseline falls back to the edited reconstruction", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["old", userMessage("OLD_MESSAGE", 5)]] });
	fixture.sm.appendContextEdit(fixture.tailIds[0], { content: "NEW_REPLACEMENT" });
	const built = compactionInput(model, fixture);
	const sessionId = "offline-context-edit-no-canonical";
	try {
		clearCanonicalSessions(sessionId);
		const canonicalReplay = await resolveCanonicalCompactionReplay({
			codeMode: false,
			sessionId,
			model: model.id,
			identity: { url: resolveCodexWebSocketUrl(model.baseUrl), accountId: extractAccountId(FAKE_API_KEY) },
			reconstructedInput: built.input,
		});
		assert.equal(canonicalReplay.decision, "no_state");
		assert.equal(canonicalReplay.input, undefined, "there is no canonical input to replay");
		assert.equal(contains(built.input, "OLD_MESSAGE"), false, "the fallback reconstruction carries the edit");
	} finally {
		clearCanonicalSessions(sessionId);
	}
});

contextEditTest("a canonical baseline invalidated by an edit falls back to the edited reconstruction", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["old", userMessage("OLD_MESSAGE", 5)]] });
	const builtBeforeEdit = compactionInput(model, fixture);
	const identity = { url: resolveCodexWebSocketUrl(model.baseUrl), accountId: extractAccountId(FAKE_API_KEY) };
	const sessionId = "offline-context-edit-canonical";
	try {
		// The baseline materialized the session before the edit existed, as a previous request would.
		recordCanonicalSessionResponse({
			sessionId,
			url: identity.url,
			accountId: identity.accountId,
			requestBody: { model: model.id, input: builtBeforeEdit.input },
			responseItems: [],
		});
		fixture.sm.appendContextEdit(fixture.tailIds[0], { content: "NEW_REPLACEMENT" });
		const builtAfterEdit = compactionInput(model, fixture);

		const stale = await resolveCanonicalCompactionReplay({
			codeMode: false,
			sessionId,
			model: model.id,
			identity,
			reconstructedInput: builtAfterEdit.input,
		});
		assert.notEqual(stale.decision, "validated", "a baseline that predates the edit must not be replayed");
		assert.equal(stale.input, undefined, "the edited reconstruction is authoritative");
		assert.equal(contains(builtAfterEdit.input, "OLD_MESSAGE"), false);
		assert.equal(contains(builtAfterEdit.input, "NEW_REPLACEMENT"), true);

		// A baseline recorded from the edited reconstruction is validated and keeps the edit.
		clearCanonicalSessions(sessionId);
		recordCanonicalSessionResponse({
			sessionId,
			url: identity.url,
			accountId: identity.accountId,
			requestBody: { model: model.id, input: builtAfterEdit.input },
			responseItems: [],
		});
		const validated = await resolveCanonicalCompactionReplay({
			codeMode: false,
			sessionId,
			model: model.id,
			identity,
			reconstructedInput: builtAfterEdit.input,
		});
		assert.equal(validated.decision, "validated");
		assert.equal(contains(validated.input, "NEW_REPLACEMENT"), true);
		assert.equal(contains(validated.input, "OLD_MESSAGE"), false);
	} finally {
		clearCanonicalSessions(sessionId);
	}
});

/* ------------------------------------------------------------------------------------------------
 * Checkpoint-relative validity: edits the checkpoint absorbed stay reusable, edits recorded after it
 * that rewrite kept content invalidate the window, and every outbound window exit shares the rule.
 * ---------------------------------------------------------------------------------------------- */

contextEditTest("an edit absorbed by the newest checkpoint stays reusable and is not duplicated", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["old", userMessage("OLD_MESSAGE", 5)]] });
	fixture.sm.appendContextEdit(fixture.tailIds[0], { content: "EDIT_ALREADY_COMPACTED" });
	absorbCheckpoint(fixture, {
		firstKeptEntryId: fixture.tailIds[0],
		windowItems: [windowMessage("EDIT_ALREADY_COMPACTED")],
		createdAt: 6,
	});
	fixture.sm.appendMessage(userMessage("NEXT_QUESTION", 7));

	const host = wire(hostMessages(fixture.sm));
	assert.equal(host.includes("EDIT_ALREADY_COMPACTED"), true, "the host still projects the edit");
	assert.equal(host.includes("OLD_MESSAGE"), false);

	const built = compactionInput(model, fixture);
	assert.equal(built.checkpointReused, true, "an edit recorded before the checkpoint must not invalidate it");
	assert.equal(occurrences(built.input, "EDIT_ALREADY_COMPACTED"), 1, "the absorbed content is sent once");
	assert.equal(contains(built.input, "OLD_MESSAGE"), false);

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `the absorbed edit must replay (${result.reason ?? "?"})`);
	assert.equal(usedStrictReplay(result), true);
	assert.equal(occurrences(result.rewrittenPayload, "EDIT_ALREADY_COMPACTED"), 1, "the kept window is replaced, not appended");
	assert.equal(contains(result.rewrittenPayload, "OLD_MESSAGE"), false);
	assert.equal(contains(result.rewrittenPayload, "NEXT_QUESTION"), true);
});

contextEditTest("an omission absorbed by the newest checkpoint does not resurrect the deleted message", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, {
		tail: [
			["old", userMessage("OLD_MESSAGE", 5)],
			["live", userMessage("LIVE_TAIL", 6)],
		],
	});
	fixture.sm.appendContextEdit(fixture.tailIds[0], null);
	absorbCheckpoint(fixture, {
		firstKeptEntryId: fixture.tailIds[1],
		windowItems: [windowMessage("WINDOW_AFTER_OMISSION")],
		createdAt: 7,
	});

	const built = compactionInput(model, fixture);
	assert.equal(built.checkpointReused, true, "an absorbed omission must not invalidate the checkpoint");
	assert.equal(contains(built.input, "OLD_MESSAGE"), false, "the deleted message stays out of the input");

	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `the absorbed omission must replay (${result.reason ?? "?"})`);
	assert.equal(contains(result.rewrittenPayload, "OLD_MESSAGE"), false);
	assert.equal(contains(result.rewrittenPayload, "LIVE_TAIL"), false, "the kept entry is represented by the window");
	assert.equal(contains(result.rewrittenPayload, "WINDOW_AFTER_OMISSION"), true);
});

contextEditTest("multiple edits absorbed by the checkpoint are not reported, a later one still invalidates", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["old", userMessage("OLD_MESSAGE", 5)]] });
	const target = fixture.tailIds[0];
	fixture.sm.appendContextEdit(target, { content: "FIRST_DRAFT" });
	fixture.sm.appendContextEdit(target, { content: "ABSORBED_FINAL" });
	absorbCheckpoint(fixture, {
		firstKeptEntryId: target,
		windowItems: [windowMessage("ABSORBED_FINAL")],
		createdAt: 6,
	});

	const absorbed = compactionInput(model, fixture);
	assert.equal(absorbed.checkpointReused, true, "the last absorbed edit is the checkpoint's baseline");
	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `the absorbed chain must replay (${result.reason ?? "?"})`);
	assert.equal(contains(result.rewrittenPayload, "ABSORBED_FINAL"), true);
	assert.equal(contains(result.rewrittenPayload, "FIRST_DRAFT"), false, "superseded drafts stay out");

	// A later edit on the same target changes kept content the window already absorbed.
	fixture.sm.appendContextEdit(target, null);
	fixture.sm.appendContextEdit(target, { content: "LATER_FINAL" });
	const invalidated = compactionInput(model, fixture);
	assert.equal(invalidated.checkpointReused, false, "an edit after the checkpoint invalidates it");
	assert.equal(contains(invalidated.input, "LATER_FINAL"), true);
	assert.equal(contains(invalidated.input, "ABSORBED_FINAL"), false, "the rebuild carries the current projection");

	const staleReplay = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(staleReplay.ok, false);
	assert.equal(staleReplay.reason, "context-edit-targets-compacted-content");
	assert.equal(
		resolveOpaqueNativeCompactionFallbackEntry(fixture.sm.getBranch(), fallbackRuntime(model)),
		undefined,
		"the invalidated window is not offered to the fallback either",
	);
});

contextEditTest("a rebuild followed by a new checkpoint recovers replay and the next compaction", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, {
		tail: [
			["old", userMessage("OLD_MESSAGE", 5)],
			["live", userMessage("LIVE_TAIL", 6)],
		],
	});
	// The edit rewrites a kept-window entry after the checkpoint, so the window cannot be reused.
	fixture.sm.appendContextEdit(fixture.keptId, { content: "REBUILT_TEXT" });

	const rebuilt = compactionInput(model, fixture);
	assert.equal(rebuilt.checkpointReused, false, "the post-checkpoint edit invalidates the first checkpoint");
	assert.equal(contains(rebuilt.input, "REBUILT_TEXT"), true);
	assert.equal(contains(rebuilt.input, "kept-window"), false);

	// Pi stores the checkpoint the provider built from that rebuilt input.
	absorbCheckpoint(fixture, {
		firstKeptEntryId: fixture.keptId,
		windowItems: [windowMessage("REBUILT_TEXT")],
		createdAt: 6,
	});
	fixture.sm.appendMessage(userMessage("NEXT_QUESTION", 7));

	const replayed = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(replayed.ok, true, `the new checkpoint must replay (${replayed.reason ?? "?"})`);
	assert.equal(occurrences(replayed.rewrittenPayload, "REBUILT_TEXT"), 1);
	assert.equal(contains(replayed.rewrittenPayload, "kept-window"), false);
	assert.equal(contains(replayed.rewrittenPayload, "NEXT_QUESTION"), true);

	const nextCompaction = compactionInput(model, fixture);
	assert.equal(nextCompaction.checkpointReused, true, "the next compaction reuses the newest checkpoint");

	fixture.sm.appendMessage(userMessage("ANOTHER_QUESTION", 8));
	const after = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(after.ok, true, `recovery must be stable (${after.reason ?? "?"})`);
	assert.equal(contains(after.rewrittenPayload, "ANOTHER_QUESTION"), true);
});

contextEditTest("a third checkpoint absorbs an edit while an older checkpoint sits in its kept window", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, {
		tail: [
			["old", userMessage("OLD_MESSAGE", 5)],
			["live", userMessage("LIVE_TAIL", 6)],
		],
	});
	fixture.sm.appendContextEdit(fixture.tailIds[1], { content: "LIVE_EDITED" });
	absorbCheckpoint(fixture, {
		firstKeptEntryId: fixture.tailIds[0],
		windowItems: [windowMessage("WINDOW_SECOND")],
		createdAt: 6,
	});
	assert.equal(compactionInput(model, fixture).checkpointReused, true, "the second checkpoint absorbed the live edit");

	// The third checkpoint keeps from the second's tail, so the second checkpoint entry itself is
	// inside the raw kept range and must contribute no extra summary or window.
	fixture.sm.appendMessage(userMessage("AFTER_SECOND", 7));
	absorbCheckpoint(fixture, {
		firstKeptEntryId: fixture.tailIds[1],
		windowItems: [windowMessage("LIVE_EDITED"), windowMessage("WINDOW_THIRD")],
		createdAt: 8,
	});

	const built = compactionInput(model, fixture);
	assert.equal(built.checkpointReused, true, "the third checkpoint stays reusable");
	const result = replayPayload(model, await providerPayload(model, fixture.sm), fixture);
	assert.equal(result.ok, true, `an older checkpoint in the kept range must not break replay (${result.reason ?? "?"})`);
	assert.equal(occurrences(result.rewrittenPayload, "LIVE_EDITED"), 1, "the older checkpoint does not add its window twice");
	assert.equal(contains(result.rewrittenPayload, "WINDOW_SECOND"), false, "the superseded window stays out");
	assert.equal(occurrences(result.rewrittenPayload, "WINDOW_THIRD"), 1, "the newest window is sent once");
});

contextEditTest("a stale checkpoint is not offered to the portable summary or the Pi fallback window", () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	assert.ok(
		resolveOpaqueNativeCompactionFallbackEntry(fixture.sm.getBranch(), fallbackRuntime(model)),
		"control: a checkpoint without later edits stays selectable",
	);

	fixture.sm.appendContextEdit(fixture.keptId, { content: "LATER_KEPT_TEXT" });
	assert.equal(
		resolveOpaqueNativeCompactionFallbackEntry(fixture.sm.getBranch(), fallbackRuntime(model)),
		undefined,
		"an edit recorded after the checkpoint disqualifies the window for both summary paths",
	);
	assert.equal(fallbackState(undefined).pendingPiCompactionNativeWindow, undefined, "no window is stashed from a disqualified checkpoint");
});

contextEditTest("a pending window is re-validated at the summary request boundary", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const pending = pendingWindow(model, fixture.sm, fixture.compactionId, [SEALED_WINDOW_ITEM]);
	const ctx = fallbackContext(model, fixture.sm);
	const state = fallbackState();

	const injected = await injectNativeWindowIntoPiCompactionRequest(summarizationRequest(model), ctx, state, pending);
	assert.equal(injected.status, "injected", "control: a valid window is injected");
	assert.equal(contains(injected.payload, "offline-sealed-fixture"), true);
	assert.equal(contains(injected.payload, "LIVE_TAIL"), false, "the injection only adds the compacted window");

	const unrelated = await injectNativeWindowIntoPiCompactionRequest({ model: model.id, input: [] }, ctx, state, pending);
	assert.equal(unrelated.status, "not-applicable", "a non-summarization request neither consumes nor rejects the window");

	fixture.sm.appendContextEdit(fixture.keptId, { content: "LATER_KEPT_TEXT" });
	const blocked = await injectNativeWindowIntoPiCompactionRequest(summarizationRequest(model), ctx, state, pending);
	assert.equal(blocked.status, "rejected");
	assert.equal(blocked.reason, "source-checkpoint-invalid", "the stale window must not reach the summary request");

	const switched = await injectNativeWindowIntoPiCompactionRequest(summarizationRequest(model), ctx, state, { ...pending, sessionId: "offline-other-session" });
	assert.equal(switched.status, "rejected");
	assert.equal(switched.reason, "session-mismatch", "a pending window never crosses sessions");

	const missing = await injectNativeWindowIntoPiCompactionRequest(summarizationRequest(model), ctx, state, undefined);
	assert.equal(missing.status, "not-applicable", "no window is not an injection");
});

contextEditTest("a canonical baseline cannot restore a checkpoint that an edit invalidated", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["old", userMessage("OLD_MESSAGE", 5)]] });
	const identity = { url: resolveCodexWebSocketUrl(model.baseUrl), accountId: extractAccountId(FAKE_API_KEY) };
	const sessionId = "offline-context-edit-canonical-checkpoint";
	try {
		const beforeEdit = compactionInput(model, fixture);
		assert.equal(beforeEdit.checkpointReused, true);
		recordCanonicalSessionResponse({
			sessionId,
			url: identity.url,
			accountId: identity.accountId,
			requestBody: { model: model.id, input: beforeEdit.input },
			responseItems: [],
		});

		fixture.sm.appendContextEdit(fixture.keptId, { content: "LATER_KEPT_TEXT" });
		const rebuilt = compactionInput(model, fixture);
		assert.equal(rebuilt.checkpointReused, false);
		assert.equal(contains(rebuilt.input, "LATER_KEPT_TEXT"), true);
		assert.equal(contains(rebuilt.input, "kept-window"), false, "the rebuild replaces the edited kept entry");

		const replay = await resolveCanonicalCompactionReplay({
			codeMode: false,
			sessionId,
			model: model.id,
			identity,
			reconstructedInput: rebuilt.input,
		});
		assert.notEqual(replay.decision, "validated", "a baseline from before the edit must not be replayed");
		assert.equal(replay.input, undefined, "the edited reconstruction stays authoritative");
	} finally {
		clearCanonicalSessions(sessionId);
	}
});

// --- Real `session_before_compact` handler runs ------------------------------------------------
// These use the production compaction entry point (source resolution, portable summary, native
// attempt, Pi fallback hand-off) and assert on the payloads that would leave the process.

test("the real compaction handler reuses a valid checkpoint without reordering window and tail", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const { result, notes, state, captured, providerCalls, fetchBodies } = await runCompactHandler(model, fixture);

	assert.equal(result, undefined, "the offline capture fails the native attempt, so Pi compaction runs");
	assert.equal(providerCalls, 1, "exactly one native attempt is made");
	assert.equal(fetchBodies.length, 0, "the native path does not touch the portable transport");
	assert.equal(contains(captured, "offline-sealed-fixture"), true, "the valid checkpoint window is on the wire");
	assert.equal(occurrences(captured, "offline-sealed-fixture"), 1);
	assert.equal(contains(captured, "LIVE_TAIL"), true, "the live tail follows the window");
	assert.ok(wireItemIndex(captured, "offline-sealed-fixture") < wireItemIndex(captured, "LIVE_TAIL"), "the window stays before the tail");
	assert.equal(contains(captured, "kept-window"), false, "kept entries stay inside the opaque window");
	assert.ok(state.pendingPiCompactionNativeWindow, "a failed native attempt offers the valid window to the Pi fallback");
	assert.equal(state.pendingPiCompactionNativeWindow.sourceCompactionEntryId, fixture.compactionId);
	assert.doesNotMatch(noteText(notes), /rebuilds from the visible edited conversation/);
});

test("the real compaction handler accepts a retain-none checkpoint and keeps the live tail", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, {
		retainNone: true,
		tail: [
			["live", userMessage("LIVE_TAIL", 5)],
			["after", userMessage("AFTER_TAIL", 6)],
		],
	});
	const { captured, state } = await runCompactHandler(model, fixture);

	assert.equal(contains(captured, "offline-sealed-fixture"), true, "the empty kept window still reuses the opaque checkpoint");
	assert.equal(contains(captured, "LIVE_TAIL"), true);
	assert.equal(contains(captured, "AFTER_TAIL"), true);
	assert.equal(contains(captured, "kept-window"), false, "no retained entry is replayed");
	assert.equal(contains(captured, "pre-kept"), false);
	assert.ok(state.pendingPiCompactionNativeWindow, "retain-none is a valid window for the Pi fallback");
});

test("a legacy null first-kept boundary replays as retain-none like the host projection", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	// 0.86 stored null for `appendCompaction(summary, null, ...)`; both hosts project that as an
	// empty kept window, so the vendored judgment must not refuse it.
	fixture.sm.getEntry(fixture.compactionId).firstKeptEntryId = null;
	const branchEntries = fixture.sm.getBranch();
	const checkpointIndex = branchEntries.findIndex((entry) => entry.id === fixture.compactionId);
	const built = buildNativeCompactionInput({
		model,
		branchEntries,
		allEntries: branchEntries,
		leafId: fixture.sm.getLeafId(),
		latestNativeCompaction: { ok: true, index: checkpointIndex, entry: branchEntries[checkpointIndex] },
	});
	assert.equal(built.ok, true, `a null boundary is retain-none (${built.reason ?? "?"})`);
	assert.equal(built.checkpointReused, true);
	assert.equal(contains(built.input, "offline-sealed-fixture"), true);
	assert.equal(contains(built.input, "kept-window"), false, "no pre-checkpoint entry is kept");
	assert.equal(contains(built.input, "LIVE_TAIL"), true);

	const replay = buildNativeReplaySegments({
		model,
		payload: await providerPayload(model, fixture.sm),
		branchEntries,
		compactionEntry: branchEntries[checkpointIndex],
	});
	assert.equal(replay.ok, true, "replay also treats the null boundary as retain-none");
	assert.equal(replay.segments.firstKeptEntryIndex, checkpointIndex);
});

/**
 * Boundary shapes a checkpoint can carry. `null` (legacy 0.86) and the checkpoint's own id (0.87)
 * are the two retain-none markers; a kept entry before the checkpoint is an ordinary window. A
 * missing field, an explicit undefined, an unknown id and a tail id are unresolvable and must not
 * degrade into an empty kept window. Each shape runs the same deterministic judgment (build and
 * replay) and the real handler with the portable summary both off and on, so the native and
 * portable request counts are visible for every case.
 */
const checkpointBoundaryShapes = [
	["missing field", (entry) => { delete entry.firstKeptEntryId; }, false],
	["explicit undefined", (entry) => { entry.firstKeptEntryId = undefined; }, false],
	["unknown id", (entry) => { entry.firstKeptEntryId = "missing-boundary"; }, false],
	["id after the checkpoint", (entry, fixture) => { entry.firstKeptEntryId = fixture.tailIds[0]; }, false],
	["legacy null", (entry) => { entry.firstKeptEntryId = null; }, true],
	["the checkpoint's own id", (entry) => { entry.firstKeptEntryId = entry.id; }, true],
	["a kept entry before the checkpoint", (entry, fixture) => { entry.firstKeptEntryId = fixture.preId; }, true],
];

for (const [shape, apply, accepted] of checkpointBoundaryShapes) {
	test(`the real handler treats a ${shape} boundary as ${accepted ? "a reusable window" : "unresolvable"}`, async () => {
		const model = modelNamed("gpt-6-astra");
		const makeFixture = () => {
			const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
			apply(fixture.sm.getEntry(fixture.compactionId), fixture);
			return fixture;
		};

		const fixture = makeFixture();
		const built = buildNativeInput(model, fixture);
		const replay = replayPayload(
			model,
			accepted ? await providerPayload(model, fixture.sm) : { model: model.id, input: [] },
			fixture,
		);
		assert.equal(built.ok, accepted, `the build ${accepted ? "accepts" : "rejects"} the boundary`);
		assert.equal(replay.ok, accepted, `replay ${accepted ? "accepts" : "rejects"} the boundary`);
		if (accepted) {
			assert.equal(built.checkpointReused, true);
			assert.equal(contains(built.input, "offline-sealed-fixture"), true);
			assert.equal(contains(built.input, "LIVE_TAIL"), true);
			assert.ok(replay.segments.firstKeptEntryIndex >= 0);
		} else {
			assert.equal(built.reason, "first-kept-entry-not-found");
			assert.equal(replay.reason, "first-kept-entry-not-found");
			assert.equal(
				resolveOpaqueNativeCompactionFallbackEntry(fixture.sm.getBranch(), fallbackRuntime(model)),
				undefined,
				"the unresolved checkpoint is offered to no fallback window",
			);
		}

		for (const portable of [false, true]) {
			const run = await runCompactHandler(model, makeFixture(), { portable });
			const where = portable ? "portable summary on" : "portable summary off";
			if (accepted) {
				assert.equal(run.providerCalls, 1, `${where}: one native attempt`);
				assert.equal(contains(run.captured, "offline-sealed-fixture"), true, `${where}: the window is on the native wire`);
				assert.equal(run.fetchBodies.length, portable ? 1 : 0, `${where}: portable transport usage`);
				if (portable) {
					assert.equal(contains(JSON.parse(run.fetchBodies[0]), "offline-sealed-fixture"), true, `${where}: the portable request carries the window`);
				}
			} else {
				assert.deepEqual(run.result, { cancel: true }, `${where}: the handler cancels`);
				assert.equal(run.providerCalls, 0, `${where}: no native request`);
				assert.equal(run.fetchBodies.length, 0, `${where}: no portable request leaves before the boundary is known`);
				assert.equal(run.captured, undefined, `${where}: no native payload is captured`);
				assert.equal(run.state.pendingPiCompactionNativeWindow, undefined, `${where}: no window is handed to the Pi fallback`);
				assert.match(noteText(run.notes), /first-kept boundary/i, `${where}: the message names the unresolvable boundary`);
				assert.doesNotMatch(noteText(run.notes), /could not clone/i, `${where}: the message is not a clone failure`);
			}
		}
	});
}

test("an unresolvable first-kept boundary cancels the real handler instead of sending the window", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { firstKeptId: "missing-boundary", tail: [["live", userMessage("LIVE_TAIL", 5)]] });

	const built = buildNativeInput(model, fixture);
	assert.equal(built.ok, false, "an unresolvable boundary must not produce a reusable checkpoint input");
	assert.equal(built.reason, "first-kept-entry-not-found");

	const replay = replayPayload(model, { model: model.id, input: [] }, fixture);
	assert.equal(replay.ok, false);
	assert.equal(replay.reason, "first-kept-entry-not-found");
	assert.equal(
		resolveOpaqueNativeCompactionFallbackEntry(fixture.sm.getBranch(), fallbackRuntime(model)),
		undefined,
		"no exit may select the unresolved window",
	);

	const { result, notes, state, captured, providerCalls } = await runCompactHandler(model, fixture);
	assert.deepEqual(result, { cancel: true }, "the handler cancels rather than reusing the unresolved checkpoint");
	assert.equal(providerCalls, 0, "no native request carries the old window");
	assert.equal(captured, undefined);
	assert.equal(state.pendingPiCompactionNativeWindow, undefined, "no window is handed to the Pi fallback");
	assert.match(noteText(notes), /first-kept boundary/i);
	assert.doesNotMatch(noteText(notes), /could not clone/i, "the message must name the invalid boundary, not a clone failure");
});

test("the portable summary request carries a valid window but never an unresolved one", async () => {
	const model = modelNamed("gpt-6-astra");
	const valid = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const validRun = await runCompactHandler(model, valid, { portable: true });
	assert.equal(validRun.fetchBodies.length, 1, "the real portable summary reaches the transport");
	const validBody = JSON.parse(validRun.fetchBodies[0]);
	assert.equal(contains(validBody, "offline-sealed-fixture"), true, "the valid window is injected into the portable request");
	assert.ok(wireItemIndex(validBody, "offline-sealed-fixture") < wireItemIndex(validBody, "SUMMARIZE_ME"), "the window leads the conversation it summarizes");

	const invalid = checkpointFixture(model, { firstKeptId: "missing-boundary", tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const invalidRun = await runCompactHandler(model, invalid, { portable: true });
	assert.equal(invalidRun.fetchBodies.length, 0, "no portable request leaves before the boundary is known");
	assert.equal(
		invalidRun.fetchBodies.every((body) => !contains(body, "offline-sealed-fixture")),
		true,
		"the portable request never carries an unresolved window",
	);
	assert.deepEqual(invalidRun.result, { cancel: true }, "the native attempt still cancels");
	assert.equal(invalidRun.providerCalls, 0, "and sends no native request");
});

test("a failed native attempt hands a valid window to the Pi fallback and the real request consumes it", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const run = await runCompactHandler(model, fixture);
	assert.ok(run.state.pendingPiCompactionNativeWindow, "the failed native attempt stashes the fallback window");

	run.state.developerMessages = { rewritePayload: (payload) => payload };
	const rewritten = await rewriteCodexProviderRequest(summarizationRequest(model), run.ctx, run.state);
	assert.equal(contains(rewritten, "offline-sealed-fixture"), true, "the Pi fallback request carries the previous window");
	assert.equal(run.state.pendingPiCompactionNativeWindow, undefined, "the consumed window is cleared");
});

test("a handler exception clears the pending fallback window instead of leaving it usable", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const pending = pendingWindow(model, fixture.sm, fixture.compactionId, [SEALED_WINDOW_ITEM]);
	const run = await runCompactHandler(model, fixture, { state: fallbackState(pending), failSessionBranch: true });

	assert.deepEqual(run.result, { cancel: true });
	assert.equal(run.state.pendingPiCompactionNativeWindow, undefined, "a failed attempt must not leave a window behind");
	assert.match(noteText(run.notes), /failed unexpectedly/);
});

contextEditTest("absorbed edits stay reusable through the real handler", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["old", userMessage("OLD_MESSAGE", 5)]] });
	fixture.sm.appendContextEdit(fixture.tailIds[0], { content: "EDIT_ALREADY_COMPACTED" });
	absorbCheckpoint(fixture, {
		firstKeptEntryId: fixture.tailIds[0],
		windowItems: [windowMessage("EDIT_ALREADY_COMPACTED")],
		createdAt: 6,
	});
	fixture.sm.appendMessage(userMessage("NEXT_QUESTION", 7));

	const run = await runCompactHandler(model, fixture);
	assert.equal(occurrences(run.captured, "EDIT_ALREADY_COMPACTED"), 1, "the absorbed content is sent once");
	assert.equal(contains(run.captured, "OLD_MESSAGE"), false, "the replaced content does not come back");
	assert.equal(contains(run.captured, "NEXT_QUESTION"), true, "the live tail still follows");
	assert.doesNotMatch(noteText(run.notes), /rebuilds from the visible edited conversation/);
});

contextEditTest("a post-checkpoint kept edit rebuilds the real handler request without the old window", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	fixture.sm.appendContextEdit(fixture.keptId, { content: "LATER_KEPT_TEXT" });

	const run = await runCompactHandler(model, fixture);
	assert.equal(contains(run.captured, "offline-sealed-fixture"), false, "the stale window must not reach the wire");
	assert.equal(contains(run.captured, "LATER_KEPT_TEXT"), true, "the rebuild carries the edited projection");
	assert.equal(contains(run.captured, "LIVE_TAIL"), true);
	assert.equal(run.state.pendingPiCompactionNativeWindow, undefined, "no stale window is offered to the Pi fallback");
	assert.match(noteText(run.notes), /rebuilds from the visible edited conversation/);

	absorbCheckpoint(fixture, {
		firstKeptEntryId: fixture.keptId,
		windowItems: [windowMessage("LATER_KEPT_TEXT")],
		createdAt: 8,
	});
	const recovered = await runCompactHandler(model, fixture);
	assert.equal(occurrences(recovered.captured, "LATER_KEPT_TEXT"), 1, "a checkpoint that absorbed the edit is reusable and sends its window once");
	assert.doesNotMatch(noteText(recovered.notes), /rebuilds from the visible edited conversation/);
});

contextEditTest("a post-checkpoint edit keeps the stale window out of the portable summary", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const control = await runCompactHandler(model, fixture, { portable: true });
	assert.equal(contains(control.fetchBodies[0], "offline-sealed-fixture"), true, "control: a valid checkpoint feeds the portable summary");

	fixture.sm.appendContextEdit(fixture.keptId, { content: "LATER_KEPT_TEXT" });
	const stale = await runCompactHandler(model, fixture, { portable: true });
	assert.equal(
		stale.fetchBodies.every((body) => !contains(body, "offline-sealed-fixture")),
		true,
		"the stale window is not injected into the portable summary either",
	);
});

contextEditTest("a superseded pending window is rejected by the summary request boundary", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointFixture(model, { tail: [["live", userMessage("LIVE_TAIL", 5)]] });
	const pending = pendingWindow(model, fixture.sm, fixture.compactionId, [SEALED_WINDOW_ITEM]);
	const ctx = fallbackContext(model, fixture.sm);
	const state = fallbackState();

	absorbCheckpoint(fixture, {
		firstKeptEntryId: fixture.keptId,
		windowItems: [windowMessage("LATER_KEPT_TEXT")],
		createdAt: 7,
	});
	const outcome = await injectNativeWindowIntoPiCompactionRequest(summarizationRequest(model), ctx, state, pending);
	assert.equal(outcome.status, "rejected");
	assert.equal(outcome.reason, "source-checkpoint-invalid", "a newer checkpoint replaces the pending source");
});
