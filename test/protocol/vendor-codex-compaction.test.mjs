// One real session drives serializer, checkpoint replay and final compaction requests.
// Transcript owns declaration rules; these contracts preserve them across compaction boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { disableNetwork, FAKE_API_KEY, captureRegistration, captureSession, declaredToolNames, inPlaceToolItems, kindsOf, modelNamed } from "../helpers/vendor-codex-provider.mjs";
import { SEALED_WINDOW_ITEM, assistantToolCall, checkpointSession, latestCheckpointFor, session, systemMessage, tool, toolResult, userMessage } from "../helpers/vendor-codex-sessions.mjs";
import { buildNativeReplaySegments } from "../../vendor/pi-codex-conversion/dist/adapter/replay/payload-rewrite.js";
import { buildNativeCompactionInput, resolveCanonicalCompactionReplay } from "../../vendor/pi-codex-conversion/dist/adapter/compaction/compaction.js";
import { executeRemoteCompactionV2 } from "../../vendor/pi-codex-conversion/dist/adapter/compaction/remote-v2-client.js";
import { extractAccountId, resolveCodexWebSocketUrl } from "../../vendor/pi-codex-conversion/dist/providers/openai-codex/headers.js";
import { canonicalCompactionRequestBody, clearCanonicalSessions, recordCanonicalSessionResponse } from "../../vendor/pi-codex-conversion/dist/providers/openai-codex/session-continuity.js";

test.beforeEach(disableNetwork);

const itemsContaining = (items, needle) => items.filter((item) => JSON.stringify(item).includes(needle));
const declarationNames = (body) => [
	...declaredToolNames(body), ...inPlaceToolItems(body.input).flatMap((item) => declaredToolNames(item)),
];
const additive = systemMessage("", 2, { toolsAdded: [tool("tool_beta")] });
const conversation = (delta) => [userMessage("first turn"), delta, userMessage("last turn", 3)];
const trigger = { type: "compaction_trigger" };

async function compactionRequest(t, model, fixture, { canonical, systemPrompt = "BASE_PROMPT" } = {}) {
	const sessionId = fixture.sm.getSessionId();
	t.after(() => clearCanonicalSessions(sessionId));
	const built = buildNativeCompactionInput({
		model, branchEntries: fixture.sm.getBranch(), allEntries: fixture.sm.getEntries(), leafId: fixture.sm.getLeafId(),
		latestNativeCompaction: fixture.compactionId ? latestCheckpointFor(fixture.sm.getBranch(), fixture.sm.getEntry(fixture.compactionId)) : { ok: false, reason: "no-compaction" },
	});
	assert.equal(built.ok, true, built.reason);
	const identity = { url: resolveCodexWebSocketUrl(model.baseUrl), accountId: extractAccountId(FAKE_API_KEY) };
	if (canonical) recordCanonicalSessionResponse({ sessionId, ...identity, requestBody: canonical(built.input), responseItems: [] });
	const canonicalReplay = await resolveCanonicalCompactionReplay({ codeMode: false, sessionId, model: model.id, identity, reconstructedInput: built.input });
	const canonicalInput = canonicalReplay.input?.every((item) => !!item && typeof item === "object") ? canonicalReplay.input : undefined;
	const capture = await captureRegistration();
	await executeRemoteCompactionV2({
		runtime: {
			provider: model.provider, api: model.api, model: model.id, currentModel: model,
			baseUrl: model.baseUrl, apiKey: FAKE_API_KEY, headers: {}, codexTransport: true,
		},
		modelRegistry: { getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => capture.registration },
		systemPrompt, history: built, canonicalInput, requestOptions: {}, tokensBefore: 10, sessionId, transport: "sse",
	});
	assert.equal(capture.calls, 1);
	assert.equal(capture.bodies.length, 1, "the adapter's final payload hook must run before transport");
	assert.equal(capture.bodies[0].input.filter(({ type }) => type === "compaction_trigger").length, 1);
	return { finalBody: capture.bodies[0], built, canonicalReplay, identity, sessionId };
}

