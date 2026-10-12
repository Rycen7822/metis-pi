import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const syntheticKey = "synthetic-plain-provider-key";
const proxySecret = "synthetic-proxy-secret";
const longProxySecret = "synthetic-long-proxy-secret-" + "q".repeat(360);
const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let agentDir, activityMonitor, searchWithSearXNG, searchWithKagi, extractWithKagi, searchWithSerpBase, searchWithBocha;
const jsonProviders = [
	["anysearch", "searchWithAnySearch", "ANYSEARCH_API_KEY", "https://api.anysearch.com/v1/search"],
	["bocha", "searchWithBocha", "BOCHA_API_KEY", "https://api.bochaai.com/v1/web-search"],
	["brave", "searchWithBrave", "BRAVE_API_KEY", "https://api.search.brave.com/res/v1/web/search"],
	["ceramic", "searchWithCeramic", "CERAMIC_API_KEY", "https://api.ceramic.ai/search"],
	["keenable", "searchWithKeenable", "KEENABLE_API_KEY", "https://api.keenable.ai/v1/search"],
	["search1api", "searchWithSearch1API", "SEARCH1API_KEY", "https://api.search1api.com/search"],
	["searchinfinity", "searchWithSearchinfinity", "SEARCHINFINITY_API_KEY", "https://torchlight.byteintlapi.com/search_api/web_search"],
	["serpapi", "searchWithSerpApi", "SERPAPI_KEY", "https://serpapi.com/search.json"],
	["serpdive", "searchWithSerpdive", "SERPDIVE_API_KEY", "https://api.serpdive.com/v1/search"],
	["serper", "searchWithSerper", "SERPER_API_KEY", "https://google.serper.dev/search"],
	["serply", "searchWithSerply", "SERPLY_API_KEY", "https://api.serply.io/v1/search"],
	["tavily", "searchWithTavily", "TAVILY_API_KEY", "https://api.tavily.com/search"],
	["valyu", "searchWithValyu", "VALYU_API_KEY", "https://api.valyu.ai/v1/search"],
	["you", "searchWithYou", "YDC_API_KEY", "https://ydc-index.io/v1/search"],
	["xcrawl", "searchWithXCrawl", "XCRAWL_API_KEY", "https://run.xcrawl.com/v1/serp"],
];

before(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-plain-contracts-"));
	Object.assign(process.env, {
		PI_CODING_AGENT_DIR: agentDir,
		SEARXNG_BASE_URL: "http://127.0.0.1:8443",
		BRAVE_BASE_URL: "https://api.search.brave.com/res/v1",
		BRAVE_API_KEY: syntheticKey,
		XCRAWL_API_KEY: syntheticKey,
		KAGI_API_KEY: syntheticKey,
		SERPBASE_API_KEY: syntheticKey,
		BOCHA_API_KEY: syntheticKey,
		TAVILY_BASE_URL: "https://api.tavily.com",
	});
	for (const [, , variable] of jsonProviders) process.env[variable] = syntheticKey;
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({
		ssrf: { allowRanges: ["127.0.0.1"] },
		searxngHeaders: { "X-Proxy-Key": `  ${proxySecret}  `, "CF-Access-Client-Secret": longProxySecret },
		searchRouting: { providers: ["xcrawl", "brave"], fallbackOn: ["transient", "quota"] },
	}));
	globalThis.fetch = async () => { throw new Error("Fixture did not provide a response"); };
	({ activityMonitor } = await import("../activity.ts"));
	({ searchWithSearXNG } = await import("../searxng.ts"));
	({ searchWithKagi, extractWithKagi } = await import("../kagi.ts"));
	({ searchWithSerpBase } = await import("../serpbase.ts"));
	({ searchWithBocha } = await import("../bocha.ts"));
});

after(async () => {
	globalThis.fetch = originalFetch;
	process.env = savedEnv;
	await rm(agentDir, { recursive: true, force: true });
});

test("configured SearXNG header secrets are redacted before clipping HTTP diagnostics", async () => {
	activityMonitor.clear();
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
		return new Response(`rejected ${longProxySecret}; proxy=${proxySecret}`, { status: 503 });
	};
	let failure;
	try { await searchWithSearXNG("secret boundary"); } catch (error) { failure = error; }
	assert.deepEqual(calls, [{
		url: "http://127.0.0.1:8443/search?q=secret+boundary&format=json",
		headers: { accept: "application/json", "x-proxy-key": proxySecret, "cf-access-client-secret": longProxySecret },
	}]);
	assert.ok(failure, "HTTP503 must fail after the recorded request");
	const entry = activityMonitor.getEntries().at(-1);
	for (const message of [failure.message, entry.error]) {
		assert.ok(message.includes("[redacted]"));
		assert.ok(!message.includes(proxySecret));
		assert.ok(!message.includes(longProxySecret.slice(0, 40)), "a clipped key prefix must not survive");
	}
	assert.equal(typeof entry.endTime, "number");
});

