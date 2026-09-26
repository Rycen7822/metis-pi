#!/usr/bin/env node
// Real Pi sessions are the projection oracle; built vendor entrypoints must agree with them.
// Checkpoint windows are handmade offline fixtures, never real encrypted conversation data.
import assert from "node:assert/strict";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { normalizeContext } from "@earendil-works/pi-ai";
import { SessionManager, buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { disableNetwork, FAKE_API_KEY, captureBody, captureRegistration, captureSession, declaredToolNames, modelNamed } from "../helpers/vendor-codex-provider.mjs";
import { SEALED_WINDOW_ITEM, assistantToolCall, checkpointDetails, checkpointSession, latestCheckpointFor, systemMessage, tool, toolResult, userMessage } from "../helpers/vendor-codex-sessions.mjs";
import {
	buildNativeCompactionInput, handleCodexSessionBeforeCompact, injectNativeWindowIntoPiCompactionRequest,
	resolveCanonicalCompactionReplay, resolveOpaqueNativeCompactionFallbackEntry,
} from "../../vendor/pi-codex-conversion/dist/adapter/compaction/compaction.js";
import { buildNativeReplaySegments } from "../../vendor/pi-codex-conversion/dist/adapter/replay/payload-rewrite.js";
import { extractAccountId, resolveCodexWebSocketUrl } from "../../vendor/pi-codex-conversion/dist/providers/openai-codex/headers.js";
import { clearCanonicalSessions, recordCanonicalSessionResponse } from "../../vendor/pi-codex-conversion/dist/providers/openai-codex/session-continuity.js";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../../vendor/pi-codex-conversion/dist/adapter/activation/config-contract.js";
import { CodexDeveloperMessageBridge } from "../../vendor/pi-codex-conversion/dist/adapter/developer-messages.js";
import { resolveCodexRuntimePlanForState } from "../../vendor/pi-codex-conversion/dist/adapter/activation/runtime-plan.js";
import { rewriteCodexProviderRequest, rewriteCodexPrewarmProviderRequest } from "../../vendor/pi-codex-conversion/dist/adapter/provider-request.js";

test.beforeEach(disableNetwork);

const model = modelNamed("gpt-6-astra");
const runtime = { provider: model.provider, api: model.api, baseUrl: model.baseUrl.replace(/\/+$/, "") };
const identity = { url: resolveCodexWebSocketUrl(model.baseUrl), accountId: extractAccountId(FAKE_API_KEY) };
const supportsContextEdits = typeof SessionManager.prototype.appendContextEdit === "function";
const contextEditTest = (name, fn) => test(name, {
	skip: !supportsContextEdits && "Pi < 0.87 has no context_edit entries",
}, fn);
const wire = JSON.stringify;
const windowMessage = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const summaryRequest = () => ({ model: model.id, instructions: "Summarize this conversation", input: [userMessage("VISIBLE_USER_TEXT")] });
const fallbackState = () => ({ config: structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG) });
const hostMessages = (f) => buildSessionContext(f.sm.getEntries(), f.sm.getLeafId()).messages;
const noteText = (run) => run.notes.map(([text]) => text).join("\n");

function checkpointFixture({ tail = [userMessage("LIVE_TAIL", 5)], retainNone = false } = {}) {
	const f = checkpointSession({ model, kept: [userMessage("kept-window", 2)], tail, retainNone });
	return { ...f, keptId: f.keptIds[0] };
}

function absorbCheckpoint(f, firstKeptEntryId, windowItems) {
	f.compactionId = f.sm.appendCompaction("[OpenAI native compaction checkpoint]", firstKeptEntryId, 100, checkpointDetails(model, windowItems));
}

function buildNativeInput(f) {
	const branchEntries = f.sm.getBranch();
	return buildNativeCompactionInput({
		model, branchEntries, allEntries: f.sm.getEntries(), leafId: f.sm.getLeafId(),
		latestNativeCompaction: latestCheckpointFor(branchEntries, f.sm.getEntry(f.compactionId)),
	});
}

async function replay(f, payload = undefined) {
	return buildNativeReplaySegments({
		model, payload: payload ?? await captureSession(model, f.sm),
		branchEntries: f.sm.getBranch(), compactionEntry: f.sm.getEntry(f.compactionId),
	});
}

async function reused(f) {
	const built = buildNativeInput(f);
	assert.equal(built.ok, true, built.reason);
	assert.equal(built.checkpointReused, true);
	const result = await replay(f);
	assert.equal(result.ok, true, result.reason);
	return { built, result };
}

