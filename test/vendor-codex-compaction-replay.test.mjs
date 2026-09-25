#!/usr/bin/env node
// Compare built serializer/replay entrypoints with the registered provider's real Pi transcript.
// All capture hooks stop before transport; the opaque checkpoint is an offline stand-in.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { captureBody, captureSession, declaredToolNames, inPlaceToolItems, kindsOf, modelNamed } from "./helpers/vendor-codex-provider.mjs";
import { SEALED_WINDOW_ITEM, assistantToolCall, checkpointSession, session, systemMessage, tool, toolResult, userMessage } from "./helpers/vendor-codex-sessions.mjs";
import { serializeMessagesToResponsesInput } from "../vendor/pi-codex-conversion/dist/adapter/compaction/serializer.js";
import { buildNativeReplaySegments, serializeLiveTailToResponsesInput } from "../vendor/pi-codex-conversion/dist/adapter/replay/payload-rewrite.js";
import { buildNativeCompactionInput } from "../vendor/pi-codex-conversion/dist/adapter/compaction/compaction.js";

const itemsContaining = (items, needle) => items.filter((item) => JSON.stringify(item).includes(needle));

async function replaySession(model, fixture) {
	const payload = await captureSession(model, fixture.entries, fixture.leafId);
	const result = buildNativeReplaySegments({ model, payload, branchEntries: fixture.entries, compactionEntry: fixture.compaction });
	assert.equal(result.ok, true, `${result.reason}: ${result.parity?.mismatches.join("; ")}`);
	const { segments, rewrittenPayload: rewritten } = result;
	assert.equal(rewritten.instructions, payload.instructions);
	assert.deepEqual(declaredToolNames(rewritten), declaredToolNames(payload));
	assert.deepEqual(segments.compactedWindow, [SEALED_WINDOW_ITEM]);
	assert.deepEqual(rewritten.input, [
		...segments.freshPreamble, ...segments.compactedWindow,
		...segments.postCompactionTail.input, ...segments.trailingPreamble,
	]);
	// The fixture's compaction summary and kept user entry precede its live tail.
	assert.deepEqual(segments.postCompactionTail.input, payload.input.slice(2));
	assert.equal(segments.compactionSummary.length, 1, "strict replay retains the summary slot");
	return { payload, rewritten, segments };
}

test("serializer and fresh compaction match the provider with in-place and collapsed prompt updates", async () => {
	for (const [id, additions, instructions, kinds] of [
		["gpt-6-astra", [], "BASE_PROMPT", ["message:user", "message:developer", "message:user"]],
		["gpt-5.3-codex-spark", [tool("tool_beta")], "BASE_PROMPT\n\nUPDATE_TEXT\n\nNEW_GOAL", ["message:user", "message:user"]],
	]) {
		const model = modelNamed(id);
		const fixture = session({ messages: [
			userMessage("first turn"),
			systemMessage("UPDATE_TEXT", 2, { sections: { goal: "NEW_GOAL" }, toolsAdded: additions }),
			userMessage("second turn", 3),
		] });
		const messages = fixture.entries.map(({ message }) => message);
		const payload = await captureBody(model, normalizeContext({ messages }));
		const serialized = serializeMessagesToResponsesInput(model, messages);
		assert.equal(payload.instructions, instructions);
		assert.deepEqual(serialized, payload.input);
		assert.deepEqual(kindsOf(serialized), kinds);
		assert.deepEqual(declaredToolNames(payload), ["tool_alpha", ...additions.map(({ name }) => name)]);
		assert.deepEqual(inPlaceToolItems(payload.input), []);
		if (id === "gpt-6-astra") {
			for (const text of ["UPDATE_TEXT", "NEW_GOAL"]) assert.equal(itemsContaining(serialized, text).length, 1);
			const update = serialized[1].content;
			assert.match(typeof update === "string" ? update : update.map(({ text = "" }) => text).join(""), /Updated system prompt section "goal"/);
			assert.equal(itemsContaining(serialized, "BASE_PROMPT").length, 0);
		} else assert.notEqual(model.compat?.supportsMidConvoSystemMessages, true);
		const built = buildNativeCompactionInput({
			model, branchEntries: fixture.entries, allEntries: fixture.entries, leafId: fixture.leafId,
			latestNativeCompaction: { ok: false },
		});
		assert.equal(built.ok, true, built.reason);
		assert.equal(built.compactedKeptWindow, true);
		assert.deepEqual(built.input, payload.input);
		assert.deepEqual(built.input, (await captureSession(model, fixture.entries, fixture.leafId)).input);
	}
});

