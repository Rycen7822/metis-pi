import "./isolate-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AmbiguousModelError, findModelWithProviderRouting } from "../summary-model-scope.ts";
import { generateSummaryDraft, loadSummaryModelChoices, SUMMARY_GENERATION_DEADLINE_MS } from "../summary-review.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const summarySrc = readFileSync(new URL("../summary-review.ts", import.meta.url), "utf8");

function summaryContext(scopedModels = []) {
	const model = { provider: "anthropic", id: "claude-haiku-4-5" };
	return {
		modelRegistry: {
			find: () => model,
			getAvailable: () => [model],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Native summary" }] }),
		},
		scopedModels,
	};
}

const summaryResults = [{
	query: "test query",
	answer: "A test answer.",
	results: [{ title: "Test source", url: "https://example.com" }],
	error: null,
	provider: "test",
}];

test("never-settling summary completion returns a deterministic deadline fallback", async () => {
	let completionSignal;
	const neverSettles = new Promise(() => {});
	const startedAt = Date.now();
	const result = await generateSummaryDraft(
		summaryResults,
		summaryContext(),
		undefined,
		undefined,
		undefined,
		(_model, _request, options) => {
			completionSignal = options.signal;
			return neverSettles;
		},
		20,
	);

	assert.ok(Date.now() - startedAt < 500);
	assert.equal(result.meta.fallbackUsed, true);
	assert.equal(result.meta.fallbackReason, "summary-generation-timeout");
	assert.equal(result.meta.phase, "deterministic-fallback");
	assert.equal(completionSignal.aborted, true);
});

test("model resolution errors after the deadline return timeout fallback", async () => {
	const context = summaryContext();
	context.modelRegistry.complete = async () => {
		await new Promise(resolve => setTimeout(resolve, 30));
		throw new Error("late auth failure");
	};

	const result = await generateSummaryDraft(
		summaryResults,
		context,
		undefined,
		undefined,
		undefined,
		undefined,
		10,
	);

	assert.equal(result.meta.fallbackUsed, true);
	assert.equal(result.meta.fallbackReason, "summary-generation-timeout");
	assert.equal(result.meta.phase, "deterministic-fallback");
});

test("caller abort takes precedence over a pending summary completion", async () => {
	const controller = new AbortController();
	const neverSettles = new Promise(() => {});
	setTimeout(() => controller.abort(), 10);

	await assert.rejects(
		() => generateSummaryDraft(
			summaryResults,
			summaryContext(),
			controller.signal,
			undefined,
			undefined,
			() => neverSettles,
			1000,
		),
		/Aborted/,
	);
});

test("summary generation only uses models in the host's resolved scope", async () => {
	const completeWith = calls => () => {
		calls.push(1);
		return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Scoped summary" }] });
	};
	const outOfScope = [];
	const excluded = await generateSummaryDraft(summaryResults, summaryContext([{ model: { provider: "openai-codex", id: "gpt-5.6-luna" } }]), undefined, undefined, undefined, completeWith(outOfScope), 1000);
	assert.equal(outOfScope.length, 0);
	assert.equal(excluded.meta.fallbackUsed, true);

	const inScope = [];
	const included = await generateSummaryDraft(summaryResults, summaryContext([{ model: { provider: "anthropic", id: "claude-haiku-4-5" } }]), undefined, undefined, undefined, completeWith(inScope), 1000);
	assert.equal(inScope.length, 1);
	assert.equal(included.meta.model, "anthropic/claude-haiku-4-5");
});