test("configured SearXNG header secrets are redacted from network errors", async () => {
	activityMonitor.clear();
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), secret: new Headers(init.headers).get("X-Proxy-Key") });
		throw new TypeError(`network rejected ${proxySecret}`);
	};
	let failure;
	try { await searchWithSearXNG("network boundary"); } catch (error) { failure = error; }
	assert.deepEqual(calls, [{ url: "http://127.0.0.1:8443/search?q=network+boundary&format=json", secret: proxySecret }]);
	assert.ok(failure);
	assert.match(failure.message, /network rejected \[redacted\]/);
	const entry = activityMonitor.getEntries().at(-1);
	assert.equal(entry.error, failure.message);
	assert.equal(typeof entry.endTime, "number");
});

for (const provider of ["kagi", "serpbase"]) {
	test(`${provider} semantic provider errors finish their activity entry`, async () => {
		activityMonitor.clear();
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), method: init.method ?? "GET" });
			return Response.json(provider === "kagi" ? { errors: [{ message: "provider semantic failure" }] } : { error: "provider semantic failure" });
		};
		let failure;
		try { await (provider === "kagi" ? searchWithKagi : searchWithSerpBase)("semantic"); } catch (error) { failure = error; }
		assert.equal(calls.length, 1);
		assert.equal(new URL(calls[0].url).origin, provider === "kagi" ? "https://kagi.com" : "https://api.serpbase.dev");
		assert.equal(calls[0].method, provider === "kagi" ? "POST" : "GET");
		assert.match(failure?.message ?? "", /provider semantic failure/);
		const entries = activityMonitor.getEntries();
		assert.equal(entries.length, 1);
		assert.equal(typeof entries[0].endTime, "number", "semantic rejection must terminate the operation");
		assert.match(entries[0].error ?? "", /provider semantic failure/);
	});
}

test("Kagi extraction semantic errors finish their activity entry", async () => {
	activityMonitor.clear();
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body), authorization: new Headers(init.headers).get("Authorization") });
		return Response.json({ errors: [{ message: "extract semantic failure" }] });
	};
	let failure;
	try {
		await extractWithKagi("https://example.com/page", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
	} catch (error) { failure = error; }
	assert.deepEqual(calls, [{ url: "https://kagi.com/api/v1/extract", method: "POST", body: { pages: [{ url: "https://example.com/page" }] }, authorization: `Bearer ${syntheticKey}` }]);
	assert.match(failure?.message ?? "", /extract semantic failure/);
	const entries = activityMonitor.getEntries();
	assert.equal(entries.length, 1);
	assert.equal(typeof entries[0].endTime, "number");
	assert.match(entries[0].error ?? "", /extract semantic failure/);
});

for (const cause of ["deadline", "caller"]) {
	test(`Kagi extraction ${cause} cancellation finishes with the appropriate activity state`, async () => {
		activityMonitor.clear();
		const calls = [];
		const caller = new AbortController();
		let cancellation;
		globalThis.fetch = (url, init) => {
			calls.push(String(url));
			return new Promise((resolve, reject) => {
				const keepAlive = setTimeout(() => reject(new Error("fixture did not observe cancellation")), 1000);
				const abort = () => {
					clearTimeout(keepAlive);
					reject(new DOMException("cancelled", "AbortError"));
				};
				if (cause === "caller") cancellation = setTimeout(() => caller.abort(), 5);
				if (init.signal.aborted) abort();
				else init.signal.addEventListener("abort", abort, { once: true });
			});
		};
		let failure;
		try {
			await extractWithKagi("https://example.com/page", caller.signal, {
				timeoutMs: cause === "deadline" ? 5 : 1000,
				lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			});
		} catch (error) { failure = error; }
		finally { clearTimeout(cancellation); }
		assert.deepEqual(calls, ["https://kagi.com/api/v1/extract"]);
		assert.match(failure?.message ?? "", cause === "deadline" ? /timed out/ : /^Aborted$/);
		const entry = activityMonitor.getEntries().at(-1);
		assert.equal(typeof entry.endTime, "number");
		if (cause === "deadline") assert.match(entry.error ?? "", /timed out/);
		else assert.equal(entry.error, undefined);
	});
}

