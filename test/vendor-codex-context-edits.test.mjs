#!/usr/bin/env node
// Real Pi sessions are the projection oracle; built vendor entrypoints must agree with them.
// Checkpoint windows are handmade offline fixtures, never real encrypted conversation data.
import assert from "node:assert/strict";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { normalizeContext } from "@earendil-works/pi-ai";
import { ExtensionRunner, SessionManager, buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { FAKE_API_KEY, captureBody, captureRegistration, captureSession, declaredToolNames, modelNamed } from "./helpers/vendor-codex-provider.mjs";
import { SEALED_WINDOW_ITEM, assistantToolCall, checkpointDetails, systemMessage, tool, toolResult, userMessage } from "./helpers/vendor-codex-sessions.mjs";
import {
	buildNativeCompactionInput, handleCodexSessionBeforeCompact, injectNativeWindowIntoPiCompactionRequest,
	resolveCanonicalCompactionReplay, resolveOpaqueNativeCompactionFallbackEntry,
} from "../vendor/pi-codex-conversion/dist/adapter/compaction/compaction.js";
import { buildNativeReplaySegments } from "../vendor/pi-codex-conversion/dist/adapter/replay/payload-rewrite.js";
import { extractAccountId, resolveCodexWebSocketUrl } from "../vendor/pi-codex-conversion/dist/providers/openai-codex/headers.js";
import { clearCanonicalSessions, recordCanonicalSessionResponse } from "../vendor/pi-codex-conversion/dist/providers/openai-codex/session-continuity.js";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../vendor/pi-codex-conversion/dist/adapter/activation/config-contract.js";
import { rewriteCodexProviderRequest } from "../vendor/pi-codex-conversion/dist/adapter/provider-request.js";

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
	const sm = SessionManager.inMemory("/tmp/offline-context-edits");
	sm.appendMessage(systemMessage("BASE_PROMPT", 0, { toolsAdded: [tool("tool_alpha")] }));
	const preId = sm.appendMessage(userMessage("pre-kept", 1));
	const keptId = sm.appendMessage(userMessage("kept-window", 2));
	const compactionId = sm.appendCompaction("[OpenAI native compaction checkpoint]", retainNone ? null : preId, 100, checkpointDetails(model));
	return { sm, preId, keptId, compactionId, tailIds: tail.map((message) => sm.appendMessage(message)) };
}

function absorbCheckpoint(f, firstKeptEntryId, windowItems) {
	f.compactionId = f.sm.appendCompaction("[OpenAI native compaction checkpoint]", firstKeptEntryId, 100, checkpointDetails(model, windowItems));
}

function buildNativeInput(f) {
	const branchEntries = f.sm.getBranch();
	const index = branchEntries.findIndex(({ id }) => id === f.compactionId);
	assert.ok(index >= 0, "checkpoint must be on the active branch");
	return buildNativeCompactionInput({
		model, branchEntries, allEntries: f.sm.getEntries(), leafId: f.sm.getLeafId(),
		latestNativeCompaction: { ok: true, index, entry: branchEntries[index] },
	});
}

async function replay(f, payload = undefined) {
	return buildNativeReplaySegments({
		model, payload: payload ?? await captureSession(model, f.sm.getEntries(), f.sm.getLeafId()),
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
				messagesToSummarize: [userMessage("SUMMARIZE_ME")], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			},
		}, ctx, state, { getThinkingLevel: () => "off" });
	} finally { fetch.mock.restore(); }
	return { result, notes, state, ctx, captured: capture.bodies[0], providerCalls: capture.calls, fetchBodies };
}

