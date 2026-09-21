#!/usr/bin/env node
/**
 * Compaction and native-replay regressions for the vendored Codex conversion transport.
 *
 * These tests drive the **built** serializer (`dist/adapter/compaction/serializer.js`) and the
 * **built** native replay (`dist/adapter/replay/payload-rewrite.js`) against the payload the
 * registered `openai-codex` provider actually builds for a real Pi 0.86 session
 * (`buildSessionContext` + `convertToLlm`, captured through the provider). Everything is
 * offline: the capture hook throws before any transport is opened and `globalThis.fetch` is
 * disabled. The `compactedWindow` fixture is a handmade offline checkpoint stand-in, never a
 * real server-side encrypted window.
 *
 * Covered here (Pi 0.86 transcript migration, compaction/replay callers):
 *  - the compaction serializer replays the same history as the provider request, including
 *    mid-conversation system updates (content and sections);
 *  - a model without mid-conversation system messages collapses the same transcript and the
 *    serializer matches its payload;
 *  - native replay accepts a checkpoint plus live tail, keeps the update once in place and
 *    reuses the opaque checkpoint window;
 *  - an update at the head of a replayed slice is replayed in place instead of being dropped
 *    as if it were the transcript head, and the leading prompt is not re-injected;
 *  - a fresh compaction replays the full session with the same semantics as the provider;
 *  - anchored dynamic tools survive replay (`additional_tools` and `tool_search`), keep their
 *    call/output pairing, and non-additive history keeps the complete current tool set;
 *  - system messages the host folds into the checkpoint (`buildContextEntries` drops kept
 *    system entries) are not replayed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { captureBody, modelNamed } from "./helpers/vendor-codex-provider.mjs";
import {
	SEALED_WINDOW_ITEM,
	checkpointSession,
	linkFrom,
	messageEntry,
	systemMessage,
	tool,
	userMessage,
} from "./helpers/vendor-codex-sessions.mjs";

const SERIALIZER_ENTRY = new URL("../vendor/pi-codex-conversion/dist/adapter/compaction/serializer.js", import.meta.url).href;
const REPLAY_ENTRY = new URL("../vendor/pi-codex-conversion/dist/adapter/replay/payload-rewrite.js", import.meta.url).href;
const COMPACTION_ENTRY = new URL("../vendor/pi-codex-conversion/dist/adapter/compaction/compaction.js", import.meta.url).href;

const { serializeMessagesToResponsesInput } = await import(SERIALIZER_ENTRY);
const { buildNativeReplaySegments, serializeLiveTailToResponsesInput } = await import(REPLAY_ENTRY);
const { buildNativeCompactionInput } = await import(COMPACTION_ENTRY);

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

async function providerPayload(model, session) {
	const context = buildSessionContext(session.entries, session.leafId);
	return captureBody(model, normalizeContext({ messages: convertToLlm(context.messages) }));
}

function replayPayload(model, payload, session) {
	return buildNativeReplaySegments({ model, payload, branchEntries: session.entries, compactionEntry: session.compaction });
}

/** Kept-window fixture: one compaction summary plus one kept user entry precede the tail. */
const KEPT_PREFIX_ITEMS = 2;

const RESPONSES_ITEM_TYPES = new Set([
	"additional_tools",
	"tool_search_call",
	"tool_search_output",
	"function_call",
	"function_call_output",
	"reasoning",
	"compaction_summary",
]);
const kindOf = (item) =>
	RESPONSES_ITEM_TYPES.has(item.type) ? item.type : item.role ? `message:${item.role}` : item.type;
const kindsOf = (items) => items.map(kindOf);
const textOf = (item) =>
	typeof item.content === "string" ? item.content : (item.content ?? []).map((part) => part.text ?? "").join("");
const itemsContaining = (items, needle) => items.filter((item) => JSON.stringify(item).includes(needle));
const declaredToolNames = (payload) => payload.tools?.map((declared) => declared.name) ?? [];
const inPlaceToolItems = (input) =>
	input.filter((item) => item.type === "additional_tools" || item.type === "tool_search_call" || item.type === "tool_search_output");