test("summary generation resolves preferred models through routed providers", async () => {
	const routedModel = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	let completeCalled = false;
	const result = await generateSummaryDraft(
		summaryResults,
		{
			modelRegistry: {
				find: () => undefined,
				getAvailable: () => [routedModel],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
			scopedModels: [],
		},
		undefined,
		undefined,
		undefined,
		() => {
			completeCalled = true;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Routed summary" }] });
		},
		1000,
	);

	assert.equal(completeCalled, true);
	assert.equal(result.meta.fallbackUsed, false);
	assert.equal(result.meta.model, "openrouter/anthropic/claude-haiku-4-5");
});

test("summaryModel thinking suffix strips before lookup and reaches completion options", async () => {
	const model = { provider: "anthropic", id: "claude-haiku-4-5", reasoning: true };
	const lookups = [];
	let options;
	const result = await generateSummaryDraft(
		summaryResults,
		{
			modelRegistry: {
				find: (provider, id) => {
					lookups.push({ provider, id });
					return model;
				},
				getAvailable: () => [],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
			scopedModels: [],
		},
		undefined,
		"anthropic/claude-haiku-4-5:low",
		undefined,
		(_model, _request, requestOptions) => {
			options = requestOptions;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Low-thinking summary" }] });
		},
		1000,
	);

	assert.ok(lookups.some(lookup => lookup.provider === "anthropic" && lookup.id === "claude-haiku-4-5"));
	assert.equal(options.reasoning, "low");
	assert.equal(options.reasoningEffort, "low");
	assert.equal(result.meta.model, "anthropic/claude-haiku-4-5");
});

test("summaryModel keeps non-thinking colons in model ids", async () => {
	const model = { provider: "openrouter", id: "nvidia/nemotron-3-super-120b-a12b:free", reasoning: true };
	const lookups = [];
	let options;
	const result = await generateSummaryDraft(
		summaryResults,
		{
			modelRegistry: {
				find: (provider, id) => {
					lookups.push({ provider, id });
					return model;
				},
				getAvailable: () => [],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
			scopedModels: [],
		},
		undefined,
		"openrouter/nvidia/nemotron-3-super-120b-a12b:free",
		undefined,
		(_model, _request, requestOptions) => {
			options = requestOptions;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Free model summary" }] });
		},
		1000,
	);

	assert.ok(lookups.some(lookup => lookup.provider === "openrouter" && lookup.id === "nvidia/nemotron-3-super-120b-a12b:free"));
	assert.equal(options.reasoning, undefined);
	assert.equal(options.reasoningEffort, undefined);
	assert.equal(result.meta.model, "openrouter/nvidia/nemotron-3-super-120b-a12b:free");
});

test("summaryModel thinking suffix omits effort for non-reasoning models", async () => {
	const model = { provider: "anthropic", id: "claude-haiku-4-5", reasoning: false };
	let options;
	await generateSummaryDraft(
		summaryResults,
		{
			modelRegistry: {
				find: () => model,
				getAvailable: () => [model],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
			scopedModels: [],
		},
		undefined,
		"anthropic/claude-haiku-4-5:low",
		undefined,
		(_model, _request, requestOptions) => {
			options = requestOptions;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "No-thinking summary" }] });
		},
		1000,
	);

	assert.equal(options.reasoning, "off");
	assert.equal(options.reasoningEffort, undefined);
});

test("preferred models resolve through routed providers", () => {
	const routedModel = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	const registry = {
		find: () => undefined,
		getAvailable: () => [routedModel],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		routedModel,
	);
});

test("model resolution preserves the direct registry fallback", () => {
	const configuredModel = { provider: "anthropic", id: "claude-haiku-4-5" };
	const registry = {
		find: () => configuredModel,
		getAvailable: () => [],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		configuredModel,
	);
});