// Each edit kind shares the same host/build/strict-replay oracle, not a mirror of the projection.
for (const [name, edit, present, absent, tail = [userMessage("OLD_MESSAGE", 5), userMessage("LIVE_TAIL", 6)]] of [
	["deletion", (f) => f.sm.appendContextEdit(f.tailIds[0], null), ["LIVE_TAIL"], ["OLD_MESSAGE"]],
	["replacement", (f) => f.sm.appendContextEdit(f.tailIds[0], { content: "NEW_REPLACEMENT" }), ["NEW_REPLACEMENT"], ["OLD_MESSAGE"]],
	["last edit wins", (f) => {
		for (const content of ["FIRST_DRAFT", null, "FINAL_CONTENT"]) f.sm.appendContextEdit(f.tailIds[0], content === null ? null : { content });
	}, ["FINAL_CONTENT"], ["OLD_MESSAGE", "FIRST_DRAFT"]],
	["custom-message replacement", (f) => {
		const id = f.sm.appendCustomMessageEntry("offline-custom", "CUSTOM_ORIGINAL", true);
		f.sm.appendContextEdit(id, { content: "CUSTOM_REPLACEMENT" });
	}, ["CUSTOM_REPLACEMENT"], ["CUSTOM_ORIGINAL"]],
	["system sections beside a deletion", (f) => {
		f.sm.appendMessage(systemMessage("UPDATE_TEXT", 7, { sections: { goal: "NEW_GOAL" } }));
		f.sm.appendContextEdit(f.tailIds[0], null);
	}, ["UPDATE_TEXT", "NEW_GOAL"], ["OLD_MESSAGE"]],
	["slice-leading system sections beside a deletion", (f) => f.sm.appendContextEdit(f.tailIds[1], null),
		["UPDATE_TEXT", "NEW_GOAL", "LIVE_TAIL"], ["OLD_MESSAGE"],
		[systemMessage("UPDATE_TEXT", 5, { sections: { goal: "NEW_GOAL" } }), userMessage("OLD_MESSAGE", 6), userMessage("LIVE_TAIL", 7)]],
]) {
	contextEditTest(`${name} agrees with the host, rebuilt input and strict replay`, async () => {
		const f = checkpointFixture({ tail });
		edit(f);
		const { built, result } = await reused(f);
		assert.ok(result.segments.postCompactionTail.messages.length > 0, "use strict replay, not the lenient host-input fallback");
		for (const value of [hostMessages(f), built.input, result.rewrittenPayload]) assertContent(value, present, absent);
		assert.deepEqual(declaredToolNames(result.rewrittenPayload), ["tool_alpha"]);
	});
}

contextEditTest("an edited tool result retains its call pairing on build and strict replay", async () => {
	const f = checkpointFixture({ tail: [assistantToolCall(model, "call_1", "tool_alpha"), toolResult("call_1", "tool_alpha", "OLD_RESULT")] });
	f.sm.appendContextEdit(f.tailIds[1], { content: "REPLACED_RESULT" });
	const { built, result } = await reused(f);
	assert.ok(result.segments.postCompactionTail.messages.length > 0);
	for (const input of [built.input, result.rewrittenPayload.input]) {
		assertContent(input, ["REPLACED_RESULT"], ["OLD_RESULT"]);
		assert.equal(input.find(({ type }) => type === "function_call").call_id, "call_1");
		assert.equal(input.find(({ type }) => type === "function_call_output").call_id, "call_1");
	}
});

contextEditTest("context-handler filtering preserves prompt/tools and is not undone by replay", async () => {
	const f = checkpointFixture({ tail: [userMessage("FILTERED_MESSAGE", 5), userMessage("LIVE_TAIL", 6)] });
	const messages = hostMessages(f);
	assert.equal(messages[0].role, "system");
	const extension = {
		path: "/tmp/offline-context-handler.ts", resolvedPath: "/tmp/offline-context-handler.ts", sourceInfo: {},
		handlers: new Map([["context", [({ messages }) => ({ messages: messages.filter((message) => !wire(message).includes("FILTERED_MESSAGE")) })]]]),
		tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
	};
	const runtime = new Proxy({ getThinkingLevel: () => "medium" }, { get: (target, property) => target[property] ?? (() => undefined) });
	const filtered = await new ExtensionRunner([extension], runtime, "/tmp/offline-session", f.sm, {}).emitContext(messages);
	assert.deepEqual(filtered[0], messages[0]);
	assertContent(filtered, ["LIVE_TAIL"], ["FILTERED_MESSAGE"]);
	const result = await replay(f, await captureBody(model, normalizeContext({ messages: convertToLlm(filtered) })));
	assert.equal(result.ok, true, result.reason);
	assertContent(result.rewrittenPayload, ["LIVE_TAIL"], ["FILTERED_MESSAGE"]);
	assert.equal(result.rewrittenPayload.instructions, "BASE_PROMPT");
	assert.deepEqual(declaredToolNames(result.rewrittenPayload), ["tool_alpha"]);
});