function assertReplayOk(result) {
	assert.equal(
		result.ok,
		true,
		`native replay must accept the provider payload (${result.reason ?? "unknown"}${result.parity ? `: ${result.parity.mismatches.join("; ")}` : ""})`,
	);
}

test("the compaction serializer replays the same history as the provider request", async () => {
	const model = modelNamed("gpt-6-astra");
	const messages = [
		systemMessage("BASE_PROMPT", 0, { toolsAdded: [tool("tool_alpha")] }),
		userMessage("first turn", 1),
		systemMessage("UPDATE_TEXT", 5, { sections: { goal: "NEW_GOAL" } }),
		userMessage("second turn", 6),
	];

	const payload = await captureBody(model, normalizeContext({ messages }));
	const serialized = serializeMessagesToResponsesInput(model, messages);

	assert.equal(payload.instructions, "BASE_PROMPT");
	assert.deepEqual(serialized, payload.input, "the serializer must replay the provider's own history");
	assert.deepEqual(kindsOf(serialized), ["message:user", "message:developer", "message:user"]);
	assert.equal(itemsContaining(serialized, "UPDATE_TEXT").length, 1, "the update is replayed once");
	assert.equal(itemsContaining(serialized, "NEW_GOAL").length, 1, "the section change is replayed once");
	assert.match(textOf(serialized[1]), /Updated system prompt section "goal"/);
	assert.equal(JSON.stringify(serialized).includes("BASE_PROMPT"), false, "the leading prompt stays out of the input");
});

test("a model without mid-conversation system messages collapses the same transcript on both paths", async () => {
	const model = modelNamed("gpt-5.3-codex-spark");
	assert.notEqual(model.compat?.supportsMidConvoSystemMessages, true, "this case needs the collapsing model shape");
	const messages = [
		systemMessage("BASE_PROMPT", 0, { toolsAdded: [tool("tool_alpha")] }),
		userMessage("first turn", 1),
		systemMessage("UPDATE_TEXT", 5, { sections: { goal: "NEW_GOAL" }, toolsAdded: [tool("tool_beta")] }),
		userMessage("second turn", 6),
	];

	const payload = await captureBody(model, normalizeContext({ messages }));
	const serialized = serializeMessagesToResponsesInput(model, messages);

	assert.equal(payload.instructions, "BASE_PROMPT\n\nUPDATE_TEXT\n\nNEW_GOAL", "the collapsed prompt holds both turns");
	assert.deepEqual(serialized, payload.input, "the serializer must collapse exactly like the provider");
	assert.deepEqual(kindsOf(serialized), ["message:user", "message:user"]);
	assert.deepEqual(declaredToolNames(payload), ["tool_alpha", "tool_beta"], "collapse sends the current tool set at the top");
	assert.deepEqual(inPlaceToolItems(payload.input), [], "a collapsing model anchors nothing in place");
});