function assertContent(value, present = [], absent = []) {
	const text = wire(value);
	for (const needle of present) assert.ok(text.includes(needle), `missing ${needle}`);
	for (const needle of absent) assert.ok(!text.includes(needle), `resurrected ${needle}`);
}

function assertOnce(value, needle) {
	assert.equal(wire(value).split(needle).length - 1, 1, `${needle} must appear exactly once`);
}

function assertOrder(input, first, second) {
	const index = (needle) => input.findIndex((item) => wire(item).includes(needle));
	assert.ok(index(first) >= 0 && index(first) < index(second), `${first} must precede ${second}`);
}

function fallbackContext(f) {
	return { model, sessionManager: f.sm, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: FAKE_API_KEY, headers: {} }) } };
}

function pendingWindow(f) {
	return { ...runtime, sessionId: f.sm.getSessionId(), sourceCompactionEntryId: f.compactionId, window: [structuredClone(SEALED_WINDOW_ITEM)] };
}

// Capture native requests after the real adapter hook, and portable requests at the compressed
// fetch boundary. Both deliberately fail offline so the production fallback lifecycle still runs.
async function runCompactHandler(t, f, { state = fallbackState(), portable = false } = {}) {
	Object.assign(state.config.compaction, { responsesCompaction: true, portableSummary: portable });
	const capture = await captureRegistration();
	const notes = [];
	const ctx = fallbackContext(f);
	Object.assign(ctx.modelRegistry, {
		getRegisteredProviderConfig: () => undefined,
		getRegisteredNativeProvider: () => capture.registration,
	});
	Object.assign(ctx, { getSystemPrompt: () => "BASE_PROMPT", ui: { notify: (...args) => notes.push(args) }, thinkingLevel: "off" });
	const fetchBodies = [];
	const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
		const raw = init?.body;
		fetchBodies.push(JSON.parse(raw instanceof Uint8Array ? zstdDecompressSync(raw).toString("utf8") : String(raw)));
		throw new Error("OFFLINE_PORTABLE_CAPTURE");
	});
	let result;
	try {
		result = await handleCodexSessionBeforeCompact({
			type: "session_before_compact", signal: new AbortController().signal,
			preparation: {
				firstKeptEntryId: f.sm.getEntry(f.compactionId).firstKeptEntryId,
				messagesToSummarize: hostMessages(f), turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			},
		}, ctx, state, { getThinkingLevel: () => "off" });
	} finally { fetch.mock.restore(); }
	return { result, notes, state, ctx, captured: capture.bodies[0], providerCalls: capture.calls, fetchBodies };
}

contextEditTest("an edited tail preserves every independent change through host projection and strict replay", async () => {
	const f = checkpointFixture({ tail: [
		systemMessage("UPDATE_TEXT", 5, { sections: { goal: "NEW_GOAL" } }),
		userMessage("DELETE_ME"), userMessage("REPLACE_ME"), userMessage("DRAFT_ORIGINAL"),
		assistantToolCall(model, "call_1", "tool_alpha"), toolResult("call_1", "tool_alpha", "OLD_RESULT"), userMessage("LIVE_TAIL"),
	] });
	for (const [index, content] of [[1, null], [2, "NEW_REPLACEMENT"], [3, "FIRST_DRAFT"], [3, null], [3, "FINAL_CONTENT"], [5, "REPLACED_RESULT"]]) {
		f.sm.appendContextEdit(f.tailIds[index], content === null ? null : { content });
	}
	const custom = f.sm.appendCustomMessageEntry("offline-custom", "CUSTOM_ORIGINAL", true);
	f.sm.appendContextEdit(custom, { content: "CUSTOM_REPLACEMENT" });
	const { built, result } = await reused(f);
	assert.ok(result.segments.postCompactionTail.messages.length > 0, "the strict replay path must accept the edited tail");
	for (const value of [hostMessages(f), built.input, result.rewrittenPayload]) {
		assertContent(value, ["UPDATE_TEXT", "NEW_GOAL", "LIVE_TAIL", "NEW_REPLACEMENT", "FINAL_CONTENT", "REPLACED_RESULT", "CUSTOM_REPLACEMENT"],
			["DELETE_ME", "REPLACE_ME", "DRAFT_ORIGINAL", "FIRST_DRAFT", "OLD_RESULT", "CUSTOM_ORIGINAL"]);
	}
	for (const input of [built.input, result.rewrittenPayload.input]) {
		assert.equal(input.find(({ type }) => type === "function_call").call_id, "call_1");
		assert.equal(input.find(({ type }) => type === "function_call_output").call_id, "call_1");
	}
	assert.deepEqual(declaredToolNames(result.rewrittenPayload), ["tool_alpha"]);
});

