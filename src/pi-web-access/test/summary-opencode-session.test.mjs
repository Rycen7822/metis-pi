import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { generateSummaryDraft } from "../summary-review.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "pi-summary-opencode-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

const results = [{
	query: "test query",
	answer: "A test answer.",
	results: [{ title: "Source", url: "https://example.test" }],
	error: null,
	provider: "test",
}];

function context(models, complete) {
	return {
		modelRegistry: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			getAvailable: () => models,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-existing": "kept" } }),
			...(complete ? { complete } : {}),
		},
		sessionManager: { getSessionId: () => "summary-session-385" },
		scopedModels: [],
	};
}

function openCodeModel() {
	return {
		provider: "opencode-go",
		id: "deepseek-v4-flash",
		api: "openai-completions",
		baseUrl: "https://opencode.ai/inference/go/v1",
	};
}

test("registry summary passes the session id for the configured OpenCode candidate", async () => {
	const configured = openCodeModel();
	const fallback = { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" };
	const calls = [];
	const ctx = context([configured, fallback], async (model, _request, options) => {
		calls.push(model);
		if (model !== configured) throw new Error("configured candidate silently fell through");
		assert.equal(options.sessionId, "summary-session-385");
		assert.equal(options.cacheRetention, "none");
		assert.equal(options.transformHeaders, undefined);
		return { stopReason: "stop", content: [{ type: "text", text: "OpenCode registry summary" }] };
	});

	const result = await generateSummaryDraft(results, ctx, undefined, "opencode-go/deepseek-v4-flash");

	assert.equal(result.summary, "OpenCode registry summary");
	assert.equal(result.meta.model, "opencode-go/deepseek-v4-flash");
	assert.equal(result.meta.fallbackUsed, false);
	assert.deepEqual(calls, [configured]);
});

test("direct summary completion passes the session id and keeps provider headers", async () => {
	const model = openCodeModel();
	let calls = 0;
	const result = await generateSummaryDraft(
		results,
		context([model]),
		undefined,
		"opencode-go/deepseek-v4-flash",
		undefined,
		(_model, _request, options) => {
			calls += 1;
			assert.equal(options.sessionId, "summary-session-385");
			assert.equal(options.cacheRetention, "none");
			assert.deepEqual(options.headers, { "x-existing": "kept" });
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "OpenCode direct summary" }] });
		},
	);

	assert.equal(result.meta.model, "opencode-go/deepseek-v4-flash");
	assert.equal(calls, 1);
});

test("summary completion omits the session id when the session has none", async () => {
	const model = openCodeModel();
	const ctx = context([model], async (_model, _request, options) => {
		assert.equal(options.sessionId, undefined);
		return { stopReason: "stop", content: [{ type: "text", text: "No session summary" }] };
	});
	ctx.sessionManager = undefined;

	const result = await generateSummaryDraft(results, ctx, undefined, "opencode-go/deepseek-v4-flash");
	assert.equal(result.summary, "No session summary");
});


test("thinking summary uses native completion with session and provider-owned authentication", async () => {
	const model = { ...openCodeModel(), reasoning: true };
	let calls = 0;
	const ctx = context([model], async (_model, _request, options) => {
		calls++;
		assert.equal(options.sessionId, "summary-session-385");
		assert.equal(options.cacheRetention, "none");
		assert.equal(options.apiKey, undefined);
		assert.equal(options.headers, undefined);
		assert.equal(options.reasoning, "high");
		return { stopReason: "stop", content: [{ type: "text", text: "Thinking summary" }] };
	});
	ctx.modelRegistry.getApiKeyAndHeaders = () => { throw new Error("native completion owns authentication"); };
	const result = await generateSummaryDraft(results, ctx, undefined, "opencode-go/deepseek-v4-flash:high");
	assert.equal(result.summary, "Thinking summary");
	assert.equal(calls, 1);
});