test("native replay keeps mid-conversation updates and the opaque checkpoint window", async () => {
	const model = modelNamed("gpt-6-astra");
	for (const withUpdate of [false, true]) {
		const tail = [
			["tail-before", userMessage("tail-before-update", 5)],
			...(withUpdate ? [["change", systemMessage("UPDATE_TEXT", 6, { sections: { goal: "NEW_GOAL" } })]] : []),
			["tail-after", userMessage("tail-after-update", 7)],
		];
		const session = checkpointSession({ model, tail });
		const payload = await providerPayload(model, session);
		const result = replayPayload(model, payload, session);
		assertReplayOk(result);

		assert.equal(result.rewrittenPayload.instructions, "BASE_PROMPT", `withUpdate=${withUpdate}: checkpoint prompt`);
		assert.deepEqual(declaredToolNames(result.rewrittenPayload), declaredToolNames(payload), `withUpdate=${withUpdate}: tools`);
		const rewritten = result.rewrittenPayload.input;
		const tailInput = result.segments.postCompactionTail.input;
		assert.deepEqual(kindsOf(rewritten), withUpdate
			? ["compaction_summary", "message:user", "message:developer", "message:user"]
			: ["compaction_summary", "message:user", "message:user"]);
		assert.deepEqual(
			rewritten,
			[
				...result.segments.freshPreamble,
				...result.segments.compactedWindow,
				...tailInput,
				...result.segments.trailingPreamble,
			],
			`withUpdate=${withUpdate}: rewritten input reuses the checkpoint window and the replayed tail`,
		);
		assert.equal(itemsContaining(rewritten, "offline-sealed-fixture").length, 1, `withUpdate=${withUpdate}: checkpoint window kept`);
		assert.deepEqual(result.segments.compactedWindow, [SEALED_WINDOW_ITEM], `withUpdate=${withUpdate}: window cloned as-is`);
		assert.equal(itemsContaining(rewritten, "UPDATE_TEXT").length, withUpdate ? 1 : 0, `withUpdate=${withUpdate}: update count`);
		assert.deepEqual(tailInput, payload.input.slice(KEPT_PREFIX_ITEMS), `withUpdate=${withUpdate}: replayed tail matches the provider`);
		assert.deepEqual(kindsOf(tailInput), withUpdate
			? ["message:user", "message:developer", "message:user"]
			: ["message:user", "message:user"], `withUpdate=${withUpdate}: replayed tail shape`);
		assert.equal(result.segments.compactionSummary.length, 1, `withUpdate=${withUpdate}: strict replay kept the summary slot`);
	}
});

test("an update at the head of a replayed slice is replayed in place", async () => {
	const model = modelNamed("gpt-6-astra");
	const session = checkpointSession({
		model,
		tail: [
			["change", systemMessage("UPDATE_TEXT", 5, { sections: { goal: "NEW_GOAL" } })],
			["tail", userMessage("tail-after-update", 6)],
		],
	});
	const payload = await providerPayload(model, session);
	const liveTail = serializeLiveTailToResponsesInput({ model, entries: session.tailEntries });

	assert.deepEqual(kindsOf(liveTail), ["message:developer", "message:user"], "the slice head is an update, not the transcript prompt");
	assert.equal(itemsContaining(liveTail, "UPDATE_TEXT").length, 1);
	assert.equal(JSON.stringify(liveTail).includes("BASE_PROMPT"), false, "the leading prompt is not re-injected into the slice");

	const result = replayPayload(model, payload, session);
	assertReplayOk(result);
	assert.equal(result.rewrittenPayload.instructions, "BASE_PROMPT", "the checkpoint prompt stays the only leading prompt");
	assert.equal(itemsContaining(result.rewrittenPayload.input, "UPDATE_TEXT").length, 1, "the update is replayed exactly once");
	assert.deepEqual(kindsOf(result.segments.postCompactionTail.input), kindsOf(liveTail));
});

test("replay preserves additional_tools declarations, calls and results", async () => {
	const model = modelNamed("gpt-6-astra");
	const session = checkpointSession({
		model,
		tail: [
			["tail-before", userMessage("tail-before", 5)],
			["add", systemMessage("", 6, { toolsAdded: [tool("tool_beta")] })],
			["call", assistantToolCall(model, "call_beta", "tool_beta")],
			["result", toolResult("call_beta", "tool_beta", "beta done", 8)],
			["tail-after", userMessage("tail-after", 9)],
		],
	});
	const payload = await providerPayload(model, session);

	assert.deepEqual(declaredToolNames(payload), ["tool_alpha"], "the initial tool stays at the top");
	assert.deepEqual(kindsOf(payload.input), [
		"message:user",
		"message:user",
		"message:user",
		"additional_tools",
		"function_call",
		"function_call_output",
		"message:user",
	]);
	const [addition] = inPlaceToolItems(payload.input);
	assert.deepEqual(addition.tools.map((declared) => declared.name), ["tool_beta"]);
	assert.deepEqual(addition.tools[0].parameters, tool("tool_beta").parameters, "the announced definition is replayed");

	const result = replayPayload(model, payload, session);
	assertReplayOk(result);
	const tailInput = result.segments.postCompactionTail.input;
	assert.deepEqual(tailInput, payload.input.slice(KEPT_PREFIX_ITEMS), "the slice replay matches the provider tail byte for byte");
	assert.deepEqual(kindsOf(tailInput), [
		"message:user",
		"additional_tools",
		"function_call",
		"function_call_output",
		"message:user",
	]);
	const rewritten = result.rewrittenPayload.input;
	assert.deepEqual(
		rewritten,
		[...result.segments.freshPreamble, ...result.segments.compactedWindow, ...tailInput, ...result.segments.trailingPreamble],
		"the rewritten input keeps the checkpoint window followed by the replayed tail",
	);
	const [replayedAddition] = inPlaceToolItems(rewritten);
	assert.deepEqual(replayedAddition.tools.map((declared) => declared.name), ["tool_beta"]);
	assert.deepEqual(replayedAddition.tools[0].parameters, tool("tool_beta").parameters);
	const call = rewritten.find((item) => item.type === "function_call");
	const output = rewritten.find((item) => item.type === "function_call_output");
	assert.equal(call.call_id, output.call_id, "call and result keep their shared id");
	assert.equal(itemsContaining(rewritten, "call_beta").length, 2, "the pair is replayed exactly once");
});

