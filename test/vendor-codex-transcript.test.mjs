#!/usr/bin/env node
// Built-provider protocol tests: payload capture aborts before transport; fetch is disabled.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { captureBody, declaredToolNames, FAKE_API_KEY, inPlaceToolItems, kindsOf, modelNamed } from "./helpers/vendor-codex-provider.mjs";
import { assistantToolCall, systemMessage, tool, toolResult, userMessage } from "./helpers/vendor-codex-sessions.mjs";
import { streamCodeModeResponsesProxy } from "../vendor/pi-codex-conversion/dist/providers/code-mode-proxy-provider.js";
import { hasContextNamespaceRouters } from "../vendor/pi-codex-conversion/dist/context-management/namespace-tools.js";
import { prewarmOpenAICodexWebSocket } from "../vendor/pi-codex-conversion/dist/providers/openai-codex-custom-provider.js";

const astra = modelNamed("gpt-6-astra");
const toolSearch = { ...astra, compat: { ...astra.compat, supportsAdditionalTools: false, supportsToolSearch: true } };
const spark = modelNamed("gpt-5.3-codex-spark");
const head = (tools = [tool("tool_alpha")]) => systemMessage("BASE_PROMPT", 0, { toolsAdded: tools });
const add = (...tools) => systemMessage("", 5, { toolsAdded: tools });
const remove = (name) => systemMessage("", 6, { toolsRemoved: [{ name }] });

test("legacy and normalized contexts keep projected prompts/tools once, including a forced goal", async () => {
	// before_agent_start goal projection has this same normalized leading-system-message shape.
	const context = {
		systemPrompt: "BASE_PROMPT\n\nACTIVE GOAL: finish the compatibility upgrade",
		tools: [tool("compat_probe_tool")], messages: [userMessage("hello")],
	};
	for (const input of [context, normalizeContext(context)]) {
		const body = await captureBody(astra, input);
		assert.equal(body.instructions, context.systemPrompt);
		assert.deepEqual(declaredToolNames(body), ["compat_probe_tool"]);
		assert.equal(JSON.stringify(body.input).includes("hello"), true);
		assert.equal(JSON.stringify(body.input).includes("ACTIVE GOAL"), false);
	}
});

test("later system additions anchor once through additional_tools or tool_search and keep prompt text", async () => {
	for (const model of [astra, toolSearch]) for (const [text, tail] of [["GOAL_UPDATE_TEXT", [userMessage("second turn", 6)]], ["", []]]) {
		const body = await captureBody(model, { messages: [
			head(), userMessage("first turn"),
			systemMessage(text, 5, { toolsAdded: [tool("tool_beta")] }), ...tail,
		] });
		assert.equal(body.instructions, "BASE_PROMPT");
		assert.deepEqual(declaredToolNames(body), ["tool_alpha"]);
		const additions = inPlaceToolItems(body.input);
		assert.deepEqual(kindsOf(additions), model === astra ? ["additional_tools"] : ["tool_search_call", "tool_search_output"]);
		assert.deepEqual(declaredToolNames(additions.at(-1)), ["tool_beta"]);
		if (model === toolSearch) assert.equal(additions[0].call_id, additions[1].call_id);
		assert.equal(body.input.some((item) => ["developer", "system"].includes(item.role) && String(item.content).includes("GOAL_UPDATE_TEXT")), Boolean(text));
	}
});

test("removal, re-addition and same-name replacement declare only the complete latest tool set", async () => {
	const readded = tool("tool_alpha", "READDED_ALPHA_DESCRIPTION");
	const replacement = {
		...tool("tool_alpha", "NEW_ALPHA_DESCRIPTION"),
		parameters: { type: "object", properties: { replaced: { type: "string" } }, required: ["replaced"] },
	};
	for (const model of [astra, toolSearch, spark]) {
		for (const [initial, deltas, expected] of [
			[[tool("tool_alpha")], [add(tool("tool_beta")), remove("tool_alpha")], [tool("tool_beta")]],
			[[tool("tool_alpha")], [add(tool("tool_beta")), remove("tool_beta")], [tool("tool_alpha")]],
			[[tool("tool_alpha")], [remove("tool_alpha"), add(readded)], [readded]],
			[[tool("tool_alpha", "OLD_ALPHA_DESCRIPTION")], [add(replacement)], [replacement]],
			[[tool("tool_alpha"), tool("tool_beta")], [remove("tool_beta")], [tool("tool_alpha")]],
		]) {
			const body = await captureBody(model, { messages: [head(initial), userMessage("first turn"), ...deltas] });
			assert.equal(body.instructions, "BASE_PROMPT");
			assert.deepEqual(body.tools.map(({ name, description, parameters }) => ({ name, description, parameters })), expected);
			assert.deepEqual(inPlaceToolItems(body.input), [], "non-additive history never re-announces removed or old definitions");
			assert.equal(JSON.stringify(body.input).includes("first turn"), true);
			assert.equal(JSON.stringify(body.input).includes("tool_beta"), false);
		}
	}
});