test("multiple routes require an explicit selector regardless of catalogue order", () => {
	const firstRoute = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	const secondRoute = { provider: "requesty", id: "anthropic/claude-haiku-4-5" };
	const registry = {
		find: () => undefined,
		getAvailable: () => [firstRoute, secondRoute],
	};

	for (const routes of [[firstRoute, secondRoute], [secondRoute, firstRoute]]) {
		registry.getAvailable = () => routes;
		assert.throws(() => findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"), error => {
			assert.ok(error instanceof AmbiguousModelError);
			for (const route of routes) assert.ok(error.message.includes(`${route.provider}/${route.id}`));
			return true;
		});
		assert.equal(findModelWithProviderRouting(registry, "requesty", secondRoute.id), secondRoute);
		assert.equal(findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5", [{ model: secondRoute }]), secondRoute);
	}
	const native = { provider: "anthropic", id: "claude-haiku-4-5" };
	registry.getAvailable = () => [firstRoute, native, secondRoute];
	assert.equal(findModelWithProviderRouting(registry, native.provider, native.id), native);
});

test("ambiguous summary routes make no model call; explicit selection bypasses ambiguous defaults", async () => {
	const routes = ["openrouter", "requesty"].map(provider => ({ provider, id: "anthropic/claude-haiku-4-5" }));
	const calls = [];
	const context = {
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => routes,
			find: (provider, id) => routes.find(model => model.provider === provider && model.id === id),
			complete: async model => {
				calls.push(model.provider);
				return { stopReason: "stop", content: [{ type: "text", text: "Explicit summary" }] };
			},
		},
	};
	await assert.rejects(generateSummaryDraft(summaryResults, context), /Ambiguous.*metis-pi\.toml/);
	assert.deepEqual(calls, []);
	const generated = await generateSummaryDraft(summaryResults, context, undefined, "requesty/anthropic/claude-haiku-4-5");
	assert.equal(generated.summary, "Explicit summary");
	assert.deepEqual(calls, ["requesty"]);
	const invalid = await generateSummaryDraft(summaryResults, context, undefined, "invalid-selector");
	assert.match(invalid.meta.fallbackReason, /summary-model-settings-error: Invalid summary model/);
	assert.deepEqual(calls, ["requesty"]);
});

test("summary generation has a hard deadline and preserves caller cancellation", () => {
	assert.equal(SUMMARY_GENERATION_DEADLINE_MS, 30_000);
	assert.match(summarySrc, /Promise\.race\(contenders\)/);
	assert.match(summarySrc, /deadlineController\.abort\(\)/);
	assert.match(summarySrc, /void operation\.then\(\(\) => undefined, \(\) => undefined\)/);
});

test("unused ambiguous fallback cannot block the first default; reached ambiguity still fails", async () => {
	const native = { provider: "anthropic", id: "claude-haiku-4-5" };
	const models = [native, ...["openrouter", "requesty"].map(provider => ({ provider, id: "google/gemini-3.6-flash" }))];
	const calls = [];
	let fail = false;
	const ctx = { scopedModels: [], modelRegistry: {
		getAvailable: () => models,
		find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
		complete: async model => {
			calls.push(`${model.provider}/${model.id}`);
			return fail ? { stopReason: "error", errorMessage: "unavailable", content: [] }
				: { stopReason: "stop", content: [{ type: "text", text: "First default summary" }] };
		},
	} };
	assert.equal((await loadSummaryModelChoices(ctx)).defaultSummaryModel, "anthropic/claude-haiku-4-5");
	assert.equal((await generateSummaryDraft(summaryResults, ctx)).summary, "First default summary");
	assert.deepEqual(calls, ["anthropic/claude-haiku-4-5"]);
	fail = true;
	await assert.rejects(generateSummaryDraft(summaryResults, ctx), /Ambiguous.*google\/gemini/);
	assert.deepEqual(calls, ["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5"]);
});

async function summaryGenerationDeadline(config) {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-summary-deadline-config-"));
	try {
		if (config !== undefined) await writeFile(join(configDir, "web-search.json"), JSON.stringify(config));
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(configDir)};
				const { getSummaryGenerationDeadlineMs } = await import(${JSON.stringify(indexUrl)});
				console.log("SUMMARY_DEADLINE=" + getSummaryGenerationDeadlineMs());
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
		});
		assert.equal(child.status, 0, child.stderr);
		const matches = [...child.stdout.matchAll(/^SUMMARY_DEADLINE=(\d+)$/gm)];
		assert.equal(matches.length, 1, `Expected one summary deadline in stdout: ${JSON.stringify(child.stdout)}`);
		return Number(matches[0][1]);
	} finally {
		await rm(configDir, { recursive: true, force: true });
	}
}