contextEditTest("replay respects the visible context supplied by host context handlers", async () => {
	const f = checkpointFixture({ tail: [userMessage("FILTERED_MESSAGE", 5), userMessage("LIVE_TAIL", 6)] });
	// Pi owns handler dispatch; the adapter receives this already-filtered context.
	const filtered = hostMessages(f).filter((message) => !wire(message).includes("FILTERED_MESSAGE"));
	const result = await replay(f, await captureBody(model, normalizeContext({ messages: convertToLlm(filtered) })));
	assert.equal(result.ok, true, result.reason);
	assertContent(result.rewrittenPayload, ["LIVE_TAIL"], ["FILTERED_MESSAGE"]);
	assert.equal(result.rewrittenPayload.instructions, "BASE_PROMPT");
	assert.deepEqual(declaredToolNames(result.rewrittenPayload), ["tool_alpha"]);
});

// One trajectory crosses the checkpoint boundary repeatedly. Each target starts on
// a different side; after absorption all become kept content and must invalidate it.
for (const target of ["preId", "keptId", "tail"]) {
	contextEditTest(`${target}: edits invalidate canonical history until a fresh checkpoint absorbs them`, async (t) => {
		const f = checkpointFixture({ tail: [userMessage("OLD_TAIL", 5)] });
		const id = target === "tail" ? f.tailIds[0] : f[target];
		const sessionId = f.sm.getSessionId();
		t.after(() => clearCanonicalSessions(sessionId));
		const record = (input) => recordCanonicalSessionResponse({ sessionId, ...identity, requestBody: { model: model.id, input }, responseItems: [] });
		const resolve = (input) => resolveCanonicalCompactionReplay({ codeMode: false, sessionId, model: model.id, identity, reconstructedInput: input });
		record(buildNativeInput(f).input);
		for (const text of ["FIRST_DRAFT", "EDITED_ONCE"]) f.sm.appendContextEdit(id, { content: text });
		const edited = buildNativeInput(f);
		assert.equal(edited.checkpointReused, target === "tail");
		assertContent(edited.input, ["EDITED_ONCE"], ["FIRST_DRAFT"]);
		const stale = await resolve(edited.input);
		assert.notEqual(stale.decision, "validated");
		assert.equal(stale.input, undefined, "canonical history cannot resurrect the old edit");
		record(edited.input);
		assert.equal((await resolve(edited.input)).decision, "validated");

		// Before each new checkpoint, an edit to kept content blocks replay and both
		// fallback sources. Absorption then restores an exact-once wire prefix.
		for (const text of ["EDITED_ONCE", "EDITED_AGAIN"]) {
			const obsolete = ["FIRST_DRAFT", "offline-sealed-fixture", ...(text === "EDITED_AGAIN" ? ["EDITED_ONCE"] : [])];
			if (text === "EDITED_AGAIN") {
				f.sm.appendContextEdit(id, null);
				f.sm.appendContextEdit(id, { content: text });
			}
			if (target !== "tail" || text === "EDITED_AGAIN") {
				assert.deepEqual(await replay(f), { ok: false, reason: "context-edit-targets-compacted-content" });
				assert.equal(resolveOpaqueNativeCompactionFallbackEntry(f.sm.getBranch(), runtime), undefined);
				const run = await runCompactHandler(t, f, { portable: true });
				assert.equal(run.fetchBodies.length, 1);
				assert.equal(run.state.pendingPiCompactionNativeWindow, undefined);
				for (const body of [run.captured, ...run.fetchBodies]) assertContent(body, [text], obsolete);
				assert.match(noteText(run), /rebuilds from the visible edited conversation/);
			}
			absorbCheckpoint(f, id, [windowMessage(text)]);
			const question = text === "EDITED_ONCE" ? "NEXT_QUESTION" : "LAST_QUESTION";
			f.sm.appendMessage(userMessage(question, 7));
			const { built, result } = await reused(f);
			const run = await runCompactHandler(t, f);
			for (const value of [hostMessages(f), built.input, result.rewrittenPayload, run.captured]) {
				assertOnce(value, text);
				assertContent(value, [question], obsolete);
			}
			assert.doesNotMatch(noteText(run), /rebuilds from the visible edited conversation/);
		}
	});
}

