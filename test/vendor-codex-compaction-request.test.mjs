#!/usr/bin/env node
/**
 * Final remote-compaction request regressions for the vendored Codex transport.
 *
 * These tests drive the real pipeline end to end, offline: the built
 * `buildNativeCompactionInput` produces the reconstructed history, the built
 * `executeRemoteCompactionV2` assembles the request, the **actually registered** `openai-codex`
 * provider builds the body, and the adapter's own `onPayload` hook is what gets captured — the
 * capture throws before any transport is opened and `globalThis.fetch` is disabled. The
 * checkpoint window is a handmade offline stand-in, not a real server-side encrypted window.
 *
 * The invariant under test: the final body's top-level `tools` and the in-place additions inside
 * `input` come from one placement decision about one transcript, so every tool is declared
 * exactly once and the replayed history matches the provider's normal request for the same
 * session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { FAKE_API_KEY, captureBody, modelNamed, withFinalPayloadCapture } from "./helpers/vendor-codex-provider.mjs";
import {
	checkpointSession,
	latestCheckpointFor,
	session,
	systemMessage,
	tool,
	userMessage,
} from "./helpers/vendor-codex-sessions.mjs";

const COMPACTION_ENTRY = new URL("../vendor/pi-codex-conversion/dist/adapter/compaction/compaction.js", import.meta.url).href;
const REMOTE_ENTRY = new URL("../vendor/pi-codex-conversion/dist/adapter/compaction/remote-v2-client.js", import.meta.url).href;
const HEADERS_ENTRY = new URL("../vendor/pi-codex-conversion/dist/providers/openai-codex/headers.js", import.meta.url).href;
const CONTINUITY_ENTRY = new URL("../vendor/pi-codex-conversion/dist/providers/openai-codex/session-continuity.js", import.meta.url).href;

const { buildNativeCompactionInput, resolveCanonicalCompactionReplay } = await import(COMPACTION_ENTRY);
const { executeRemoteCompactionV2 } = await import(REMOTE_ENTRY);
const { extractAccountId, resolveCodexWebSocketUrl } = await import(HEADERS_ENTRY);
const { canonicalCompactionRequestBody, clearCanonicalSessions, recordCanonicalSessionResponse } = await import(CONTINUITY_ENTRY);
const IN_PLACE_TYPES = new Set(["additional_tools", "tool_search_call", "tool_search_output"]);
const withTools = (name, model) => ({
	name,
	description: `${name} for ${model}`,
	parameters: { type: "object", properties: { value: { type: "string" } } },
});

const inPlaceItems = (body) => body.input.filter((item) => IN_PLACE_TYPES.has(item.type));
/** Tool names in request order: the top-level declarations followed by the in-place ones. */
const declarationNames = (body) => [
	...(body.tools ?? []).map((declared) => declared.name),
	...inPlaceItems(body).flatMap((item) => (item.tools ?? []).map((declared) => declared.name)),
];
const kindsOf = (items) => items.map((item) => item.type ?? `message:${item.role}`);
const triggers = (body) => body.input.filter((item) => item.type === "compaction_trigger");

/**
 * Run the real remote-compaction pipeline for `session` and capture the final body: the canonical
 * replay decision, the reconstructed history, the provider context and the request assembly are the
 * production ones. `canonical` seeds an in-memory canonical baseline, as if the session had already
 * produced normal requests in this lane.
 */