test("replay preserves tool_search pairs for tool_search models", async () => {
	const model = modelNamed("gpt-5.5");
	const session = checkpointSession({
		model,
		tail: [
			["tail-before", userMessage("tail-before", 5)],
			["add", systemMessage("", 6, { toolsAdded: [tool("tool_beta")] })],
			["tail-after", userMessage("tail-after", 7)],
		],
	});
	const payload = await providerPayload(model, session);
	const searchCall = payload.input.find((item) => item.type === "tool_search_call");
	const searchOutput = payload.input.find((item) => item.type === "tool_search_output");
	assert.ok(searchCall && searchOutput, "the provider must declare the addition through tool_search");
	assert.equal(searchCall.call_id, searchOutput.call_id, "the provider pairs its own call and output");
	assert.equal(searchOutput.tools[0].name, "tool_beta");
	assert.equal(searchOutput.tools[0].defer_loading, true);

	const liveTail = serializeLiveTailToResponsesInput({ model, entries: session.tailEntries });
	assert.deepEqual(liveTail, payload.input.slice(KEPT_PREFIX_ITEMS), "slice replay reproduces the provider's tool_search ids");

	const result = replayPayload(model, payload, session);
	assertReplayOk(result);
	const tailInput = result.segments.postCompactionTail.input;
	assert.deepEqual(tailInput, payload.input.slice(KEPT_PREFIX_ITEMS), "the replayed slice keeps the provider pair");
	const replayedCall = tailInput.find((item) => item.type === "tool_search_call");
	const replayedOutput = tailInput.find((item) => item.type === "tool_search_output");
	assert.equal(replayedCall.call_id, replayedOutput.call_id);
	assert.equal(itemsContaining(result.rewrittenPayload.input, replayedCall.call_id).length, 2, "the pair is replayed exactly once");
});

test("a fresh compaction replays the full session with its updates", async () => {
	const model = modelNamed("gpt-6-astra");
	const head = messageEntry("head", null, systemMessage("BASE_PROMPT", 0, { toolsAdded: [tool("tool_alpha")] }));
	const session = [head, ...linkFrom(head.id, [
		["first", userMessage("first turn", 1)],
		["change", systemMessage("UPDATE_TEXT", 2, { sections: { goal: "NEW_GOAL" } })],
		["second", userMessage("second turn", 3)],
	])];
	const built = buildNativeCompactionInput({
		model,
		branchEntries: session,
		allEntries: session,
		leafId: "second",
		latestNativeCompaction: { ok: false },
	});

	const payload = await captureBody(model, normalizeContext({
		messages: convertToLlm(buildSessionContext(session, "second").messages),
	}));
	assert.equal(built.compactedKeptWindow, true, "no checkpoint yet: the whole session is the input");
	assert.deepEqual(built.input, payload.input, "the fresh compaction replays the provider history");
	assert.deepEqual(kindsOf(built.input), ["message:user", "message:developer", "message:user"]);
	assert.equal(itemsContaining(built.input, "UPDATE_TEXT").length, 1, "the update is not dropped from a full-session replay");
});