contextEditTest("an absorbed omission never resurrects the deleted or retained message", async () => {
	const f = checkpointFixture({ tail: [userMessage("OLD_MESSAGE", 5), userMessage("LIVE_TAIL", 6)] });
	f.sm.appendContextEdit(f.tailIds[0], null);
	absorbCheckpoint(f, f.tailIds[1], [windowMessage("WINDOW_AFTER_OMISSION")]);
	const { built, result } = await reused(f);
	assertContent(built.input, ["WINDOW_AFTER_OMISSION"], ["OLD_MESSAGE"]);
	assertContent(result.rewrittenPayload, ["WINDOW_AFTER_OMISSION"], ["OLD_MESSAGE", "LIVE_TAIL"]);
});

// null and self-id are retain-none, not missing/undefined/unknown/later boundaries.
// Each shape checks deterministic build/replay and both real handler transport paths.
for (const [shape, change, keptCount] of [
	["missing field", (entry) => { delete entry.firstKeptEntryId; }, undefined],
	["explicit undefined", (entry) => { entry.firstKeptEntryId = undefined; }, undefined],
	["unknown id", (entry) => { entry.firstKeptEntryId = "missing-boundary"; }, undefined],
	["tail id", (entry, f) => { entry.firstKeptEntryId = f.tailIds[0]; }, undefined],
	["legacy null", (entry) => { entry.firstKeptEntryId = null; }, 0],
	["0.87 retain-none", (entry) => {
		if (supportsContextEdits) assert.equal(entry.firstKeptEntryId, entry.id, "0.87 stores its own id for appendCompaction(null)");
		entry.firstKeptEntryId = entry.id; // Also exercise the self-id shape when running on a 0.86 host.
	}, 0],
	["ordinary kept window", (entry, f) => { entry.firstKeptEntryId = f.preId; }, 2],
]) {
	test(`${shape}: build, replay, native and portable compaction share the boundary judgment`, async (t) => {
		const f = checkpointFixture({ retainNone: true, tail: [userMessage("LIVE_TAIL", 5), userMessage("AFTER_TAIL", 6)] });
		change(f.sm.getEntry(f.compactionId), f);
		const accepted = keptCount !== undefined;
		const built = buildNativeInput(f);
		const result = await replay(f, accepted ? undefined : { model: model.id, input: [] });
		assert.equal(built.ok, accepted);
		assert.equal(result.ok, accepted);
		if (accepted) {
			assert.equal(built.checkpointReused, true);
			assertContent(built.input, ["offline-sealed-fixture", "LIVE_TAIL"], ["pre-kept", "kept-window"]);
			assert.deepEqual(result.segments.compactedWindow, [SEALED_WINDOW_ITEM]);
			assert.equal(result.segments.firstKeptEntryIndex, result.segments.boundaryIndex - keptCount);
			assert.equal(result.segments.preCompactionKeptWindow.messages.length, keptCount);
			assert.equal(result.segments.postCompactionTail.messages.length, 2, "strict replay keeps both tail messages");
			assertContent(result.rewrittenPayload, ["LIVE_TAIL", "AFTER_TAIL"]);
		} else {
			assert.equal(built.reason, "first-kept-entry-not-found");
			assert.equal(result.reason, "first-kept-entry-not-found");
			assert.equal(resolveOpaqueNativeCompactionFallbackEntry(f.sm.getBranch(), runtime), undefined);
		}
		for (const portable of [false, true]) {
			const run = await runCompactHandler(t, f, { portable });
			assert.equal(run.providerCalls, accepted ? 1 : 0);
			assert.equal(run.fetchBodies.length, accepted && portable ? 1 : 0);
			if (!accepted) {
				assert.deepEqual(run.result, { cancel: true });
				assert.equal(run.captured, undefined);
				assert.equal(run.state.pendingPiCompactionNativeWindow, undefined);
				assert.match(noteText(run), /first-kept boundary/i);
				assert.doesNotMatch(noteText(run), /could not clone/i);
				continue;
			}
			assert.equal(run.result, undefined, "failed native capture delegates to Pi compaction");
			assertOnce(run.captured, "offline-sealed-fixture");
			assertContent(run.captured, ["LIVE_TAIL", "AFTER_TAIL"], ["pre-kept", "kept-window"]);
			assertOrder(run.captured.input, "offline-sealed-fixture", "LIVE_TAIL");
			assert.doesNotMatch(noteText(run), /rebuilds from the visible edited conversation/);
			assert.equal(run.state.pendingPiCompactionNativeWindow.sourceCompactionEntryId, f.compactionId);
			if (portable) assertOrder(run.fetchBodies[0].input, "offline-sealed-fixture", "LIVE_TAIL");
		}
	});
}