contextEditTest("missing, stale and refreshed canonical baselines respect tail and kept-window edits", async (t) => {
	for (const target of ["tail", "kept"]) {
		const f = checkpointFixture({ tail: [userMessage("OLD_MESSAGE", 5)] });
		const sessionId = f.sm.getSessionId();
		t.after(() => clearCanonicalSessions(sessionId));
		const before = buildNativeInput(f);
		assert.equal(before.checkpointReused, true);
		f.sm.appendContextEdit(target === "tail" ? f.tailIds[0] : f.keptId, { content: "NEW_REPLACEMENT" });
		const after = buildNativeInput(f);
		assert.equal(after.ok, true, after.reason);
		assert.equal(after.checkpointReused, target === "tail");
		const replaced = target === "tail" ? "OLD_MESSAGE" : "kept-window";
		assertContent(after.input, ["NEW_REPLACEMENT"], [replaced]);
		const resolve = () => resolveCanonicalCompactionReplay({ codeMode: false, sessionId, model: model.id, identity, reconstructedInput: after.input });
		const record = (input) => recordCanonicalSessionResponse({ sessionId, ...identity, requestBody: { model: model.id, input }, responseItems: [] });
		const missing = await resolve();
		assert.equal(missing.decision, "no_state");
		assert.equal(missing.input, undefined);
		record(before.input);
		const stale = await resolve();
		assert.notEqual(stale.decision, "validated");
		assert.equal(stale.input, undefined, "canonical history cannot revive an edited entry or opaque window");
		clearCanonicalSessions(sessionId);
		record(after.input);
		const validated = await resolve();
		assert.equal(validated.decision, "validated");
		assertContent(validated.input, ["NEW_REPLACEMENT"], [replaced]);
	}
});

contextEditTest("absorbed edit chains are sent once, but a later edit still invalidates the window", async (t) => {
	const f = checkpointFixture({ tail: [userMessage("OLD_MESSAGE", 5)] });
	for (const content of ["FIRST_DRAFT", "ABSORBED_FINAL"]) f.sm.appendContextEdit(f.tailIds[0], { content });
	absorbCheckpoint(f, f.tailIds[0], [windowMessage("ABSORBED_FINAL")]);
	f.sm.appendMessage(userMessage("NEXT_QUESTION", 7));
	const { built, result } = await reused(f);
	assert.ok(result.segments.postCompactionTail.messages.length > 0);
	const run = await runCompactHandler(t, f);
	for (const value of [hostMessages(f), built.input, result.rewrittenPayload, run.captured]) {
		assertOnce(value, "ABSORBED_FINAL");
		assertContent(value, ["NEXT_QUESTION"], ["OLD_MESSAGE", "FIRST_DRAFT"]);
	}
	assert.doesNotMatch(noteText(run), /rebuilds from the visible edited conversation/);
	f.sm.appendContextEdit(f.tailIds[0], null);
	f.sm.appendContextEdit(f.tailIds[0], { content: "LATER_FINAL" });
	const invalidated = buildNativeInput(f);
	assert.equal(invalidated.checkpointReused, false);
	assertContent(invalidated.input, ["LATER_FINAL"], ["ABSORBED_FINAL"]);
	assert.deepEqual(await replay(f), { ok: false, reason: "context-edit-targets-compacted-content" });
	assert.equal(resolveOpaqueNativeCompactionFallbackEntry(f.sm.getBranch(), runtime), undefined);
});

contextEditTest("an absorbed omission never resurrects the deleted or retained message", async () => {
	const f = checkpointFixture({ tail: [userMessage("OLD_MESSAGE", 5), userMessage("LIVE_TAIL", 6)] });
	f.sm.appendContextEdit(f.tailIds[0], null);
	absorbCheckpoint(f, f.tailIds[1], [windowMessage("WINDOW_AFTER_OMISSION")]);
	const { built, result } = await reused(f);
	assertContent(built.input, ["WINDOW_AFTER_OMISSION"], ["OLD_MESSAGE"]);
	assertContent(result.rewrittenPayload, ["WINDOW_AFTER_OMISSION"], ["OLD_MESSAGE", "LIVE_TAIL"]);
});

