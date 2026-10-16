import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const isolate = new URL("./isolate-env.mjs", import.meta.url).href;
const modules = new URL("../", import.meta.url).href;
function run(script) {
	const child = spawnSync(process.execPath, ["--import", isolate, "--input-type=module"], {
		input: script, encoding: "utf8", maxBuffer: 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

for (const provider of ["brave", "searxng", "brightdata"]) {
	test(`${provider} applies the query to every included domain branch`, () => {
		const output = run(`
			const { writeFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "web-search.json"), JSON.stringify({
				searxngBaseUrl: "http://127.0.0.1:8443", ssrf: { allowRanges: ["127.0.0.1"] },
			}));
			process.env.BRAVE_API_KEY = "synthetic-brave-key";
			process.env.BRIGHTDATA_API_KEY = "synthetic-brightdata-key";
			process.env.BRIGHTDATA_SERP_ZONE = "synthetic-serp-zone";
			const calls = [];
			globalThis.fetch = async (url, init = {}) => {
				new Headers(init.headers);
				calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
				return Response.json(${JSON.stringify(provider === "brave" ? { web: { results: [{ title: "Allowed", url: "https://a.example/docs", description: "docs" }] } } : provider === "searxng" ? { results: [{ title: "Allowed", url: "https://a.example/docs", content: "docs" }] } : { organic: [{ title: "Allowed", link: "https://a.example/docs", description: "docs" }] })});
			};
			const leaf = await import(${JSON.stringify(modules)} + ${JSON.stringify(provider + ".ts")});
			await leaf[${JSON.stringify(provider === "brave" ? "searchWithBrave" : provider === "searxng" ? "searchWithSearXNG" : "searchWithBrightData")}]("sdk docs", { domainFilter: ["a.example", "b.example", "-private.a.example"], fetch: globalThis.fetch });
			console.log(JSON.stringify(calls));
		`);
		assert.equal(output.length, 1);
		const query = new URL(provider === "brightdata" ? output[0].body.url : output[0].url).searchParams.get("q");
		assert.equal(query, `sdk docs (site:a.example OR site:b.example) ${provider === "brave" ? "NOT " : "-"}site:private.a.example`);
	});
}

const mixed = [
	{ title: "Off-domain", url: "https://other.example/out", snippet: "OFF_DOMAIN_CONTENT", content: "OFF_DOMAIN_CONTENT" },
	{ title: "Allowed", url: "https://docs.example/one", snippet: "allowed content", content: "allowed content" },
	{ title: "Excluded", url: "https://private.docs.example/two", snippet: "EXCLUDED_CONTENT", content: "EXCLUDED_CONTENT" },
];
for (const provider of ["anysearch", "ollama", "kagi", "valyu"]) {
	test(`${provider} domain filtering covers results, answer and inline bodies before truncation`, () => {
		const payload = provider === "anysearch" ? { code: 0, data: { results: mixed, metadata: {} } }
			: provider === "ollama" ? { results: mixed } : provider === "valyu" ? { success: true, results: mixed } : { data: { search: mixed } };
		const output = run(`
			process.env[${JSON.stringify(provider.toUpperCase() + "_API_KEY")}] = "synthetic-provider-key";
			const calls = [];
			globalThis.fetch = async (url, init = {}) => {
				JSON.parse(init.body);
				calls.push({ headers: Object.fromEntries(new Headers(init.headers)) });
				return Response.json(${JSON.stringify(payload)});
			};
			const leaf = await import(${JSON.stringify(modules)} + ${JSON.stringify(provider + ".ts")});
			const search = leaf[${JSON.stringify("searchWith" + (provider === "anysearch" ? "AnySearch" : provider === "ollama" ? "Ollama" : provider === "valyu" ? "Valyu" : "Kagi"))}];
			const result = await search("filtered docs", { includeContent: true, numResults: 1, domainFilter: ["docs.example", "-private.docs.example"] });
			const unfiltered = await search("all docs", { includeContent: true });
			console.log(JSON.stringify({ calls, result, unfiltered }));
		`);
		assert.equal(output.calls.length, 2);
		assert.match(output.calls[0].headers.authorization ?? output.calls[0].headers["x-api-key"], /synthetic-provider-key/);
		assert.deepEqual(output.result.results.map(r => r.url), ["https://docs.example/one"]);
		assert.deepEqual(output.result.inlineContent?.map(r => r.url), ["https://docs.example/one"]);
		assert.match(output.result.answer, /allowed content/);
		assert.doesNotMatch(JSON.stringify(output.result), /OFF_DOMAIN_CONTENT|EXCLUDED_CONTENT/);
		assert.equal(output.unfiltered.results.length, 3);
	});
}

for (const provider of ["querit", "tinyfish"]) {
	test(`${provider} filters sources before paid inline-content requests`, () => {
		const output = run(`
			process.env[${JSON.stringify(provider.toUpperCase() + "_API_KEY")}] = "synthetic-content-key";
			const calls = [];
			globalThis.fetch = async (url, init) => {
				const body = init.body ? JSON.parse(init.body) : null;
				new Headers(init.headers);
			calls.push({ body });
				if (calls.length === 1) return Response.json(${JSON.stringify(provider === "querit" ? { error_code: 200, results: { result: mixed } } : { results: mixed })});
				return Response.json(${JSON.stringify(provider === "querit" ? { error_code: 200, results: [{ url: "https://docs.example/one", content: "allowed native body", extrasMeta: { title: "Allowed" } }], statuses: [] } : { results: [{ url: "https://docs.example/one", text: "allowed native body", title: "Allowed" }], errors: [] })});
			};
			const leaf = await import(${JSON.stringify(modules)} + ${JSON.stringify(provider + ".ts")});
			const result = await leaf[${JSON.stringify(provider === "querit" ? "searchWithQuerit" : "searchWithTinyFish")}]("filtered content", { includeContent: true, numResults: 1, domainFilter: ["docs.example", "-private.docs.example"] });
			console.log(JSON.stringify({ calls, result }));
		`);
		assert.equal(output.calls.length, 2);
		assert.deepEqual(output.calls[1].body.urls, ["https://docs.example/one"]);
		assert.deepEqual(output.result.results.map(r => r.url), ["https://docs.example/one"]);
		assert.deepEqual(output.result.inlineContent?.map(r => r.url), ["https://docs.example/one"]);
		assert.doesNotMatch(JSON.stringify(output.result), /OFF_DOMAIN|EXCLUDED/);
	});
}

for (const [provider, file, method] of [
	["AnySearch", "anysearch.ts", "searchWithAnySearch"],
	["Ollama", "ollama.ts", "searchWithOllama"],
	["Kimi", "kimi-search.ts", "searchWithKimi"],
	["Ceramic", "ceramic.ts", "searchWithCeramic"],
	["DuckDuckGo", "duckduckgo.ts", "searchWithDuckDuckGo"],
]) {
	test(`${provider} unsupported recency fails before credentials or a request`, () => {
		const output = run(`
			const calls = [], authReads = [];
			globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json({}); };
			const ctx = { modelRegistry: {
				getAll: () => [{ provider: "kimi-coding", id: "kimi-for-coding" }],
				getApiKeyAndHeaders: async (model) => { authReads.push(model.id); return { ok: true, apiKey: "synthetic-kimi-key", headers: {} }; },
			} };
			const leaf = await import(${JSON.stringify(modules)} + ${JSON.stringify(file)});
			let failure;
			try { await leaf[${JSON.stringify(method)}]("recent docs", { recencyFilter: "week" }, ctx); }
			catch (err) { failure = { name: err.name, message: err.message, status: err.status }; }
			console.log(JSON.stringify({ calls, authReads, failure }));
		`);
		assert.deepEqual(output.calls, []);
		assert.deepEqual(output.authReads, []);
		assert.equal(output.failure?.name, "SearchUnsupportedFilterError");
		assert.match(output.failure?.message, /recencyFilter/);
		assert.equal(output.failure?.status, undefined);
	});
}

test("Kagi v1 sends its documented date and lens domain filters", () => {
	const output = run(`
		process.env.KAGI_API_KEY = "synthetic-kagi-key";
		Date.now = () => Date.parse("2026-10-12T12:34:56Z");
		const calls = [];
		globalThis.fetch = async (url, init) => { calls.push({ body: JSON.parse(init.body) }); return Response.json({ data: { search: [] } }); };
		const { searchWithKagi } = await import(${JSON.stringify(modules)} + "kagi.ts");
		await searchWithKagi("latest docs", { recencyFilter: "week", domainFilter: ["docs.example", "-private.docs.example"] });
		console.log(JSON.stringify(calls));
	`);
	assert.equal(output.length, 1);
	assert.deepEqual(output[0].body.filters, { after: "2026-10-05" });
	assert.deepEqual(output[0].body.lens, { sites_included: ["docs.example"], sites_excluded: ["private.docs.example"] });
});

for (const provider of ["openai", "xai", "mistral"]) {
	test(`${provider} keeps only filtered sources and excludes unbound generated prose`, () => {
		const message = { type: "message", content: [{ type: "output_text", text: "OFF_DOMAIN_ANSWER near allowed citation", annotations: [
			{ type: "url_citation", url: "https://other.example/out", title: "Off-domain", start_index: 0, end_index: 4 },
			{ type: "url_citation", url: "https://docs.example/one", title: "Allowed", start_index: 15, end_index: 20 },
		] }] };
		const payload = provider === "mistral" ? { outputs: [{ type: "message.output", content: [
			{ type: "text", text: "OFF_DOMAIN_ANSWER" },
			{ type: "tool_reference", title: "Off-domain", url: "https://other.example/out", description: "OFF_DOMAIN_CONTENT" },
			{ type: "tool_reference", title: "Allowed", url: "https://docs.example/one", description: "native source description" },
		] }] } : { output: [{ type: "web_search_call" }, message] };
		const output = run(`
			process.env[${JSON.stringify(provider.toUpperCase() + "_API_KEY")}] = "synthetic-model-search-key";
			const calls = [];
			globalThis.fetch = async (url, init) => {
				JSON.parse(init.body);
				calls.push({ headers: Object.fromEntries(new Headers(init.headers)) });
				return Response.json(${JSON.stringify(payload)});
			};
			const leaf = await import(${JSON.stringify(modules)} + ${JSON.stringify(provider + "-search.ts")});
			const search = leaf[${JSON.stringify(provider === "openai" ? "searchWithOpenAI" : provider === "xai" ? "searchWithXai" : "searchWithMistral")}];
			const result = await search("filtered model docs", { domainFilter: ["docs.example"], numResults: 1 });
			const ordinary = await search("ordinary model docs");
			console.log(JSON.stringify({ calls, result, ordinary }));
		`);
		assert.equal(output.calls.length, 2);
		assert.equal(output.calls[0].headers.authorization, "Bearer synthetic-model-search-key");
		assert.deepEqual(output.result.results.map(r => r.url), ["https://docs.example/one"]);
		assert.doesNotMatch(JSON.stringify(output.result), /OFF_DOMAIN/);
		assert.match(output.ordinary.answer, /OFF_DOMAIN_ANSWER/);
		assert.equal(output.ordinary.results.length, 2);
	});
}

test("Gemini grounding applies a native paired date window and constrains domain output", () => {
	const output = run(`
		process.env.GEMINI_API_KEY = "synthetic-gemini-key";
		Date.now = () => Date.parse("2026-10-12T12:34:56Z");
		const calls = [];
		globalThis.fetch = async (url, init) => {
			new Headers(init.headers);
			calls.push({ body: JSON.parse(init.body) });
			return Response.json({ candidates: [{ content: { parts: [{ text: "OFF_DOMAIN_ANSWER" }] }, groundingMetadata: { groundingChunks: [
				{ web: { title: "Off-domain", uri: "https://other.example/out" } },
				{ web: { title: "Allowed", uri: "https://docs.example/one" } },
			] } }] });
		};
		const { searchWithGeminiApi } = await import(${JSON.stringify(modules)} + "gemini-search.ts");
		const result = await searchWithGeminiApi("latest docs", { recencyFilter: "week", domainFilter: ["docs.example"] });
		console.log(JSON.stringify({ calls, result }));
	`);
	assert.equal(output.calls.length, 1);
	assert.deepEqual(output.calls[0].body.tools[0].google_search.timeRangeFilter, { startTime: "2026-10-05T12:34:56.000Z", endTime: "2026-10-12T12:34:56.000Z" });
	assert.match(output.calls[0].body.contents[0].parts[0].text, /docs\.example/);
	assert.deepEqual(output.result.results.map(r => r.url), ["https://docs.example/one"]);
	assert.doesNotMatch(output.result.answer, /OFF_DOMAIN_ANSWER/);
});

test("Gemini ADC keeps its supported tool shape and consumes recency as a prompt hint", () => {
	const output = run(`
		const { writeFileSync } = await import("node:fs"); const { join } = await import("node:path");
		const file = join(process.env.PI_CODING_AGENT_DIR, "synthetic-adc.json");
		writeFileSync(file, JSON.stringify({ type: "authorized_user", client_id: "synthetic", client_secret: "synthetic", refresh_token: "synthetic" }));
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "web-search.json"), JSON.stringify({ geminiAuth: "adc", geminiProject: "synthetic-project", geminiLocation: "global" }));
		process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: String(url).includes("oauth2") ? Object.fromEntries(init.body) : JSON.parse(init.body) });
			return Response.json(String(url).includes("oauth2") ? { access_token: "synthetic-adc-access", expires_in: 3600 } : { candidates: [{ content: { parts: [{ text: "native answer" }] } }] });
		};
		const { searchWithGeminiApi } = await import(${JSON.stringify(modules)} + "gemini-search.ts");
		await searchWithGeminiApi("recent docs", { recencyFilter: "week" });
		console.log(JSON.stringify(calls));
	`);
	assert.equal(output.length, 2);
	assert.match(output[1].url, /aiplatform.googleapis.com/);
	assert.equal(output[1].headers.authorization, "Bearer synthetic-adc-access");
	assert.deepEqual(output[1].body.tools, [{ google_search: {} }]);
	assert.match(output[1].body.contents[0].parts[0].text, /past week/);
});

for (const routing of ["auto", "configured"]) {
	test(`${routing} routing surfaces unsupported filters without a new paid fallback`, () => {
		const output = run(`
			const { writeFileSync } = await import("node:fs"); const { join } = await import("node:path");
			writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "web-search.json"), JSON.stringify(${JSON.stringify(routing === "configured"
				? { webSearch: { allowedProviders: ["ollama", "brave"] }, searchRouting: { providers: ["ollama", "brave"], fallbackOn: ["network", "transient"] } }
				: { webSearch: { allowedProviders: ["ollama", "perplexity"] } })}));
			process.env.OLLAMA_API_KEY = "synthetic-ollama-key";
			process.env.BRAVE_API_KEY = "synthetic-brave-key"; process.env.PERPLEXITY_API_KEY = "synthetic-perplexity-key";
			const calls = [];
			globalThis.fetch = async (url, init) => {
				if (init.body) JSON.parse(init.body);
				calls.push({ url: String(url) });
				return Response.json({ results: [{ title: "Docs", url: "https://docs.example/", content: "native content" }] });
			};
			const { search } = await import(${JSON.stringify(modules)} + "search-router.ts");
			let failure;
			try { await search("strict recent request", { recencyFilter: "week" }); }
			catch (err) { failure = { name: err.name, kind: err.kind, status: err.status, message: err.message }; }
			const failedCalls = calls.slice();
			const ordinary = await search("ordinary request");
			console.log(JSON.stringify({ failure, failedCalls, calls, ordinary }));
		`);
		assert.deepEqual(output.failedCalls, []);
		assert.equal(output.failure.status, undefined);
		assert.match(output.failure.message, /recencyFilter/);
		assert.equal(output.failure.name, routing === "auto" ? "SearchUnsupportedFilterError" : "SearchProviderError");
		if (routing === "configured") assert.equal(output.failure.kind, "invalid-request");
		assert.equal(output.calls.length, 1);
		assert.equal(new URL(output.calls[0].url).host, "ollama.com");
		assert.equal(output.ordinary.provider, "ollama");
	});
}