async function replaySession(t, model, fixture) {
	const payload = await captureSession(model, fixture.sm);
	const result = buildNativeReplaySegments({ model, payload, branchEntries: fixture.sm.getBranch(), compactionEntry: fixture.sm.getEntry(fixture.compactionId) });
	assert.equal(result.ok, true, `${result.reason}: ${result.parity?.mismatches.join("; ")}`);
	const { rewrittenPayload: rewritten } = result;
	assert.equal(rewritten.instructions, payload.instructions);
	assert.deepEqual(declaredToolNames(rewritten), declaredToolNames(payload));
	assert.deepEqual(rewritten.input[0], SEALED_WINDOW_ITEM);
	const { finalBody } = await compactionRequest(t, model, fixture);
	assert.deepEqual(finalBody.tools, payload.tools, "final compaction retains the current tool table");
	assert.deepEqual(finalBody.input, [...rewritten.input, trigger], "final request retains replay order and appends one trigger");
	assert.equal(itemsContaining(finalBody.input, "offline-sealed-fixture").length, 1);
	return { payload, rewritten };
}

test("fresh compaction sends the current prompt, tools and complete visible history", async (t) => {
	const model = modelNamed("gpt-5.3-codex-spark");
	const update = systemMessage("UPDATE_TEXT", 2, { sections: { goal: "NEW_GOAL" }, toolsAdded: [tool("tool_beta")] });
	const fixture = session({ messages: conversation(update) });
	const { finalBody } = await compactionRequest(t, model, fixture, { systemPrompt: "BASE_PROMPT\n\nUPDATE_TEXT\n\nNEW_GOAL" });
	assert.equal(finalBody.instructions, "BASE_PROMPT\n\nUPDATE_TEXT\n\nNEW_GOAL");
	assert.deepEqual(declaredToolNames(finalBody), ["tool_alpha", "tool_beta"]);
	assert.deepEqual(finalBody.input, [
		{ role: "user", content: [{ type: "input_text", text: "first turn" }] },
		{ role: "user", content: [{ type: "input_text", text: "last turn" }] },
		trigger,
	]);
});

test("native replay keeps absent, middle and slice-head updates in their exact position", async (t) => {
	const model = modelNamed("gpt-6-astra");
	const update = systemMessage("UPDATE_TEXT", 6, { sections: { goal: "NEW_GOAL" } });
	for (const [tail, kinds] of [
		[[userMessage("before", 5), userMessage("after", 7)], ["message:user", "message:user"]],
		[[userMessage("before", 5), update, userMessage("after", 7)], ["message:user", "message:developer", "message:user"]],
		[[update, userMessage("after", 7)], ["message:developer", "message:user"]],
	]) {
		const fixture = checkpointSession({ model, tail });
		const { rewritten } = await replaySession(t, model, fixture);
		assert.equal(rewritten.instructions, "BASE_PROMPT");
		assert.deepEqual(kindsOf(rewritten.input), ["compaction_summary", ...kinds]);
		assert.equal(itemsContaining(rewritten.input, "offline-sealed-fixture").length, 1);
		assert.equal(itemsContaining(rewritten.input, "UPDATE_TEXT").length, tail.includes(update) ? 1 : 0);
		assert.equal(itemsContaining(rewritten.input, "BASE_PROMPT").length, 0, "slice heads are updates, not leading prompts");
	}
});

test("additional_tools and tool_search replay declarations and matched call/output pairs", async (t) => {
	for (const id of ["gpt-6-astra", "gpt-5.5"]) {
		const model = modelNamed(id);
		const fixture = checkpointSession({ model, tail: [
			userMessage("tail-before", 5), systemMessage("", 6, { toolsAdded: [tool("tool_beta")] }),
			assistantToolCall(model, "call_beta", "tool_beta"), toolResult("call_beta", "tool_beta", "beta done", 8),
			userMessage("tail-after", 9),
		] });
		const { rewritten } = await replaySession(t, model, fixture);
		const declarations = id === "gpt-6-astra" ? ["additional_tools"] : ["tool_search_call", "tool_search_output"];
		assert.deepEqual(kindsOf(rewritten.input), [
			"compaction_summary", "message:user", ...declarations, "function_call", "function_call_output", "message:user",
		]);
		assert.equal(rewritten.input.find(({ type }) => type === "function_call").call_id, "call_beta");
		assert.equal(rewritten.input.find(({ type }) => type === "function_call_output").call_id, "call_beta");
		assert.equal(itemsContaining(rewritten.input, "call_beta").length, 2);
	}
});

