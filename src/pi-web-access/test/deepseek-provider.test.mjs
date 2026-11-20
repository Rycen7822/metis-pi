import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";

import { searchWithDeepSeek } from "../deepseek.ts";
import { MCP_TOOL_DEFINITIONS, validateMcpToolArguments } from "../mcp-tool-definitions.ts";
import { createHome, runChild } from "./provider-fixtures.mjs";
import { createStandaloneWebToolCore } from "../standalone-web-tools.ts";

const endpoint = "https://api.deepseek.com/v1/tools/search";
const key = "synthetic-deepseek-key";
const source = {
	rerank_score: 2.4, title: "DeepSeek V4 模型发布", url: "https://example.com/v4", snippet: "短摘要",
	summary: "提供给模型的详细摘要", content: "# 原文\n\nDeepSeek 提供的网页正文。",
	site_name: "Example", site_icon: null, date: "2026-06-01T00:00:00+00:00", authority: 3,
};

async function configure(t, fileKey) {
	const home = await createHome("pi-deepseek-provider-", fileKey ? { deepseekApiKey: fileKey } : {});
	const previous = process.env;
	process.env = { ...previous, PI_CODING_AGENT_DIR: home, DEEPSEEK_API_KEY: fileKey ? "" : key };
	t.after(async () => { process.env = previous; await rm(home, { recursive: true, force: true }); });
}