test("summary generation deadline config defaults, validates, and caps", async () => {
	assert.equal(await summaryGenerationDeadline(undefined), 30_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: 150_000 }), 150_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: 0 }), 30_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: 1.5 }), 30_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: "150000" }), 30_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: 600_001 }), 600_000);
	assert.match(readmeSrc, /"summaryGenerationDeadlineMs": 30000/);
	assert.match(readmeSrc, /summaryGenerationDeadlineMs.*capped at `600000`/);
});

test("summary choices and generation prefer the same available model rather than catalogue order", async () => {
	const mini = { provider: "openai", id: "gpt-5-mini" };
	const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
	const context = summaryContext();
	context.modelRegistry.getAvailable = () => [mini, haiku];
	context.modelRegistry.find = (provider, id) => [mini, haiku].find(model => model.provider === provider && model.id === id);
	context.modelRegistry.getApiKeyAndHeaders = () => { throw new Error("native calls must not pre-authenticate"); };
	const calls = [];
	context.modelRegistry.complete = async model => {
		calls.push(model);
		return { stopReason: "stop", content: [{ type: "text", text: "complete" }] };
	};
	const choices = await loadSummaryModelChoices(context);
	assert.equal(choices.defaultSummaryModel, "anthropic/claude-haiku-4-5");
	await generateSummaryDraft(summaryResults, context);
	assert.deepEqual(calls, [haiku]);
});

test("summary error partial text is rejected while completed text succeeds", async () => {
	const context = summaryContext();
	context.modelRegistry.complete = async () => ({ stopReason: "error", errorMessage: "stream disconnected", content: [{ type: "text", text: "partial output" }] });
	const failed = await generateSummaryDraft(summaryResults, context);
	assert.equal(failed.meta.fallbackUsed, true);
	assert.equal(failed.meta.phase, "deterministic-fallback");
	assert.match(failed.meta.fallbackReason, /stream disconnected/);
	assert.notEqual(failed.summary, "partial output");
	context.modelRegistry.complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "completed output" }] });
	const successful = await generateSummaryDraft(summaryResults, context);
	assert.equal(successful.summary, "completed output");
	assert.equal(successful.meta.fallbackUsed, false);
});

test("summary empty completion has its explicit fallback reason", async () => {
	const context = summaryContext();
	context.modelRegistry.complete = async () => ({ stopReason: "stop", content: [] });
	const result = await generateSummaryDraft(summaryResults, context);
	assert.equal(result.meta.fallbackReason, "summary-model-empty-response");
	assert.equal(result.meta.phase, "deterministic-fallback");
});


test("native error wording containing abort remains failure, distinct from aborted finish", async () => {
	const context = summaryContext();
	context.modelRegistry.complete = async () => ({ stopReason: "error", errorMessage: "upstream server aborted its transaction", content: [{ type: "text", text: "partial" }] });
	const failure = await generateSummaryDraft(summaryResults, context);
	assert.equal(failure.meta.fallbackUsed, true);
	assert.match(failure.meta.fallbackReason, /upstream server aborted/);
	context.modelRegistry.complete = async () => ({ stopReason: "aborted", content: [{ type: "text", text: "partial" }] });
	await assert.rejects(generateSummaryDraft(summaryResults, context), /Aborted/);
});