contextEditTest("kept edits block every stale-window exit; a rebuilt checkpoint restores replay and compaction", async (t) => {
	for (const target of ["preId", "keptId"]) {
		const f = checkpointFixture();
		assert.ok(resolveOpaqueNativeCompactionFallbackEntry(f.sm.getBranch(), runtime));
		const control = await runCompactHandler(t, f, { portable: true });
		assertContent(control.fetchBodies[0], ["offline-sealed-fixture"]);
		f.sm.appendContextEdit(f[target], { content: "REBUILT_TEXT" });
		const rebuilt = buildNativeInput(f);
		assert.equal(rebuilt.checkpointReused, false);
		const replaced = target === "preId" ? "pre-kept" : "kept-window";
		assertContent(rebuilt.input, ["REBUILT_TEXT", "LIVE_TAIL"], [replaced, "offline-sealed-fixture"]);
		assert.deepEqual(await replay(f), { ok: false, reason: "context-edit-targets-compacted-content" });
		assert.equal(resolveOpaqueNativeCompactionFallbackEntry(f.sm.getBranch(), runtime), undefined);
		const stale = await runCompactHandler(t, f, { portable: true });
		assertContent(stale.captured, ["REBUILT_TEXT", "LIVE_TAIL"], ["offline-sealed-fixture"]);
		assert.equal(stale.fetchBodies.length, 1);
		assertContent(stale.fetchBodies, [], ["offline-sealed-fixture"]);
		assert.equal(stale.state.pendingPiCompactionNativeWindow, undefined);
		assert.match(noteText(stale), /rebuilds from the visible edited conversation/);
		absorbCheckpoint(f, f[target], [windowMessage("REBUILT_TEXT")]);
		const windowOnly = await runCompactHandler(t, f);
		assertOnce(windowOnly.captured, "REBUILT_TEXT");
		assert.doesNotMatch(noteText(windowOnly), /rebuilds from the visible edited conversation/);
		f.sm.appendMessage(userMessage("NEXT_QUESTION", 7));
		const { built, result } = await reused(f);
		const recovered = await runCompactHandler(t, f);
		for (const value of [built.input, result.rewrittenPayload, recovered.captured]) {
			assertOnce(value, "REBUILT_TEXT");
			assertContent(value, ["NEXT_QUESTION"], [replaced]);
		}
		assert.doesNotMatch(noteText(recovered), /rebuilds from the visible edited conversation/);
		f.sm.appendMessage(userMessage("ANOTHER_QUESTION", 8));
		assertContent((await reused(f)).result.rewrittenPayload, ["ANOTHER_QUESTION"]);
	}
});

contextEditTest("a third checkpoint ignores the older checkpoint inside its kept range", async () => {
	const f = checkpointFixture({ tail: [userMessage("OLD_MESSAGE", 5), userMessage("LIVE_TAIL", 6)] });
	f.sm.appendContextEdit(f.tailIds[1], { content: "LIVE_EDITED" });
	absorbCheckpoint(f, f.tailIds[0], [windowMessage("WINDOW_SECOND")]);
	assert.equal(buildNativeInput(f).checkpointReused, true);
	f.sm.appendMessage(userMessage("AFTER_SECOND", 7));
	absorbCheckpoint(f, f.tailIds[1], [windowMessage("LIVE_EDITED"), windowMessage("WINDOW_THIRD")]);
	const { result } = await reused(f);
	assertOnce(result.rewrittenPayload, "LIVE_EDITED");
	assertOnce(result.rewrittenPayload, "WINDOW_THIRD");
	assertContent(result.rewrittenPayload, [], ["WINDOW_SECOND"]);
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
			if (portable) assertOrder(run.fetchBodies[0].input, "offline-sealed-fixture", "SUMMARIZE_ME");
			run.state.developerMessages = { rewritePayload: (payload) => payload };
			assertContent(await rewriteCodexProviderRequest(summaryRequest(), run.ctx, run.state), ["offline-sealed-fixture"]);
			assert.equal(run.state.pendingPiCompactionNativeWindow, undefined, "final summary consumes the fallback window");
		}
	});
}

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