for (const [provider, exported, , endpoint] of jsonProviders) {
	test(`${provider} invalid JSON diagnostics do not disclose a credential prefix`, async () => {
		activityMonitor.clear();
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: init.body });
			return new Response(`${syntheticKey} malformed`, { status: 200 });
		};
		const adapter = await import(`../${provider}.ts`);
		let failure;
		try { await adapter[exported]("parser credential boundary"); } catch (error) { failure = error; }
		assert.equal(calls.length, 1, "the parser must be reached through the adapter's request");
		const target = new URL(calls[0].url);
		assert.equal(target.origin + target.pathname, endpoint);
		assert.ok(JSON.stringify(calls).includes(syntheticKey), "the synthetic credential must reach the intended wire request");
		assert.match(failure?.message ?? "", /(?:invalid JSON|not valid JSON)/);
		assert.ok(!failure.message.includes(syntheticKey.slice(0, 10)), "native parser excerpts must not disclose a partial credential");
		assert.ok(!JSON.stringify(activityMonitor.getEntries()).includes(syntheticKey.slice(0, 10)));
	});
}

for (const provider of ["bocha", "serpbase"]) {
	test(`${provider} omitted result count uses the common five-result default`, async () => {
		const calls = [];
		const items = Array.from({ length: 10 }, (_, index) => ({ title: `Result ${index}`, url: `https://example.com/${index}`, snippet: "result" }));
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
			return Response.json(provider === "bocha" ? { code: 200, data: { webPages: { value: items } } } : { organic_results: items });
		};
		const result = await (provider === "bocha" ? searchWithBocha : searchWithSerpBase)("default count");
		assert.equal(calls.length, 1);
		assert.equal(provider === "bocha" ? calls[0].body.count : Number(new URL(calls[0].url).searchParams.get("num")), 5);
		assert.equal(result.results.length, 5);
	});
}

for (const status of [500, 429, 401]) {
	test(`XCrawl HTTP${status} routing uses transport status regardless of diagnostic prose`, async () => {
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://run.xcrawl.com/v1/serp") {
				return Response.json({ message: status === 401 ? "quota exhausted; HTTP500" : "diagnostic says HTTP401" }, { status });
			}
			return Response.json({ web: { results: [{ title: "Fallback", url: "https://example.com/fallback", description: "ok" }] } });
		};
		const { search } = await import("../search-router.ts");
		let result, failure;
		try { result = await search("transport contract", { provider: "auto" }); } catch (error) { failure = error; }
		if (status === 401) {
			assert.equal(failure?.kind, "auth");
			assert.equal(failure?.status, 401);
			assert.deepEqual(calls, ["https://run.xcrawl.com/v1/serp"]);
		} else {
			assert.equal(failure, undefined);
			assert.equal(result.provider, "brave");
			assert.deepEqual(calls, ["https://run.xcrawl.com/v1/serp", "https://api.search.brave.com/res/v1/web/search?q=transport+contract&count=5"]);
		}
	});
}

test("common result counts preserve the five-result default and the provider's ceiling", async () => {
	const { normalizeSearchResultCount } = await import("../search-result-count-normalization.ts");
	assert.equal(normalizeSearchResultCount(undefined), 5);
	assert.equal(normalizeSearchResultCount(Number.NaN), 5);
	assert.equal(normalizeSearchResultCount(0), 1);
	assert.equal(normalizeSearchResultCount(2.9), 2);
	assert.equal(normalizeSearchResultCount(100), 20);
	assert.equal(normalizeSearchResultCount(100, { max: 10 }), 10);
});

test("shared domain policy deduplicates canonical domains and gives exclusions precedence", async () => {
	const { normalizeDomainFilters, matchesDomainFilter } = await import("../domain-filter-normalization.ts");
	const filters = normalizeDomainFilters([" https://Example.COM/path ", "example.com", "example.org", "-private.example.com", "-https://private.example.com/path", "invalid"]);
	assert.deepEqual(filters, { include: ["example.com", "example.org"], exclude: ["private.example.com"] });
	assert.equal(matchesDomainFilter("https://DOCS.EXAMPLE.COM./path", filters), true);
	assert.equal(matchesDomainFilter(new URL("https://example.org"), filters), true);
	assert.equal(matchesDomainFilter("https://private.example.com", filters), false);
	assert.equal(matchesDomainFilter("https://badexample.com", filters), false);
	assert.equal(matchesDomainFilter("not a URL", filters), false);
	assert.equal(matchesDomainFilter("not a URL", normalizeDomainFilters()), true, "empty filters leave URL validation to the adapter");
});