test("DeepSeek maps the documented request and returns deduplicated, locally filtered sources in API order", async t => {
	await configure(t, key);
	t.mock.method(Date, "now", () => Date.parse("2026-06-08T12:00:00Z"));
	const result = await searchWithDeepSeek('  DeepSeek "V4 模型" lang:zh  ', {
		recencyFilter: "week", domainFilter: ["example.com", "example.org", "-private.example.com"],
		fetch: async (url, init) => {
			assert.equal(String(url), endpoint);
			assert.equal(init.method, "POST");
			assert.equal(init.redirect, "error");
			assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${key}`);
			assert.deepEqual(JSON.parse(init.body), {
				query: 'DeepSeek "V4 模型" lang:zh site:example.com OR site:example.org -site:private.example.com after:2026-06-01',
				count: 5, need_content: false,
			});
			return Response.json({ results: [
				source, source, { ...source, url: "https://private.example.com/data" }, { ...source, url: "https://other.test" },
				{ ...source, url: "file:///example" }, { ...source, url: "https://example.org/page", title: "Second", snippet: "" },
			] });
		},
	});
	assert.deepEqual(result.results, [
		{ title: source.title, url: source.url, snippet: source.snippet },
		{ title: "Second", url: "https://example.org/page", snippet: source.summary },
	]);
	assert.match(result.answer, /提供给模型的详细摘要/);
	assert.equal(result.inlineContent, undefined);
});

test("DeepSeek limits the final query in Unicode characters without truncating native operators", async t => {
	await configure(t);
	const query = "🔎".repeat(128);
	let calls = 0;
	const fetch = async (_url, init) => {
		calls++;
		assert.deepEqual(JSON.parse(init.body), { query, count: 20, need_content: false });
		return Response.json({ results: [] });
	};
	assert.deepEqual(await searchWithDeepSeek(query, { numResults: 20, fetch }), { results: [], answer: "" });
	await assert.rejects(searchWithDeepSeek(query, { domainFilter: ["example.com"], fetch }), /exceeds 128 Unicode characters/);
	await assert.rejects(searchWithDeepSeek(" \t\n ", { fetch }), /query must not be blank/);
	assert.equal(calls, 1);
});

test("MCP accepts DeepSeek and reuses Search API pages through stored content", async t => {
	await configure(t);
	const calls = [];
	const mock = t.mock.method(globalThis, "fetch", async (url, init) => {
		calls.push(String(url));
		assert.equal(String(url), endpoint);
		assert.deepEqual(JSON.parse(init.body), { query: "release", count: 1, need_content: true });
		return Response.json({ results: [source] });
	});
	const params = { query: "release", provider: "deepseek", numResults: 1, includeContent: true };
	const definition = MCP_TOOL_DEFINITIONS.find(tool => tool.name === "web_search");
	assert.deepEqual(validateMcpToolArguments(definition, params), []);
	const core = createStandaloneWebToolCore(globalThis.fetch);
	const result = await core.webSearch(params);
	assert.equal(result.structuredContent.queries[0].provider, "deepseek");
	assert.equal(result.structuredContent.queries[0].results[0].snippet, source.snippet);
	assert.ok(result.structuredContent.fetchId);
	const page = await core.getSearchContent({ responseId: result.structuredContent.fetchId, url: source.url });
	assert.match(page.content[0].text, /DeepSeek 提供的网页正文/);
	assert.equal(mock.mock.callCount(), 1);
	assert.deepEqual(calls, [endpoint]);
});

async function routingScenario(t, config, scenario) {
	// The router reads its preferences once per activation, so isolate each configuration in a fresh process.
	const home = await createHome("pi-deepseek-route-", { deepseekApiKey: key, ...config });
	t.after(() => rm(home, { recursive: true, force: true }));
	const router = new URL("../search-router.ts", import.meta.url).href;
	const child = runChild(`
		import assert from "node:assert/strict";
		const { search } = await import(${JSON.stringify(router)});
		const { endpoint, key, source } = ${JSON.stringify({ endpoint, key, source })};
		${scenario}
	`, { PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "synthetic-brave-key" }, { timeout: 8_000 });
	assert.equal(child.status, 0, child.error?.message ?? child.stderr);
}

test("DeepSeek is selectable but never called by unconfigured auto or all", async t => {
	await routingScenario(t, { webSearch: { allowedProviders: ["deepseek"] } }, `
		const calls = [];
		globalThis.fetch = async url => {
			calls.push(String(url));
			assert.equal(String(url), endpoint);
			return Response.json({ results: [source] });
		};
		for (const provider of ["auto", "all"]) await assert.rejects(search("release", { provider }), /No .*search provider available/i);
		assert.deepEqual(calls, []);
		assert.equal((await search("release", { provider: "deepseek" })).provider, "deepseek");
		assert.deepEqual(calls, [endpoint]);
	`);
});

test("DeepSeek preserves quota and authorization status without echoing remote diagnostics", async t => {
	await routingScenario(t, { searchRouting: { providers: ["deepseek", "brave"], fallbackOn: ["quota"] } }, `
		let status = 402;
		const calls = [];
		globalThis.fetch = async url => {
			const target = String(url);
			calls.push(target);
			if (target === endpoint) return Response.json({ error: { message: "remote diagnostic " + key } }, { status });
			assert.equal(new URL(target).origin, "https://api.search.brave.com");
			return Response.json({ web: { results: [{ title: source.title, url: source.url, description: source.snippet }] } });
		};
		assert.equal((await search("routed search")).provider, "brave");
		assert.deepEqual(calls.map(url => new URL(url).origin), ["https://api.deepseek.com", "https://api.search.brave.com"]);
		status = 401;
		calls.length = 0;
		await assert.rejects(search("routed search"), error => error.kind === "auth" && error.status === 401 && !error.message.includes(key));
		assert.deepEqual(calls, [endpoint]);
	`);
});

test("DeepSeek caller cancellation interrupts body reading without wrapping the abort as invalid JSON", { timeout: 5_000 }, async t => {
	await configure(t);
	const caller = new AbortController();
	const started = Promise.withResolvers();
	const request = searchWithDeepSeek("cancelled", {
		signal: caller.signal,
		fetch: async (_url, { signal }) => {
			const response = new Response(new ReadableStream({
				start(stream) { signal.addEventListener("abort", () => stream.error(signal.reason), { once: true }); },
			}));
			const read = response.json.bind(response);
			response.json = () => { started.resolve(); return read(); };
			return response;
		},
	});
	await started.promise;
	caller.abort();
	await assert.rejects(request, /^Error: Aborted$/);
});
