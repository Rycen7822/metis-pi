import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "pi-query-rewrite-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

const rewriteModuleUrl = new URL("../query-rewrite.ts", import.meta.url).href;
const { rewriteSearchQuery } = await import(rewriteModuleUrl);

test("rewriteSearchQuery uses the registered provider runtime", async () => {
	const model = {
		api: "custom-rewrite-api",
		provider: "anthropic",
		id: "claude-haiku-4-5",
		input: ["text"],
	};
	let request;
	let calls = 0;
	const signal = new AbortController().signal;
	const result = await rewriteSearchQuery(
		"http status codes",
		{
			modelRegistry: {
				find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
				getAvailable: () => [model],
				complete: async (calledModel, context, options) => {
					calls++;
					request = { model: calledModel, context, options };
					return {
						stopReason: "stop",
						content: [{ type: "text", text: "HTTP status code semantics RFC 9110" }],
					};
				},
			},
			scopedModels: [],
		},
		signal,
	);

	assert.equal(result, "HTTP status code semantics RFC 9110");
	assert.equal(request.model, model);
	assert.equal(request.options.signal, signal);
	assert.match(request.context.messages[0].content[0].text, /Query: http status codes/);
	assert.equal(calls, 1);
});

test("rewriteSearchQuery skips models outside the host's resolved scope", async () => {
	const haiku = { api: "custom-rewrite-api", provider: "anthropic", id: "claude-haiku-4-5", input: ["text"] };
	const flash = { api: "custom-rewrite-api", provider: "google", id: "gemini-3.6-flash", input: ["text"] };
	const used = [];
	const result = await rewriteSearchQuery(
		"http status codes",
		{
			modelRegistry: {
				find: (provider, id) => [haiku, flash].find(model => model.provider === provider && model.id === id),
				getAvailable: () => [haiku, flash],
				complete: async (calledModel) => {
					used.push(`${calledModel.provider}/${calledModel.id}`);
					return { stopReason: "stop", content: [{ type: "text", text: "rewritten" }] };
				},
			},
			scopedModels: [{ model: flash }],
		},
		new AbortController().signal,
	);

	assert.equal(result, "rewritten");
	assert.deepEqual(used, ["google/gemini-3.6-flash"]);
});

test("rewriteSearchQuery skips ambiguous candidates without choosing an arbitrary route", async () => {
	const flash = { provider: "google", id: "gemini-3.6-flash" };
	let models = [...["openrouter", "requesty"].map(provider => ({ provider, id: "anthropic/claude-haiku-4-5" })), flash];
	const used = [];
	const ctx = { scopedModels: [], modelRegistry: {
		getAvailable: () => models,
		find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
		complete: async model => {
			used.push(model.provider);
			return { stopReason: "stop", content: [{ type: "text", text: "rewritten" }] };
		},
	} };
	const signal = new AbortController().signal;
	assert.equal(await rewriteSearchQuery("q", ctx, signal), "rewritten");
	assert.deepEqual(used, ["google"]);
	models = models.filter(model => model !== flash);
	await assert.rejects(rewriteSearchQuery("q", ctx, signal), /No enabled model available/);
	assert.deepEqual(used, ["google"]);
});



test("rewriteSearchQuery uses a real Pi runtime with a private routed API and model headers", async () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8", timeout: 15_000,
		env: { PATH: process.env.PATH, HOME: agentDir, USERPROFILE: agentDir, XDG_CONFIG_HOME: agentDir, PI_CODING_AGENT_DIR: agentDir },
		input: `
			import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
			import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
			const calls = [], network = [];
			globalThis.fetch = async url => { network.push(String(url)); throw new Error("No external network allowed"); };
			const runtime = await ModelRuntime.create({
				authPath: ${JSON.stringify(join(agentDir, "private-auth.json"))}, modelsPath: null,
				modelsStorePath: ${JSON.stringify(join(agentDir, "private-model-cache.sqlite"))},
				allowModelNetwork: false, refreshOnCreate: false,
			});
			const registry = new ModelRegistry(runtime);
			registry.registerProvider("private-rewrite", {
				api: "private-rewrite-api", baseUrl: "https://private.example.test/v1", apiKey: "private-test-key",
				models: [{ id: "anthropic/claude-haiku-4-5", name: "Private rewrite", reasoning: false, input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256,
					headers: { "X-Model": "private" } }],
				streamSimple(model, context, options) {
					calls.push({ model: { provider: model.provider, api: model.api }, options, prompt: context.messages[0].content[0].text });
					const stream = new AssistantMessageEventStream();
					const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
						content: [{ type: "text", text: "Private native rewrite" }], stopReason: "stop", timestamp: Date.now(),
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
				},
			});
			await runtime.getAvailable("private-rewrite");
			const model = registry.find("private-rewrite", "anthropic/claude-haiku-4-5");
			let preauthReads = 0;
			const resolveAuth = registry.getApiKeyAndHeaders.bind(registry);
			registry.getApiKeyAndHeaders = async model => { preauthReads++; return resolveAuth(model); };
			const { rewriteSearchQuery } = await import(${JSON.stringify(rewriteModuleUrl)});
			const result = await rewriteSearchQuery("status codes", { modelRegistry: registry, scopedModels: [{ model }] }, new AbortController().signal);
			console.log(JSON.stringify({ result, calls, network, preauthReads }));
		`,
	});
	assert.equal(child.status, 0, child.stderr || String(child.error));
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result, "Private native rewrite");
	assert.equal(output.preauthReads, 0);
	assert.deepEqual(output.network, []);
	assert.equal(output.calls.length, 1);
	assert.equal(output.calls[0].model.provider, "private-rewrite");
	assert.equal(output.calls[0].model.api, "private-rewrite-api");
	assert.equal(output.calls[0].options.apiKey, "private-test-key");
	assert.equal(output.calls[0].options.headers["X-Model"], "private");
});

test("rewriteSearchQuery never accepts text from an error response", async () => {
	const model = { provider: "anthropic", id: "claude-haiku-4-5" };
	await assert.rejects(rewriteSearchQuery("q", {
		modelRegistry: {
			find: () => model, getAvailable: () => [model],
			complete: async () => ({ stopReason: "error", errorMessage: "provider rejected the request",
				content: [{ type: "text", text: "partial query" }] }),
		},
		scopedModels: [],
	}, new AbortController().signal), /provider rejected the request/);
});
