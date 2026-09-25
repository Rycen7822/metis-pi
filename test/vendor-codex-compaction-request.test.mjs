#!/usr/bin/env node
// Capture the final body after executeRemoteCompactionV2 and the registered provider's own hook.
// The tool table and in-place additions must come from one transcript placement decision.
import assert from "node:assert/strict";
import test from "node:test";
import { FAKE_API_KEY, captureRegistration, captureSession, declaredToolNames, inPlaceToolItems, kindsOf, modelNamed } from "./helpers/vendor-codex-provider.mjs";
import { SEALED_WINDOW_ITEM, checkpointSession, latestCheckpointFor, session, systemMessage, tool, userMessage } from "./helpers/vendor-codex-sessions.mjs";
import { buildNativeCompactionInput, resolveCanonicalCompactionReplay } from "../vendor/pi-codex-conversion/dist/adapter/compaction/compaction.js";
import { executeRemoteCompactionV2 } from "../vendor/pi-codex-conversion/dist/adapter/compaction/remote-v2-client.js";
import { extractAccountId, resolveCodexWebSocketUrl } from "../vendor/pi-codex-conversion/dist/providers/openai-codex/headers.js";
import { canonicalCompactionRequestBody, clearCanonicalSessions, recordCanonicalSessionResponse } from "../vendor/pi-codex-conversion/dist/providers/openai-codex/session-continuity.js";

const declarationNames = (body) => [
	...declaredToolNames(body), ...inPlaceToolItems(body.input).flatMap((item) => declaredToolNames(item)),
];
const additive = systemMessage("", 2, { toolsAdded: [tool("tool_beta")] });
const conversation = (delta) => [userMessage("first turn"), delta, userMessage("last turn", 3)];
const trigger = { type: "compaction_trigger" };

async function compactionRequest(t, model, fixture, canonical) {
	const sessionId = t.name;
	t.after(() => clearCanonicalSessions(sessionId));
	const built = buildNativeCompactionInput({
		model, branchEntries: fixture.entries, allEntries: fixture.entries, leafId: fixture.leafId,
		latestNativeCompaction: fixture.compaction ? latestCheckpointFor(fixture.entries, fixture.compaction) : { ok: false, reason: "no-compaction" },
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
		systemPrompt: "BASE_PROMPT", history: built, canonicalInput, requestOptions: {}, tokensBefore: 10, sessionId, transport: "sse",
	});
	assert.equal(capture.calls, 1);
	assert.equal(capture.bodies.length, 1, "the adapter's final payload hook must run before transport");
	return { finalBody: capture.bodies[0], built, canonicalReplay, identity, sessionId };
}

for (const modelId of ["gpt-6-astra", "gpt-5.5"]) {
	test(`${modelId}: fresh compaction declares tools once and replays updates plus one trigger`, async (t) => {
		const model = modelNamed(modelId);
		for (const [delta, expected] of [
			[additive, ["tool_alpha", "tool_beta"]],
			[systemMessage("UPDATE_TEXT", 2, { sections: { goal: "NEW_GOAL" } }), ["tool_alpha"]],
		]) {
			const fixture = session({ messages: conversation(delta) });
			const normal = await captureSession(model, fixture.entries, fixture.leafId);
			const { finalBody } = await compactionRequest(t, model, fixture);
			assert.deepEqual(declaredToolNames(normal), ["tool_alpha"]);
			assert.deepEqual(finalBody.tools, normal.tools);
			assert.deepEqual(declarationNames(finalBody), expected);
			assert.equal(finalBody.instructions, "BASE_PROMPT");
			assert.deepEqual(finalBody.input, [...normal.input, trigger]);
			assert.equal(finalBody.input.filter(({ type }) => type === "compaction_trigger").length, 1);
			const additions = inPlaceToolItems(finalBody.input);
			if (delta !== additive) {
				assert.deepEqual(additions, []);
				assert.equal(JSON.stringify(finalBody.input).split("UPDATE_TEXT").length - 1, 1);
				continue;
			}
			assert.deepEqual(kindsOf(additions), modelId === "gpt-6-astra" ? ["additional_tools"] : ["tool_search_call", "tool_search_output"]);
			assert.deepEqual(declaredToolNames(additions.at(-1)), ["tool_beta"]);
			assert.deepEqual(additions.at(-1).tools[0].parameters, tool("tool_beta").parameters);
			if (modelId === "gpt-5.5") {
				assert.equal(additions[0].call_id, additions[1].call_id);
				assert.equal(additions[1].tools[0].defer_loading, true);
			}
		}
	});
}

test("checkpoint requests reuse the window with additive or replacement tool placement", async (t) => {
	const model = modelNamed("gpt-6-astra");
	// Pi emits removal + addition when a definition changes; that is not an additive delta.
	const replacement = systemMessage("", 6, {
		toolsRemoved: [{ name: "tool_alpha" }], toolsAdded: [tool("tool_alpha", "REPLACED_ALPHA_DESCRIPTION")],
	});
	for (const delta of [additive, replacement]) {
		const fixture = checkpointSession({ model, tail: conversation(delta) });
		const normal = await captureSession(model, fixture.entries, fixture.leafId);
		const { finalBody } = await compactionRequest(t, model, fixture);
		assert.deepEqual(finalBody.tools, normal.tools);
		assert.deepEqual(declaredToolNames(finalBody), ["tool_alpha"]);
		assert.deepEqual(finalBody.input, [SEALED_WINDOW_ITEM, ...normal.input.slice(2), trigger]);
		assert.equal(JSON.stringify(finalBody.input).split("offline-sealed-fixture").length - 1, 1);
		assert.equal(finalBody.input.filter(({ type }) => type === "compaction_trigger").length, 1);
		if (delta === additive) {
			assert.deepEqual(declarationNames(finalBody), ["tool_alpha", "tool_beta"]);
			assert.deepEqual(kindsOf(finalBody.input), ["compaction_summary", "message:user", "additional_tools", "message:user", "compaction_trigger"]);
		} else {
			assert.deepEqual(declarationNames(finalBody), ["tool_alpha"]);
			assert.equal(finalBody.tools[0].description, "REPLACED_ALPHA_DESCRIPTION");
			assert.deepEqual(inPlaceToolItems(finalBody.input), []);
			assert.equal(JSON.stringify(finalBody).includes("tool_alpha description"), false);
			assert.deepEqual(kindsOf(finalBody.input), ["compaction_summary", "message:user", "message:user", "compaction_trigger"]);
		}
	}
});

test("only a validated canonical baseline owns the final prompt, tools and prefix; neither path mutates it", async (t) => {
	const model = modelNamed("gpt-6-astra");
	const canonicalTool = tool("canonical_only");
	const fixture = session({ messages: conversation(additive) });
	for (const matches of [true, false]) {
		const { finalBody, built, canonicalReplay, identity, sessionId } = await compactionRequest(t, model, fixture, (input) => ({
			model: model.id, instructions: "CANONICAL_PROMPT", tools: [canonicalTool],
			input: matches ? input : [{ role: "user", content: [{ type: "input_text", text: "older canonical history" }] }],
		}));
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