test("native replay keeps absent, middle and slice-head updates in their exact position", async () => {
	const model = modelNamed("gpt-6-astra");
	const update = systemMessage("UPDATE_TEXT", 6, { sections: { goal: "NEW_GOAL" } });
	for (const [tail, kinds] of [
		[[userMessage("before", 5), userMessage("after", 7)], ["message:user", "message:user"]],
		[[userMessage("before", 5), update, userMessage("after", 7)], ["message:user", "message:developer", "message:user"]],
		[[update, userMessage("after", 7)], ["message:developer", "message:user"]],
	]) {
		const fixture = checkpointSession({ model, tail });
		const { rewritten, segments } = await replaySession(model, fixture);
		const liveTail = serializeLiveTailToResponsesInput({ model, entries: fixture.tailEntries });
		assert.equal(rewritten.instructions, "BASE_PROMPT");
		assert.deepEqual(liveTail, segments.postCompactionTail.input);
		assert.deepEqual(kindsOf(rewritten.input), ["compaction_summary", ...kinds]);
		assert.equal(itemsContaining(rewritten.input, "offline-sealed-fixture").length, 1);
		assert.equal(itemsContaining(rewritten.input, "UPDATE_TEXT").length, tail.includes(update) ? 1 : 0);
		assert.equal(itemsContaining(liveTail, "BASE_PROMPT").length, 0, "slice heads are updates, not leading prompts");
	}
});

test("additional_tools and tool_search replay declarations and matched call/output pairs", async () => {
	for (const id of ["gpt-6-astra", "gpt-5.5"]) {
		const model = modelNamed(id);
		const fixture = checkpointSession({ model, tail: [
			userMessage("tail-before", 5), systemMessage("", 6, { toolsAdded: [tool("tool_beta")] }),
			assistantToolCall(model, "call_beta", "tool_beta"), toolResult("call_beta", "tool_beta", "beta done", 8),
			userMessage("tail-after", 9),
		] });
		const { payload, rewritten, segments } = await replaySession(model, fixture);
		assert.deepEqual(declaredToolNames(payload), ["tool_alpha"]);
		const declarations = inPlaceToolItems(rewritten.input);
		assert.deepEqual(declarations, inPlaceToolItems(payload.input));
		assert.deepEqual(kindsOf(declarations), id === "gpt-6-astra" ? ["additional_tools"] : ["tool_search_call", "tool_search_output"]);
		const announced = declarations.at(-1).tools;
		assert.deepEqual(announced.map(({ name }) => name), ["tool_beta"]);
		assert.deepEqual(announced[0].parameters, tool("tool_beta").parameters);
		if (id === "gpt-5.5") {
			assert.equal(declarations[0].call_id, declarations[1].call_id);
			assert.equal(announced[0].defer_loading, true);
			assert.equal(itemsContaining(rewritten.input, declarations[0].call_id).length, 2);
		}
		const tailKinds = [
			"message:user", ...kindsOf(declarations), "function_call", "function_call_output", "message:user",
		];
		assert.deepEqual(kindsOf(segments.postCompactionTail.input), tailKinds);
		assert.deepEqual(kindsOf(payload.input), ["message:user", "message:user", ...tailKinds]);
		assert.deepEqual(serializeLiveTailToResponsesInput({ model, entries: fixture.tailEntries }), payload.input.slice(2));
		assert.equal(rewritten.input.find(({ type }) => type === "function_call").call_id, "call_beta");
		assert.equal(rewritten.input.find(({ type }) => type === "function_call_output").call_id, "call_beta");
		assert.equal(itemsContaining(rewritten.input, "call_beta").length, 2);
	}
});

test("non-additive checkpoint history declares the current set and folds kept system deltas", async () => {
	const model = modelNamed("gpt-6-astra");
	const removeAlpha = systemMessage("", 6, { toolsRemoved: [{ name: "tool_alpha" }] });
	const checkpointTools = (...tools) => systemMessage("BASE_PROMPT", 4, { toolsAdded: tools });
	for (const { kept, checkpointSystemMessage, delta, expected } of [
		{
			checkpointSystemMessage: checkpointTools(tool("tool_beta", "OLD_BETA_DESCRIPTION")),
			delta: systemMessage("", 6, { toolsAdded: [tool("tool_beta", "NEW_BETA_DESCRIPTION")] }), expected: ["tool_beta"],
		},
		{ delta: removeAlpha, expected: [] },
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
		const { payload, rewritten } = await replaySession(model, fixture);
		for (const body of [payload, rewritten]) {
			assert.deepEqual(declaredToolNames(body), expected);
			assert.deepEqual(inPlaceToolItems(body.input), []);
			assert.equal(itemsContaining(body.input, "KEPT_DELTA_TEXT").length, 0);
		}
	}
});