test("a handler's fallback window survives prewarm and ordinary requests until a final summary consumes it", async (t) => {
	const { ctx, state } = await runCompactHandler(t, checkpointFixture());
	const pending = state.pendingPiCompactionNativeWindow;
	assert.deepEqual(pending.window, [SEALED_WINDOW_ITEM]);
	Object.assign(state, {
		developerMessages: new CodexDeveloperMessageBridge(),
		pendingActiveProviderPromptCapture: true, activeProviderSystemPrompt: "BEFORE_CAPTURE",
	});
	const auth = t.mock.method(ctx.modelRegistry, "getApiKeyAndHeaders");
	const payload = summaryRequest();
	for (const nativeCompaction of [false, true]) {
		state.config.compaction.responsesCompaction = nativeCompaction;
		assert.equal(resolveCodexRuntimePlanForState(ctx, state).nativeCompaction, nativeCompaction);
		const prewarm = rewriteCodexPrewarmProviderRequest(payload, ctx, state);
		assert.deepEqual(prewarm.input, payload.input);
		assert.equal(state.pendingPiCompactionNativeWindow, pending);
		assert.equal(state.activeProviderSystemPrompt, "BEFORE_CAPTURE");
		assert.equal(auth.mock.callCount(), 0, "prewarm must not authenticate or replay a checkpoint");
	}
	state.config.compaction.responsesCompaction = false;
	await rewriteCodexProviderRequest({ ...payload, instructions: "Ordinary turn" }, ctx, state);
	assert.equal(state.pendingPiCompactionNativeWindow, pending);
	assert.equal(auth.mock.callCount(), 0);
	const live = await rewriteCodexProviderRequest(payload, ctx, state);
	assert.deepEqual(live.input, [SEALED_WINDOW_ITEM, ...payload.input]);
	assert.equal(state.pendingPiCompactionNativeWindow, undefined);
	assert.equal(state.activeProviderSystemPrompt, "Summarize this conversation");
	assert.equal(auth.mock.callCount(), 1);

	state.pendingPiCompactionNativeWindow = { ...pending, sessionId: "other-session" };
	const rejected = await rewriteCodexProviderRequest(payload, ctx, state);
	assert.equal(state.pendingPiCompactionNativeWindow, undefined, "a rejected summary discards the offered window");
	assert.deepEqual(rejected.input, payload.input);
});

contextEditTest("pending-window injection revalidates ownership, edits and superseding checkpoints", async () => {
	for (const invalidate of [
		(f) => f.sm.appendContextEdit(f.keptId, { content: "LATER_KEPT_TEXT" }),
		(f) => absorbCheckpoint(f, f.keptId, [windowMessage("LATER_KEPT_TEXT")]),
	]) {
		const f = checkpointFixture();
		const pending = pendingWindow(f);
		const ctx = fallbackContext(f);
		const state = fallbackState();
		const inject = (payload, window) => injectNativeWindowIntoPiCompactionRequest(payload, ctx, state, window);
		const injected = await inject(summaryRequest(), pending);
		assert.equal(injected.status, "injected");
		assertContent(injected.payload, ["offline-sealed-fixture"], ["LIVE_TAIL"]);
		assert.deepEqual(await inject({ model: model.id, input: [] }, pending), { status: "not-applicable" });
		assert.deepEqual(await inject(summaryRequest(), undefined), { status: "not-applicable" });
		assert.deepEqual(await inject(summaryRequest(), { ...pending, sessionId: "other-session" }), { status: "rejected", reason: "session-mismatch" });
		invalidate(f);
		assert.deepEqual(await inject(summaryRequest(), pending), { status: "rejected", reason: "source-checkpoint-invalid" });
	}
});

test("a handler exception cancels and clears the pending fallback window", async (t) => {
	const f = checkpointFixture();
	const state = { ...fallbackState(), pendingPiCompactionNativeWindow: pendingWindow(f) };
	t.mock.method(f.sm, "getBranch", () => { throw new Error("OFFLINE_SESSION_FAILURE"); });
	const run = await runCompactHandler(t, f, { state });
	assert.deepEqual(run.result, { cancel: true });
	assert.equal(state.pendingPiCompactionNativeWindow, undefined);
	assert.match(noteText(run), /failed unexpectedly/);
});