test("non-additive checkpoint history declares the current set and folds kept system deltas", async (t) => {
	const model = modelNamed("gpt-6-astra");
	const removeAlpha = systemMessage("", 6, { toolsRemoved: [{ name: "tool_alpha" }] });
	const checkpointTools = (...tools) => systemMessage("BASE_PROMPT", 4, { toolsAdded: tools });
	for (const { kept, checkpointSystemMessage, delta, expected } of [
		{
			checkpointSystemMessage: checkpointTools(tool("tool_beta", "OLD_BETA_DESCRIPTION")),
			delta: systemMessage("", 6, { toolsAdded: [tool("tool_beta", "NEW_BETA_DESCRIPTION")] }), expected: ["tool_beta"],
		},
		{
			kept: [systemMessage("", 2, { toolsAdded: [tool("tool_beta")] })],
			checkpointSystemMessage: checkpointTools(tool("tool_alpha"), tool("tool_beta")), delta: removeAlpha, expected: ["tool_beta"],
		},
		{
			kept: [systemMessage("KEPT_DELTA_TEXT", 2, { toolsAdded: [tool("tool_beta")] })],
			checkpointSystemMessage: checkpointTools(tool("tool_alpha"), tool("tool_beta")), expected: ["tool_alpha", "tool_beta"],
		},
	]) {
		const fixture = checkpointSession({ model, kept, checkpointSystemMessage, tail: [
			userMessage("tail-before", 5), ...(delta ? [delta] : []), userMessage("tail-after", 7),
		] });
		const { payload, rewritten } = await replaySession(t, model, fixture);
		for (const body of [payload, rewritten]) {
			assert.deepEqual(declaredToolNames(body), expected);
			assert.deepEqual(inPlaceToolItems(body.input), []);
			assert.equal(itemsContaining(body.input, "KEPT_DELTA_TEXT").length, 0);
			if (delta?.toolsAdded) assert.equal(body.tools[0].description, "NEW_BETA_DESCRIPTION");
		}
	}
});

test("only a validated canonical baseline owns the final prompt, tools and prefix; neither path mutates it", async (t) => {
	const model = modelNamed("gpt-6-astra");
	const canonicalTool = tool("canonical_only");
	const fixture = session({ messages: conversation(additive) });
	for (const matches of [true, false]) {
		const { finalBody, built, canonicalReplay, identity, sessionId } = await compactionRequest(t, model, fixture, { canonical: (input) => ({
			model: model.id, instructions: "CANONICAL_PROMPT", tools: [canonicalTool],
			input: matches ? input : [{ role: "user", content: [{ type: "input_text", text: "older canonical history" }] }],
		}) });
		assert.equal(canonicalReplay.decision === "validated", matches);
		assert.deepEqual(finalBody.input, [...built.input, trigger]);
		if (matches) {
			assert.equal(finalBody.instructions, "CANONICAL_PROMPT");
			assert.deepEqual(finalBody.tools, [canonicalTool]);
			assert.equal(JSON.stringify(finalBody).includes("tool_beta"), true);
		} else {
			assert.deepEqual(declaredToolNames(finalBody), ["tool_alpha"]);
			assert.deepEqual(declarationNames(finalBody), ["tool_alpha", "tool_beta"]);
			assert.equal(finalBody.instructions, "BASE_PROMPT");
			assert.equal(JSON.stringify(finalBody).includes("canonical_only"), false);
		}
		const stored = canonicalCompactionRequestBody(sessionId, model.id, identity);
		assert.deepEqual(stored.tools, [canonicalTool]);
		assert.equal(stored.instructions, "CANONICAL_PROMPT");
	}
});