async function compactionRequest({ model, session: fixture, sessionId, canonical }) {
	const latestNativeCompaction = fixture.compaction
		? latestCheckpointFor(fixture.entries, fixture.compaction)
		: { ok: false, reason: "no-compaction" };
	const built = buildNativeCompactionInput({
		model,
		branchEntries: fixture.entries,
		allEntries: fixture.entries,
		leafId: fixture.leafId,
		latestNativeCompaction,
	});
	assert.equal(built.ok, true, `the reconstructed compaction history must be serializable (${built.reason ?? "?"})`);
	const identity = { url: resolveCodexWebSocketUrl(model.baseUrl), accountId: extractAccountId(FAKE_API_KEY) };
	if (canonical) {
		recordCanonicalSessionResponse({
			sessionId,
			url: identity.url,
			accountId: identity.accountId,
			requestBody: canonical(built.input),
			responseItems: [],
		});
	}
	// Same decision the production caller makes: a validated canonical replay keeps its own body,
	// otherwise the reconstructed history is authoritative.
	const canonicalReplay = await resolveCanonicalCompactionReplay({
		codeMode: false,
		sessionId,
		model: model.id,
		identity,
		reconstructedInput: built.input,
	});
	const canonicalInput = canonicalReplay.input?.every((item) => !!item && typeof item === "object")
		? canonicalReplay.input
		: undefined;
	const finalBody = await withFinalPayloadCapture((registration) => executeRemoteCompactionV2({
		runtime: {
			provider: model.provider,
			api: model.api,
			model: model.id,
			currentModel: model,
			baseUrl: model.baseUrl,
			apiKey: FAKE_API_KEY,
			headers: {},
			codexTransport: true,
		},
		modelRegistry: {
			getRegisteredProviderConfig: () => undefined,
			getRegisteredNativeProvider: () => registration,
		},
		systemPrompt: "BASE_PROMPT",
		history: built,
		...(canonicalInput ? { canonicalInput } : {}),
		requestOptions: {},
		tokensBefore: 10,
		sessionId,
		transport: "sse",
	}));
	return { finalBody, identity, built, canonicalReplay };
}

async function normalPayload(model, fixture) {
	const context = buildSessionContext(fixture.entries, fixture.leafId);
	return captureBody(model, normalizeContext({ messages: convertToLlm(context.messages) }));
}

for (const modelId of ["gpt-6-astra", "gpt-5.5"]) {
	test(`${modelId}: the reconstructed compaction request declares an added tool exactly once`, async () => {
		const model = modelNamed(modelId);
		const fixture = session({
			messages: [
				["first", userMessage("first turn", 1)],
				["add", systemMessage("", 2, { toolsAdded: [tool("tool_beta")] })],
				["last", userMessage("last turn", 3)],
			],
		});
		const normal = await normalPayload(model, fixture);
		const { finalBody } = await compactionRequest({
			model,
			session: fixture,
			sessionId: `wire-additive-${modelId}`,
		});

		assert.equal(normal.tools[0].name, "tool_alpha", "the normal request anchors beta in place");
		assert.deepEqual(
			finalBody.tools,
			normal.tools,
			"the compaction request declares the same top-level tools as the normal request for this session",
		);
		assert.deepEqual(declarationNames(finalBody), ["tool_alpha", "tool_beta"], "each tool is declared exactly once");
		assert.deepEqual(kindsOf(finalBody.input), kindsOf(normal.input).concat("compaction_trigger"), "the replayed history is the normal request plus the trigger");
		assert.deepEqual(finalBody.input, [...normal.input, { type: "compaction_trigger" }]);
		assert.equal(triggers(finalBody).length, 1);
		assert.equal(finalBody.instructions, "BASE_PROMPT");

		if (modelId === "gpt-6-astra") {
			const additions = inPlaceItems(finalBody);
			assert.equal(additions.length, 1, "beta is declared once, not once per code path");
			assert.equal(additions[0].type, "additional_tools");
			assert.deepEqual(additions[0].tools.map((declared) => declared.name), ["tool_beta"]);
			assert.deepEqual(additions[0].tools[0].parameters, tool("tool_beta").parameters, "the announced definition is the active one");
		} else {
			const searchItems = inPlaceItems(finalBody);
			assert.deepEqual(kindsOf(searchItems), ["tool_search_call", "tool_search_output"]);
			const [call, output] = searchItems;
			assert.equal(call.call_id, output.call_id, "the tool_search pair keeps its id");
			assert.deepEqual(output.tools.map((declared) => declared.name), ["tool_beta"]);
			assert.deepEqual(output.tools[0].parameters, tool("tool_beta").parameters, "the announced definition is the active one");
			assert.equal(output.tools[0].defer_loading, true);
		}
	});

	test(`${modelId}: the compaction control keeps a single top-level declaration`, async () => {
		const model = modelNamed(modelId);
		const fixture = session({
			messages: [
				["first", userMessage("first turn", 1)],
				["update", systemMessage("UPDATE_TEXT", 2, { sections: { goal: "NEW_GOAL" } })],
				["last", userMessage("last turn", 3)],
			],
		});
		const normal = await normalPayload(model, fixture);
		const { finalBody } = await compactionRequest({
			model,
			session: fixture,
			sessionId: `wire-control-${modelId}`,
		});

		assert.deepEqual(finalBody.tools, normal.tools, "the control keeps the normal request's top-level tools");
		assert.deepEqual(declarationNames(finalBody), ["tool_alpha"]);
		assert.deepEqual(inPlaceItems(finalBody), [], "nothing is declared in place");
		assert.deepEqual(finalBody.input, [...normal.input, { type: "compaction_trigger" }], "the mid-conversation update is replayed once");
		assert.equal(JSON.stringify(finalBody.input).split("UPDATE_TEXT").length - 1, 1);
		assert.equal(triggers(finalBody).length, 1);
	});
}