test("non-additive tool history around a checkpoint keeps the complete current tool set", async () => {
	const model = modelNamed("gpt-6-astra");
	const cases = [
		{
			label: "redeclaration after the checkpoint",
			checkpointSystemMessage: systemMessage("BASE_PROMPT", 4, { toolsAdded: [tool("tool_beta", "OLD_BETA_DESCRIPTION")] }),
			tail: [
				["tail-before", userMessage("tail-before", 5)],
				["redeclare", systemMessage("", 6, { toolsAdded: [tool("tool_beta", "NEW_BETA_DESCRIPTION")] })],
				["tail-after", userMessage("tail-after", 7)],
			],
			expectedTools: ["tool_beta"],
			expectInPlace: false,
		},
		{
			label: "removal after the checkpoint",
			tail: [
				["tail-before", userMessage("tail-before", 5)],
				["remove", systemMessage("", 6, { toolsRemoved: [{ name: "tool_alpha" }] })],
				["tail-after", userMessage("tail-after", 7)],
			],
			expectedTools: [],
			expectInPlace: false,
		},
		{
			label: "addition before the checkpoint does not hide a later removal",
			kept: [["kept-add", systemMessage("", 2, { toolsAdded: [tool("tool_beta")] })]],
			checkpointSystemMessage: systemMessage("BASE_PROMPT", 4, { toolsAdded: [tool("tool_alpha"), tool("tool_beta")] }),
			tail: [
				["tail-before", userMessage("tail-before", 5)],
				["remove", systemMessage("", 6, { toolsRemoved: [{ name: "tool_alpha" }] })],
				["tail-after", userMessage("tail-after", 7)],
			],
			expectedTools: ["tool_beta"],
			expectInPlace: false,
		},
		{
			label: "kept system delta is folded into the checkpoint",
			kept: [["kept-add", systemMessage("KEPT_DELTA_TEXT", 2, { toolsAdded: [tool("tool_beta")] })]],
			checkpointSystemMessage: systemMessage("BASE_PROMPT", 4, { toolsAdded: [tool("tool_alpha"), tool("tool_beta")] }),
			tail: [["tail-after", userMessage("tail-after", 7)]],
			expectedTools: ["tool_alpha", "tool_beta"],
			expectInPlace: false,
		},
	];

	for (const scenario of cases) {
		const session = checkpointSession({ model, kept: scenario.kept, tail: scenario.tail, checkpointSystemMessage: scenario.checkpointSystemMessage });
		const payload = await providerPayload(model, session);
		assert.deepEqual(declaredToolNames(payload), scenario.expectedTools, `${scenario.label}: top-level tools`);
		if (!scenario.expectInPlace) {
			assert.deepEqual(inPlaceToolItems(payload.input), [], `${scenario.label}: provider anchors nothing`);
		}
		assert.equal(JSON.stringify(payload.input).includes("KEPT_DELTA_TEXT"), false, `${scenario.label}: kept delta stays folded`);

		const result = replayPayload(model, payload, session);
		assertReplayOk(result);
		assert.deepEqual(declaredToolNames(result.rewrittenPayload), scenario.expectedTools, `${scenario.label}: replayed tools`);
		assert.deepEqual(inPlaceToolItems(result.rewrittenPayload.input), [], `${scenario.label}: replay anchors nothing`);
		assert.equal(JSON.stringify(result.rewrittenPayload.input).includes("KEPT_DELTA_TEXT"), false, `${scenario.label}: replay stays folded`);
		const removedTool = scenario.label.includes("removal") ? "tool_alpha" : undefined;
		if (removedTool) {
			assert.equal(JSON.stringify(inPlaceToolItems(result.rewrittenPayload.input)).includes(removedTool), false, `${scenario.label}: removed tool is not re-announced`);
		}
	}
});