async function isolatedSummaryChoices({ models, current, scopedModels = [], configured, generate = false }) {
	const configDir = await mkdtemp(join(tmpdir(), "summary-choices-"));
	try {
		await writeFile(join(configDir, "metis-pi.toml"), `[webAccess]\n${configured === undefined ? "" : `summaryModel = ${JSON.stringify(configured)}\n`}`);
		const summaryUrl = new URL("../summary-review.ts", import.meta.url).href;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const { loadSummaryModelChoices, generateSummaryDraft } = await import(${JSON.stringify(summaryUrl)});
				const models = ${JSON.stringify(models)};
				const calls = [];
				const ctx = { model: ${JSON.stringify(current)}, scopedModels: ${JSON.stringify(scopedModels)}, modelRegistry: {
					getAvailable: () => models,
					find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
					complete: async model => { calls.push(model.provider); return { stopReason: "stop", content: [{ type: "text", text: "TOML summary" }] }; },
				} };
				const result = await loadSummaryModelChoices(ctx);
				if (${generate}) {
					try { result.generated = await generateSummaryDraft(${JSON.stringify(summaryResults)}, ctx); }
					catch (error) { result.error = error.message; }
					result.calls = calls;
				}
				console.log(JSON.stringify(result));
			`, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout);
	} finally { await rm(configDir, { recursive: true, force: true }); }
}

test("summary choices retain routed thinking selectors and current-only options without using them as defaults", async () => {
	const routed = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	const current = { provider: "private", id: "current-only" };
	const choices = await isolatedSummaryChoices({ models: [routed], current, configured: "anthropic/claude-haiku-4-5:high" });
	assert.equal(choices.defaultSummaryModel, "anthropic/claude-haiku-4-5:high");
	assert.deepEqual(choices.summaryModels.map(option => option.value), ["openrouter/anthropic/claude-haiku-4-5", "private/current-only", "anthropic/claude-haiku-4-5:high"]);
	const none = await isolatedSummaryChoices({ models: [], current });
	assert.equal(none.defaultSummaryModel, null);
	assert.deepEqual(none.summaryModels.map(option => option.value), ["private/current-only"]);
	const excluded = await isolatedSummaryChoices({
		models: [routed], current, scopedModels: [{ model: routed }], configured: "invalid-selector", generate: true,
	});
	assert.equal(excluded.defaultSummaryModel, "openrouter/anthropic/claude-haiku-4-5");
	assert.deepEqual(excluded.summaryModels.map(option => option.value), ["openrouter/anthropic/claude-haiku-4-5"]);
	assert.deepEqual(excluded.calls, ["openrouter"]);
	assert.equal(excluded.generated.summary, "TOML summary");
});

test("TOML summaryModel resolves ambiguity for both choices and execution", async () => {
	const models = ["openrouter", "requesty"].map(provider => ({ provider, id: "anthropic/claude-haiku-4-5" }));
	const ambiguous = await isolatedSummaryChoices({ models, configured: "anthropic/claude-haiku-4-5", generate: true });
	assert.equal(ambiguous.defaultSummaryModel, null);
	assert.match(ambiguous.summaryModelError, /Ambiguous.*\[webAccess\]\.summaryModel/);
	assert.match(ambiguous.error, /Ambiguous/);
	assert.deepEqual(ambiguous.calls, []);
	assert.equal(ambiguous.summaryModels.length, 2);
	const explicit = await isolatedSummaryChoices({ models, configured: "requesty/anthropic/claude-haiku-4-5", generate: true });
	assert.equal(explicit.defaultSummaryModel, "requesty/anthropic/claude-haiku-4-5");
	assert.equal(explicit.summaryModelError, undefined);
	assert.deepEqual(explicit.calls, ["requesty"]);
	assert.equal(explicit.generated.summary, "TOML summary");
	const excluded = await isolatedSummaryChoices({
		models, configured: "requesty/anthropic/claude-haiku-4-5",
		scopedModels: [{ model: models[0] }], generate: true,
	});
	assert.equal(excluded.defaultSummaryModel, null);
	assert.match(excluded.summaryModelError, /not available or enabled/);
	assert.deepEqual(excluded.calls, []);
});