test("a checkpoint compaction replays its window and tail with one declaration per tool", async () => {
	const model = modelNamed("gpt-6-astra");
	const fixture = checkpointSession({
		model,
		tail: [
			["tail", userMessage("tail", 5)],
			["add", systemMessage("", 6, { toolsAdded: [tool("tool_beta")] })],
			["last", userMessage("last", 7)],
		],
	});
	const normal = await normalPayload(model, fixture);
	const { finalBody } = await compactionRequest({
		model,
		session: fixture,
		sessionId: "wire-reused-additive",
	});

	assert.deepEqual(finalBody.tools, normal.tools, "the checkpoint request declares the normal request's top-level tools");
	assert.deepEqual(finalBody.tools.map((declared) => declared.name), ["tool_alpha"], "the checkpoint head leads the transcript");
	assert.deepEqual(declarationNames(finalBody), ["tool_alpha", "tool_beta"]);
	assert.deepEqual(kindsOf(finalBody.input), ["compaction_summary", "message:user", "additional_tools", "message:user", "compaction_trigger"]);
	assert.equal(JSON.stringify(finalBody.input).includes("offline-sealed-fixture"), true, "the opaque checkpoint window is replayed");
	assert.equal(JSON.stringify(finalBody.input).split("offline-sealed-fixture").length - 1, 1, "the checkpoint window is not duplicated");
	assert.equal(triggers(finalBody).length, 1);
});

test("a checkpoint compaction with a replacement delta declares only the current definition", async () => {
	const model = modelNamed("gpt-6-astra");
	// Pi's getToolStateChanges emits a removal and an addition when a tool definition changes.
	const replacement = systemMessage("", 6, {
		toolsRemoved: [{ name: "tool_alpha" }],
		toolsAdded: [tool("tool_alpha", "REPLACED_ALPHA_DESCRIPTION")],
	});
	const fixture = checkpointSession({
		model,
		tail: [["tail", userMessage("tail", 5)], ["replace", replacement], ["last", userMessage("last", 7)]],
	});
	const normal = await normalPayload(model, fixture);
	const { finalBody } = await compactionRequest({
		model,
		session: fixture,
		sessionId: "wire-reused-replaced",
	});

	assert.deepEqual(finalBody.tools, normal.tools, "the normal request sends the same complete current set");
	assert.deepEqual(finalBody.tools.map((declared) => declared.name), ["tool_alpha"], "non-additive history sends the complete current set");
	assert.deepEqual(declarationNames(finalBody), ["tool_alpha"], "the replaced tool is declared once");
	assert.equal(finalBody.tools[0].description, "REPLACED_ALPHA_DESCRIPTION", "the latest definition wins");
	assert.deepEqual(inPlaceItems(finalBody), [], "nothing is anchored in place for a non-additive transcript");
	assert.equal(JSON.stringify(finalBody).includes("tool_alpha description"), false, "the previous definition is gone");
	assert.deepEqual(kindsOf(finalBody.input), ["compaction_summary", "message:user", "message:user", "compaction_trigger"]);
	assert.equal(triggers(finalBody).length, 1);
});

