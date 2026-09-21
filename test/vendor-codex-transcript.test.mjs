#!/usr/bin/env node
/**
 * Protocol regressions for the vendored Codex conversion transport.
 *
 * These tests load the **built** entry (`vendor/pi-codex-conversion/dist/index.js`), take the
 * provider it registers, and capture the request body it would send, so they fail if the
 * vendored sources and the committed `dist/` drift apart. Everything is offline: the
 * capture hook throws before any transport is opened and `globalThis.fetch` is disabled.
 *
 * Covered here (Pi 0.86 transcript migration):
 *  - prompt and tool declarations survive when the host hands over a normalized transcript
 *    (`normalizeContext`) instead of a legacy `Context`;
 *  - later system messages keep their tool additions anchored and their prompt updates;
 *  - a later `toolsRemoved` never re-exposes the removed tool;
 *  - non-additive tool history (removal or redeclaration) declares the complete current
 *    tool set at the top level and anchors nothing in place (Astra and `tool_search` paths);
 *  - pre-0.86 `addedToolNames` results keep working and obey the same placement decision;
 *  - history tool call/result pairs stay matched;
 *  - grammar (`custom`) tools keep their wire format after the migration;
 *  - the Responses Lite / code-mode proxy request carries the prompt and tools;
 *  - namespace routing sees the current tool set from the transcript.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const ENTRY = new URL("../vendor/pi-codex-conversion/dist/index.js", import.meta.url).href;
const PROXY_ENTRY = new URL("../vendor/pi-codex-conversion/dist/providers/code-mode-proxy-provider.js", import.meta.url).href;
const NAMESPACE_ENTRY = new URL("../vendor/pi-codex-conversion/dist/context-management/namespace-tools.js", import.meta.url).href;
const PREWARM_ENTRY = new URL("../vendor/pi-codex-conversion/dist/providers/openai-codex-custom-provider.js", import.meta.url).href;

const FAKE_API_KEY = "x." + Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } }),
).toString("base64url") + ".x";

// Any transport that got past the payload capture would try to reach the network here.
globalThis.fetch = async () => {
	throw new Error("NETWORK_DISABLED");
};

const tool = (name, extra = {}) => ({
	name,
	description: `${name} description`,
	parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
	...extra,
});

const userMessage = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });

const assistantToolCall = (model, { id, name, arguments: args }) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	provider: model.provider,
	api: model.api,
	model: model.id,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
	stopReason: "toolUse",
	timestamp: 2,
});

const toolResult = ({ toolCallId, toolName, text, details }, timestamp = 3) => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [{ type: "text", text }],
	...(details === undefined ? {} : { details }),
	timestamp,
});

const declaredToolNames = (body) => body.tools?.map((declared) => declared.name) ?? [];
const declaredToolsText = (body) => JSON.stringify(body.tools ?? []);
const inPlaceToolItems = (body) =>
	body.input.filter(
		(item) => item.type === "additional_tools" || item.type === "tool_search_call" || item.type === "tool_search_output",
	);

let loaded;
async function loadRegistration() {
	loaded ??= (async () => {
		const extension = (await import(ENTRY)).default;
		assert.equal(typeof extension, "function", "vendored entry must export an extension factory");
		const calls = { providers: [], tools: [] };
		const recorded = {
			events: { emit: () => {}, on: () => {}, off: () => {} },
			on: () => {},
			registerTool: (options) => calls.tools.push(options),
			registerProvider: (...args) => calls.providers.push(args),
			getAllTools: () => [],
			getActiveTools: () => [],
			getSettings: () => ({}),
			getFlag: () => undefined,
			setFlag: () => {},
		};
		const pi = new Proxy(recorded, {
			get(target, property) {
				if (property in target) return target[property];
				if (typeof property !== "string") return undefined;
				return (...args) => {
					calls[property] = calls[property] ?? [];
					calls[property].push(args.length === 1 ? args[0] : args);
					return undefined;
				};
			},
		});
		await extension(pi);
		const registration = calls.providers.find(([first]) => first?.id === "openai-codex");
		assert.ok(registration, "vendored entry must register the openai-codex provider");
		return registration[0];
	})();
	return loaded;
}

async function captureBody(model, context, options = {}) {
	let payload;
	const provider = await loadRegistration();
	const stream = provider.streamSimple(model, context, {
		apiKey: FAKE_API_KEY,
		transport: "sse",
		...options,
		onPayload(body) {
			payload = body;
			throw new Error("OFFLINE_CAPTURE_COMPLETE");
		},
	});
	const result = await stream.result();
	assert.ok(payload, `onPayload must capture a body (stream ended with: ${result?.errorMessage ?? "no error"})`);
	return payload;
}

const modelNamed = (id) => {
	const models = getBuiltinModels("openai-codex");
	const model = models.find((candidate) => candidate.id === id);
	assert.ok(model, `expected builtin openai-codex model ${id}`);
	return model;
};

const systemMessage = (content, extra = {}) => ({ role: "system", content, timestamp: 0, ...extra });

test("normalized 0.86 transcript keeps the system prompt and tool declarations", async () => {
	const model = modelNamed("gpt-6-astra");
	const legacy = {
		systemPrompt: "COMPAT_SENTINEL_SYSTEM",
		tools: [tool("compat_probe_tool")],
		messages: [userMessage("hello")],
	};
	for (const [label, context] of [
		["legacy Context", legacy],
		["0.86 transcript", normalizeContext(legacy)],
	]) {
		const body = await captureBody(model, context);
		assert.equal(body.instructions, "COMPAT_SENTINEL_SYSTEM", `${label}: instructions`);
		assert.deepEqual(body.tools?.map((declared) => declared.name), ["compat_probe_tool"], `${label}: tools`);
		assert.equal(JSON.stringify(body.input).includes("hello"), true, `${label}: user turn kept`);
	}
});

test("later system message anchors tool additions without duplicating declarations", async () => {
	const model = modelNamed("gpt-6-astra");
	const body = await captureBody(model, {
		messages: [
			systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha")] }),
			userMessage("first turn"),
			systemMessage("GOAL_UPDATE_TEXT", { toolsAdded: [tool("tool_beta")], timestamp: 5 }),
			userMessage("second turn", 6),
		],
	});

	assert.equal(body.instructions, "BASE_PROMPT");
	assert.deepEqual(declaredToolNames(body), ["tool_alpha"], "initial tools stay at the top");
	const additions = inPlaceToolItems(body);
	assert.deepEqual(
		additions.map((item) => item.type),
		["additional_tools"],
		"the later system message anchors exactly one additional_tools item",
	);
	assert.deepEqual(additions[0].tools.map((declared) => declared.name), ["tool_beta"]);
	assert.equal(
		declaredToolsText(body).includes("tool_beta"),
		false,
		"an anchored addition must not also appear in the top-level declarations",
	);
	const promptUpdates = body.input.filter((item) => item.role === "developer" || item.role === "system");
	assert.ok(
		promptUpdates.some((item) => String(item.content).includes("GOAL_UPDATE_TEXT")),
		"the later system prompt text must reach the request",
	);
});

test("non-additive tool history declares the complete current tool set exactly once", async () => {
	const model = modelNamed("gpt-6-astra");
	const sequences = [
		{
			label: "removing an initial tool keeps the later addition",
			removed: "tool_alpha",
			expected: ["tool_beta"],
			messages: [
				systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha")] }),
				userMessage("first turn"),
				systemMessage("", { toolsAdded: [tool("tool_beta")], timestamp: 5 }),
				systemMessage("", { toolsRemoved: [{ name: "tool_alpha" }], timestamp: 6 }),
				userMessage("second turn", 7),
			],
		},
		{
			label: "removing the later addition leaves the initial tool",
			removed: "tool_beta",
			expected: ["tool_alpha"],
			messages: [
				systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha")] }),
				userMessage("first turn"),
				systemMessage("", { toolsAdded: [tool("tool_beta")], timestamp: 5 }),
				systemMessage("", { toolsRemoved: [{ name: "tool_beta" }], timestamp: 6 }),
				userMessage("second turn", 7),
			],
		},
		{
			label: "a removed tool that comes back is declared with its new definition",
			expected: ["tool_alpha"],
			expectedDescription: "READDED_ALPHA_DESCRIPTION",
			messages: [
				systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha")] }),
				userMessage("first turn"),
				systemMessage("", { toolsRemoved: [{ name: "tool_alpha" }], timestamp: 5 }),
				systemMessage("", {
					timestamp: 6,
					toolsAdded: [tool("tool_alpha", { description: "READDED_ALPHA_DESCRIPTION" })],
				}),
			],
		},
	];
	for (const { label, messages, expected, removed, expectedDescription } of sequences) {
		const body = await captureBody(model, { messages });
		assert.equal(body.instructions, "BASE_PROMPT", `${label}: instructions`);
		assert.deepEqual(declaredToolNames(body), expected, `${label}: current tools`);
		if (removed !== undefined) {
			assert.equal(declaredToolNames(body).includes(removed), false, `${label}: removed tool must not be declared`);
		}
		if (expectedDescription !== undefined) {
			assert.equal(declaredToolsText(body).includes(expectedDescription), true, `${label}: latest definition`);
		}
		assert.deepEqual(inPlaceToolItems(body), [], `${label}: nothing may be declared in place`);
		assert.equal(JSON.stringify(body.input).includes("first turn"), true, `${label}: history kept`);
	}
});

test("a same-name tool redeclaration uses the latest definition exactly once", async () => {
	const model = modelNamed("gpt-6-astra");
	const body = await captureBody(model, {
		messages: [
			systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha", { description: "OLD_ALPHA_DESCRIPTION" })] }),
			userMessage("first turn"),
			systemMessage("", {
				timestamp: 5,
				toolsAdded: [
					tool("tool_alpha", {
						description: "NEW_ALPHA_DESCRIPTION",
						parameters: { type: "object", properties: { replaced: { type: "string" } }, required: ["replaced"] },
					}),
				],
			}),
		],
	});
	assert.deepEqual(declaredToolNames(body), ["tool_alpha"], "the redeclared tool stays available exactly once");
	assert.equal(declaredToolsText(body).includes("NEW_ALPHA_DESCRIPTION"), true, "latest definition is declared");
	assert.equal(declaredToolsText(body).includes("OLD_ALPHA_DESCRIPTION"), false, "stale definition must not survive");
	assert.equal(declaredToolsText(body).includes('"replaced"'), true, "latest parameters are declared");
	assert.deepEqual(inPlaceToolItems(body), [], "a redeclaration must not be re-anchored in place");
});

test("tool_search models anchor later additions and keep non-additive history complete", async () => {
	const astra = modelNamed("gpt-6-astra");
	const model = { ...astra, compat: { ...astra.compat, supportsAdditionalTools: false, supportsToolSearch: true } };
	const additive = await captureBody(model, {
		messages: [
			systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha")] }),
			userMessage("first turn"),
			systemMessage("", { toolsAdded: [tool("tool_beta")], timestamp: 5 }),
		],
	});
	assert.deepEqual(declaredToolNames(additive), ["tool_alpha"], "initial tools stay at the top");
	const searchCalls = additive.input.filter((item) => item.type === "tool_search_call");
	const searchOutputs = additive.input.filter((item) => item.type === "tool_search_output");
	assert.equal(searchCalls.length, 1, "the later system message anchors one tool_search_call");
	assert.equal(searchOutputs.length, 1, "the later system message anchors one tool_search_output");
	assert.equal(searchCalls[0].call_id, searchOutputs[0].call_id, "tool_search call and output must pair");
	assert.deepEqual(searchOutputs[0].tools.map((declared) => declared.name), ["tool_beta"]);
	assert.equal(declaredToolsText(additive).includes("tool_beta"), false, "no duplicate top-level declaration");

	const replaced = await captureBody(model, {
		messages: [
			systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha")] }),
			userMessage("first turn"),
			systemMessage("", { toolsAdded: [tool("tool_beta")], timestamp: 5 }),
			systemMessage("", { toolsRemoved: [{ name: "tool_alpha" }], timestamp: 6 }),
		],
	});
	assert.deepEqual(declaredToolNames(replaced), ["tool_beta"], "complete current tool set after a removal");
	assert.deepEqual(inPlaceToolItems(replaced), [], "a non-additive history anchors nothing in place");
});

test("legacy addedToolNames results obey the same placement decision", async () => {
	const model = modelNamed("gpt-6-astra");
	const history = (extra) => [
		systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha"), tool("tool_beta")] }),
		userMessage("first turn"),
		assistantToolCall(model, { id: "call_1|fc_1", name: "tool_alpha", arguments: { value: "x" } }),
		{
			...toolResult({ toolCallId: "call_1|fc_1", toolName: "tool_alpha", text: "DONE" }),
			addedToolNames: ["tool_beta"],
		},
		...extra,
	];

	const additive = await captureBody(model, { messages: history([]) });
	assert.deepEqual(declaredToolNames(additive), ["tool_alpha"], "the deferred tool leaves the top-level declaration");
	const additions = additive.input.filter((item) => item.type === "additional_tools");
	assert.equal(additions.length, 1, "the tool result anchors the dynamically loaded tool");
	assert.deepEqual(additions[0].tools.map((declared) => declared.name), ["tool_beta"]);

	const nonAdditive = await captureBody(model, {
		messages: history([systemMessage("", { toolsRemoved: [{ name: "tool_alpha" }], timestamp: 6 })]),
	});
	assert.deepEqual(declaredToolNames(nonAdditive), ["tool_beta"], "complete current tool set after a removal");
	assert.deepEqual(inPlaceToolItems(nonAdditive), [], "the legacy lookup must not bypass the placement decision");
});

test("prompt section updates fold into instructions when the model has no mid-convo system messages", async () => {
	const model = modelNamed("gpt-5.3-codex-spark");
	const body = await captureBody(model, {
		messages: [
			systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha")] }),
			userMessage("first turn"),
			systemMessage("", { sections: { goal: "GOAL_SECTION_TEXT" }, timestamp: 5 }),
		],
	});
	assert.equal(body.instructions, "BASE_PROMPT\n\nGOAL_SECTION_TEXT");
	assert.deepEqual(body.tools?.map((declared) => declared.name), ["tool_alpha"]);
	assert.equal(
		body.input.some((item) => item.role === "developer" || item.role === "system"),
		false,
		"collapsed transcripts must not carry mid-conversation prompt items",
	);
});

test("a later toolsRemoved never re-exposes the removed tool", async () => {
	const model = modelNamed("gpt-5.3-codex-spark");
	const body = await captureBody(model, {
		messages: [
			systemMessage("BASE_PROMPT", { toolsAdded: [tool("tool_alpha"), tool("tool_beta")] }),
			userMessage("first turn"),
			systemMessage("", { toolsRemoved: [{ name: "tool_beta" }], timestamp: 5 }),
		],
	});
	assert.deepEqual(body.tools?.map((declared) => declared.name), ["tool_alpha"]);
	assert.equal(JSON.stringify(body.tools).includes("tool_beta"), false, "removed tool must not be declared");
	assert.equal(JSON.stringify(body.input).includes("tool_beta"), false, "removed tool must not be re-anchored");
});

test("history tool call/result pairs stay matched", async () => {
	const model = modelNamed("gpt-6-astra");
	const body = await captureBody(model, {
		messages: [
			systemMessage("PAIRING_PROMPT", { toolsAdded: [tool("read_file")] }),
			userMessage("read it"),
			assistantToolCall(model, { id: "call_abc|fc_abc", name: "read_file", arguments: { value: "x" } }),
			toolResult({ toolCallId: "call_abc|fc_abc", toolName: "read_file", text: "FILE_BODY" }),
		],
	});
	const calls = body.input.filter((item) => item.type === "function_call");
	const outputs = body.input.filter((item) => item.type === "function_call_output");
	assert.equal(calls.length, 1);
	assert.equal(outputs.length, 1);
	assert.equal(calls[0].call_id, "call_abc");
	assert.equal(outputs[0].call_id, "call_abc");
	assert.ok(JSON.stringify(outputs[0].output).includes("FILE_BODY"), "tool output must reach the request");
});

test("grammar tools keep their custom wire format on the Responses Lite proxy path", async () => {
	const { streamCodeModeResponsesProxy } = await import(PROXY_ENTRY);
	const model = getBuiltinModels("openai").find((candidate) => candidate.id === "gpt-4.1");
	assert.ok(model, "expected builtin openai model gpt-4.1");
	const grammarTool = {
		name: "shell_command",
		description: "run a shell command",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[^\\n]+/" } },
	};

	let recordedBody;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init) => {
		recordedBody = JSON.parse(String(init.body));
		throw new Error("OFFLINE_PROXY_CAPTURE");
	};
	try {
		const context = normalizeContext({
			systemPrompt: "GRAMMAR_PROXY_PROMPT",
			tools: [grammarTool],
			messages: [userMessage("run ls")],
		});
		await streamCodeModeResponsesProxy(model, context, { apiKey: "offline-proxy-key" }).result();
	} finally {
		globalThis.fetch = originalFetch;
	}

	const serialized = JSON.stringify(recordedBody);
	assert.equal(serialized.includes('"type":"custom"'), true, "grammar tool must serialize as a custom tool");
	assert.equal(serialized.includes('"definition":"start: /[^\\\\n]+/"'), true, "grammar definition must reach the wire");
	assert.equal(serialized.includes("shell_command"), true, "grammar tool name must reach the wire");
});

test("namespace routing sees current tools from a normalized transcript", async () => {
	const { hasContextNamespaceRouters } = await import(NAMESPACE_ENTRY);
	const withRouters = normalizeContext({ tools: [tool("history"), tool("notes")], messages: [userMessage("hi")] });
	assert.equal(hasContextNamespaceRouters(withRouters), true);
	const afterRemoval = {
		messages: [
			systemMessage("PROMPT", { toolsAdded: [tool("history"), tool("notes")] }),
			userMessage("hi"),
			systemMessage("", { toolsRemoved: [{ name: "notes" }], timestamp: 2 }),
		],
	};
	assert.equal(hasContextNamespaceRouters(afterRemoval), false);
	assert.equal(hasContextNamespaceRouters(normalizeContext({ tools: [tool("history")], messages: [] })), false);
});

test("forced goal projection keeps the projected prompt and current tools once", async () => {
	const model = modelNamed("gpt-6-astra");
	// Shape produced by the host when `before_agent_start` returns a full `systemPrompt`
	// (metis's goal extension): one leading system message with the merged prompt and the
	// current tools, and no later system messages.
	const body = await captureBody(model, {
		messages: [
			systemMessage("BASE_PROMPT\n\nACTIVE GOAL: finish the compatibility upgrade", {
				toolsAdded: [tool("tool_alpha")],
			}),
			userMessage("continue"),
		],
	});
	assert.equal(body.instructions, "BASE_PROMPT\n\nACTIVE GOAL: finish the compatibility upgrade");
	assert.deepEqual(body.tools?.map((declared) => declared.name), ["tool_alpha"]);
	assert.equal(
		JSON.stringify(body.input).includes("ACTIVE GOAL"),
		false,
		"the projected prompt comes through instructions, not as a duplicate input item",
	);
});

test("prewarm/keepalive keeps a legacy context prompt and tools", async () => {
	const { prewarmOpenAICodexWebSocket } = await import(PREWARM_ENTRY);
	const model = modelNamed("gpt-6-astra");
	let payload;
	await assert.rejects(
		prewarmOpenAICodexWebSocket(
			model,
			{ systemPrompt: "PREWARM_SENTINEL_SYSTEM", tools: [tool("prewarm_tool")], messages: [userMessage("prewarm hello")] },
			{
				apiKey: FAKE_API_KEY,
				sessionId: "offline-session",
				transport: "websocket",
				onPayload(body) {
					payload = body;
					throw new Error("OFFLINE_CAPTURE_COMPLETE");
				},
			},
			{ getConfig: () => ({ openai: {}, executionMode: "default" }), preserveContinuation: true },
		),
		/OFFLINE_CAPTURE_COMPLETE/,
	);
	assert.ok(payload, "prewarm must build a request body before opening the socket");
	assert.equal(payload.instructions, "PREWARM_SENTINEL_SYSTEM");
	assert.deepEqual(payload.tools?.map((declared) => declared.name), ["prewarm_tool"]);
	assert.equal(JSON.stringify(payload.input).includes("prewarm hello"), true);
});

test("Responses Lite proxy request carries the prompt and tools", async () => {
	const { streamCodeModeResponsesProxy } = await import(PROXY_ENTRY);
	const model = getBuiltinModels("openai").find((candidate) => candidate.id === "gpt-4.1");
	assert.ok(model, "expected builtin openai model gpt-4.1");

	let recordedBody;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init) => {
		recordedBody = JSON.parse(String(init.body));
		throw new Error("OFFLINE_PROXY_CAPTURE");
	};
	try {
		const context = normalizeContext({
			systemPrompt: "PROXY_SENTINEL_SYSTEM",
			tools: [tool("proxy_probe_tool")],
			messages: [userMessage("proxy hello")],
		});
		const stream = streamCodeModeResponsesProxy(model, context, { apiKey: "offline-proxy-key" });
		await stream.result();
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.ok(recordedBody, "the proxy must issue a request");
	const serialized = JSON.stringify(recordedBody);
	assert.equal(serialized.includes("PROXY_SENTINEL_SYSTEM"), true, "proxy prompt must reach the request");
	assert.equal(serialized.includes("proxy_probe_tool"), true, "proxy tools must reach the request");
	assert.equal(serialized.includes("proxy hello"), true, "proxy history must reach the request");
});