test("ordinary and legacy addedToolNames histories preserve pairing and share tool placement", async () => {
	for (const [resultExtra, deltas, topLevel, anchored] of [
		[{}, [], ["tool_alpha", "tool_beta"], []],
		[{ addedToolNames: ["tool_beta"] }, [], ["tool_alpha"], ["tool_beta"]],
		[{ addedToolNames: ["tool_beta"] }, [remove("tool_alpha")], ["tool_beta"], []],
	]) {
		const body = await captureBody(astra, { messages: [
			head([tool("tool_alpha"), tool("tool_beta")]), userMessage("read it"),
			assistantToolCall(astra, "call_abc|fc_abc", "tool_alpha"),
			{ ...toolResult("call_abc|fc_abc", "tool_alpha", "FILE_BODY"), ...resultExtra }, ...deltas,
		] });
		assert.deepEqual(declaredToolNames(body), topLevel);
		const additions = inPlaceToolItems(body.input);
		assert.deepEqual(kindsOf(additions), anchored.length ? ["additional_tools"] : []);
		assert.deepEqual(additions.flatMap(declaredToolNames), anchored);
		const calls = body.input.filter(({ type }) => type === "function_call");
		const outputs = body.input.filter(({ type }) => type === "function_call_output");
		assert.equal(calls.length, 1);
		assert.equal(outputs.length, 1);
		assert.equal(calls[0].call_id, "call_abc");
		assert.equal(outputs[0].call_id, "call_abc");
		assert.ok(JSON.stringify(outputs[0].output).includes("FILE_BODY"));
	}
});

test("a section-only update collapses into instructions on models without mid-conversation prompts", async () => {
	const body = await captureBody(spark, { messages: [head(), userMessage("first turn"), systemMessage("", 5, { sections: { goal: "GOAL_SECTION_TEXT" } })] });
	assert.equal(body.instructions, "BASE_PROMPT\n\nGOAL_SECTION_TEXT");
	assert.deepEqual(declaredToolNames(body), ["tool_alpha"]);
	assert.equal(body.input.some(({ role }) => role === "developer" || role === "system"), false);
});

test("Responses Lite proxy sends prompts/history and preserves function and grammar tool formats", async (t) => {
	const model = getBuiltinModels("openai").find(({ id }) => id === "gpt-4.1");
	assert.ok(model, "expected builtin openai model gpt-4.1");
	const grammar = {
		name: "shell_command", description: "run a shell command",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[^\\n]+/" } },
	};
	let body;
	t.mock.method(globalThis, "fetch", async (_url, init) => {
		body = JSON.parse(String(init.body));
		throw new Error("OFFLINE_PROXY_CAPTURE");
	});
	for (const declared of [tool("proxy_probe_tool"), grammar]) {
		body = undefined;
		const context = normalizeContext({ systemPrompt: "PROXY_PROMPT", tools: [declared], messages: [userMessage("proxy hello")] });
		await streamCodeModeResponsesProxy(model, context, { apiKey: "offline-proxy-key" }).result();
		assert.ok(body, "proxy must issue a request");
		const serialized = JSON.stringify(body);
		for (const text of ["PROXY_PROMPT", declared.name, "proxy hello"]) assert.ok(serialized.includes(text), text);
		if (declared === grammar) {
			assert.ok(serialized.includes('"type":"custom"'));
			assert.ok(serialized.includes('"definition":"start: /[^\\\\n]+/"'));
		}
	}
});

test("namespace routing sees normalized current tools rather than removed routers", () => {
	assert.equal(hasContextNamespaceRouters(normalizeContext({ tools: [tool("history"), tool("notes")], messages: [userMessage("hi")] })), true);
	assert.equal(hasContextNamespaceRouters({ messages: [head([tool("history"), tool("notes")]), userMessage("hi"), remove("notes")] }), false);
	assert.equal(hasContextNamespaceRouters(normalizeContext({ tools: [tool("history")], messages: [] })), false);
});

test("prewarm/keepalive preserves legacy prompt/tools before opening its socket", async () => {
	let payload;
	await assert.rejects(prewarmOpenAICodexWebSocket(astra, {
		systemPrompt: "PREWARM_SENTINEL_SYSTEM", tools: [tool("prewarm_tool")], messages: [userMessage("prewarm hello")],
	}, {
		apiKey: FAKE_API_KEY, sessionId: "offline-session", transport: "websocket",
		onPayload(body) { payload = body; throw new Error("OFFLINE_CAPTURE_COMPLETE"); },
	}, { getConfig: () => ({ openai: {}, executionMode: "default" }), preserveContinuation: true }), /OFFLINE_CAPTURE_COMPLETE/);
	assert.ok(payload);
	assert.equal(payload.instructions, "PREWARM_SENTINEL_SYSTEM");
	assert.deepEqual(declaredToolNames(payload), ["prewarm_tool"]);
	assert.equal(JSON.stringify(payload.input).includes("prewarm hello"), true);
});