test("a validated canonical baseline keeps its own tools, prompt and prefix", async () => {
	const model = modelNamed("gpt-6-astra");
	const canonicalTool = withTools("canonical_only", model.id);
	const fixture = session({
		messages: [
			["first", userMessage("first turn", 1)],
			["add", systemMessage("", 2, { toolsAdded: [tool("tool_beta")] })],
			["last", userMessage("last turn", 3)],
		],
	});
	const sessionId = "wire-canonical";
	try {
		// The baseline already materialized this history: it is validated and keeps its own body.
		const { finalBody, identity, built, canonicalReplay } = await compactionRequest({
			model,
			session: fixture,
			sessionId,
			canonical: (input) => ({
				model: model.id,
				instructions: "CANONICAL_PROMPT",
				tools: [canonicalTool],
				input,
			}),
		});

		assert.equal(canonicalReplay.decision, "validated", "the canonical baseline matches the reconstructed history");
		assert.equal(finalBody.instructions, "CANONICAL_PROMPT", "the canonical prompt is authoritative");
		assert.deepEqual(finalBody.tools, [canonicalTool], "the canonical body keeps its own tool placement");
		assert.deepEqual(kindsOf(finalBody.input), kindsOf(built.input).concat("compaction_trigger"));
		assert.equal(triggers(finalBody).length, 1);
		assert.equal(JSON.stringify(finalBody).includes("tool_beta"), true, "the baseline's own additions stay untouched");

		const stored = canonicalCompactionRequestBody(sessionId, model.id, identity);
		assert.deepEqual(stored?.tools, [canonicalTool], "the stored canonical baseline is unchanged");
		assert.equal(stored?.instructions, "CANONICAL_PROMPT");
	} finally {
		clearCanonicalSessions(sessionId);
	}
});

test("a stale canonical baseline falls back to the reconstructed placement", async () => {
	const model = modelNamed("gpt-6-astra");
	const canonicalTool = withTools("canonical_only", model.id);
	const fixture = session({
		messages: [
			["first", userMessage("first turn", 1)],
			["add", systemMessage("", 2, { toolsAdded: [tool("tool_beta")] })],
			["last", userMessage("last turn", 3)],
		],
	});
	const sessionId = "wire-reconstructed-with-canonical-state";
	try {
		const { finalBody, identity, canonicalReplay } = await compactionRequest({
			model,
			session: fixture,
			sessionId,
			canonical: () => ({
				model: model.id,
				instructions: "CANONICAL_PROMPT",
				tools: [canonicalTool],
				input: [{ role: "user", content: [{ type: "input_text", text: "older canonical history" }] }],
			}),
		});

		assert.notEqual(canonicalReplay.decision, "validated", "the stale baseline is rejected");
		assert.deepEqual(finalBody.tools.map((declared) => declared.name), ["tool_alpha"], "the reconstructed request uses the transcript placement");
		assert.deepEqual(declarationNames(finalBody), ["tool_alpha", "tool_beta"]);
		assert.equal(finalBody.instructions, "BASE_PROMPT");
		assert.equal(JSON.stringify(finalBody).includes("canonical_only"), false, "no canonical state leaks into the reconstructed request");

		const stored = canonicalCompactionRequestBody(sessionId, model.id, identity);
		assert.deepEqual(stored?.tools, [canonicalTool], "the canonical baseline is not overwritten");
		assert.equal(stored?.instructions, "CANONICAL_PROMPT");
	} finally {
		clearCanonicalSessions(sessionId);
	}
});
