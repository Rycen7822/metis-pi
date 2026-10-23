import { createHome as createProviderHome, runChild } from "./provider-fixtures.mjs";

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { test } from "node:test";

const degoogModuleUrl = new URL("../degoog.ts", import.meta.url).href;
const searchModuleUrl = new URL("../search-router.ts", import.meta.url).href;
const providersModuleUrl = new URL("../search-providers.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const activityModuleUrl = new URL("../activity.ts", import.meta.url).href;

const createHome = (config = {}) => createProviderHome("pi-web-access-degoog-", config);



const DEGOOG_RESPONSE = JSON.stringify({
	results: [
		{ title: "Allowed Docs", url: "https://docs.example.com/a", snippet: "First result", source: "Brave Search" },
		{ title: "Content Fallback", url: "https://docs.example.com/b", content: "From content field" },
		{ title: "Blocked", url: "https://private.example.net/c", snippet: "blocked" },
		{ title: "Third", url: "https://docs.example.com/c", snippet: "third" },
	],
});

test("degoog posts the query with engines, recency, credentials, and domain filters", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		degoogApiKey: "$DEGOOG_TEST_KEY",
		degoogEngines: ["degoog-org-official-extensions-brave-engine", " "],
		ssrf: { allowRanges: ["127.0.0.1"] },
	});
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url, init = {}) => {
				calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
				return new Response(${JSON.stringify(DEGOOG_RESPONSE)}, { status: 200, headers: { "content-type": "application/json" } });
			};
			const { searchWithDegoog } = await import(${JSON.stringify(degoogModuleUrl)});
			const result = await searchWithDegoog("self hosted", { fetch: globalThis.fetch,
				numResults: 2,
				recencyFilter: "week",
				domainFilter: ["example.com", "-private.example.net"],
			});
			console.log(JSON.stringify({ calls, result }));
		`, {
			PI_CODING_AGENT_DIR: home,
			DEGOOG_TEST_KEY: "degoog-secret-key",
		});

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.calls.length, 1);
		assert.equal(output.calls[0].url, "http://127.0.0.1:8443/api/search");
		assert.equal(output.calls[0].method, "POST");
		assert.equal(output.calls[0].headers.Authorization, "Bearer degoog-secret-key");
		assert.equal(output.calls[0].headers.Accept, "application/json");
		assert.deepEqual(JSON.parse(output.calls[0].body), {
			query: "self hosted site:example.com -site:private.example.net",
			type: "web",
			page: 1,
			time: "week",
			engines: ["degoog-org-official-extensions-brave-engine"],
		});
		assert.deepEqual(output.result.results, [
			{ title: "Allowed Docs", url: "https://docs.example.com/a", snippet: "First result" },
			{ title: "Content Fallback", url: "https://docs.example.com/b", snippet: "From content field" },
		]);
		assert.match(output.result.answer, /Source: Allowed Docs \(https:\/\/docs\.example\.com\/a\)/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("degoog uses instance defaults when no engines are configured", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		ssrf: { allowRanges: ["127.0.0.1"] },
	});
	try {
		const child = runChild(`
			let capturedBody = null;
			globalThis.fetch = async (_url, init = {}) => {
				capturedBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
			};
			const { searchWithDegoog } = await import(${JSON.stringify(degoogModuleUrl)});
			await searchWithDegoog("plain", { fetch: globalThis.fetch });
			console.log(JSON.stringify({ capturedBody }));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()).capturedBody, { query: "plain", type: "web", page: 1 });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("degoog strips credentials and custom headers on cross-origin redirects", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		degoogApiKey: "degoog-secret-key",
		degoogHeaders: { "CF-Access-Client-Id": "client-id.access", "X-Bad-Value": "bad\r\nvalue", "Bad Name": "nope" },
		ssrf: { allowRanges: ["127.0.0.1", "127.0.0.2"] },
	});
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url, init = {}) => {
				calls.push({ url: String(url), headers: init.headers, body: init.body ?? null });
				if (calls.length === 1) {
					return new Response(null, { status: 302, headers: { location: "http://127.0.0.2:8443/api/search" } });
				}
				return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
			};
			const { searchWithDegoog } = await import(${JSON.stringify(degoogModuleUrl)});
			await searchWithDegoog("redirect", { fetch: globalThis.fetch });
			console.log(JSON.stringify({ calls }));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.deepEqual(output.calls[0].headers, {
			Accept: "application/json",
			"Content-Type": "application/json",
			"CF-Access-Client-Id": "client-id.access",
			Authorization: "Bearer degoog-secret-key",
		});
		assert.deepEqual(output.calls[1].headers, { Accept: "application/json", "Content-Type": "application/json" });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("degoog rejects invalid JSON and explains protected instances without leaking the API key", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		degoogApiKey: "degoog-secret-key",
		ssrf: { allowRanges: ["127.0.0.1"] },
	});
	try {
		const child = runChild(`
			const responses = [
				new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
				new Response(JSON.stringify({ error: "You shall not pass!" }), { status: 401, headers: { "content-type": "application/json" } }),
			];
			globalThis.fetch = async () => responses.shift();
			const { searchWithDegoog } = await import(${JSON.stringify(degoogModuleUrl)});
			const errors = [];
			for (let i = 0; i < 2; i++) {
				try { await searchWithDegoog("broken", { fetch: globalThis.fetch }); } catch (error) { errors.push(String(error)); }
			}
			console.log(JSON.stringify(errors));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		const [invalidJson, unauthorized] = JSON.parse(child.stdout.trim());
		assert.match(invalidJson, /degoog returned invalid JSON/);
		assert.match(unauthorized, /degoog search error 401/);
		assert.match(unauthorized, /degoogApiKey/);
		assert.doesNotMatch(unauthorized, /degoog-secret-key/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("degoog is explicit-only: auto and provider all never reach it", async () => {
	const home = await createHome();
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(target);
				if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
				throw new Error("Unexpected fetch " + target);
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const auto = await search("auto", { provider: "auto" });
			const all = await search("all", { provider: "all" });
			console.log(JSON.stringify({
				autoProvider: auto.provider,
				allProviders: all.providerResponses.map(result => result.provider),
				calls,
			}));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.autoProvider, "exa");
		assert.deepEqual(output.allProviders, ["exa"]);
		assert.ok(output.calls.every((url) => !url.includes("degoog")), `degoog must stay out of auto/all: ${output.calls.join(", ")}`);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("degoog transient failures fall through configured routing", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		ssrf: { allowRanges: ["127.0.0.1"] },
		tavilyApiKey: "tavily-test-key",
		searchRouting: { providers: ["degoog", "tavily"], fallbackOn: ["transient"] },
	});
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(target);
				if (target === "http://127.0.0.1:8443/api/search") return new Response("unavailable", { status: 503 });
				if (target === "https://api.tavily.com/search") return new Response(JSON.stringify({ answer: "fallback", results: [] }), { status: 200 });
				throw new Error("Unexpected fetch " + target);
			};
			const { searchWithDegoog } = await import(${JSON.stringify(degoogModuleUrl)});
			let directError = "";
			try { await searchWithDegoog("unavailable", { fetch: globalThis.fetch }); } catch (error) { directError = String(error); }
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const routed = await search("unavailable", { fetch: globalThis.fetch, provider: "auto" });
			console.log(JSON.stringify({ directError, provider: routed.provider, calls }));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.match(output.directError, /degoog search error 503/);
		assert.equal(output.provider, "tavily");
		assert.deepEqual(output.calls, [
			"http://127.0.0.1:8443/api/search",
			"http://127.0.0.1:8443/api/search",
			"https://api.tavily.com/search",
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("degoog is env-overridable and appears in the Curator", async () => {
	const home = await createHome({});
	try {
		const child = runChild(`
			const { isDegoogAvailable } = await import(${JSON.stringify(degoogModuleUrl)});
			const { RESOLVED_SEARCH_PROVIDERS, ALL_SEARCH_PROVIDERS, providerLabel } = await import(${JSON.stringify(providersModuleUrl)});
			console.log(JSON.stringify({
				availableByDefault: isDegoogAvailable(),
				resolved: RESOLVED_SEARCH_PROVIDERS.includes("degoog"),
				aggregate: ALL_SEARCH_PROVIDERS.includes("degoog"),
				label: providerLabel("degoog"),
			}));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), {
			availableByDefault: true,
			resolved: true,
			aggregate: false,
			label: "degoog",
		});

		const disabled = runChild(`
			const { isDegoogAvailable } = await import(${JSON.stringify(degoogModuleUrl)});
			console.log(JSON.stringify({ available: isDegoogAvailable() }));
		`, { PI_CODING_AGENT_DIR: home, DEGOOG_URL: "" });
		assert.equal(disabled.status, 0, disabled.stderr);
		assert.deepEqual(JSON.parse(disabled.stdout.trim()), { available: false });
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, degoog: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "degoog", "degoog", [], null);
	assert.match(page, /data-provider="degoog"/);
	assert.match(page, />degoog<\/button>/);
	const clientData = JSON.parse(page.match(/var DATA = (\{[^\n]+\});/)[1]);
	assert.equal(clientData.providerLabels.degoog, "degoog");
	assert.ok(clientData.providers.includes("degoog"));
});

test("degoog groups multi-domain clauses, drops unusable links, and deduplicates", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		ssrf: { allowRanges: ["127.0.0.1"] },
	});
	try {
		const child = runChild(`
			const bodies = [];
			globalThis.fetch = async (_url, init) => {
				bodies.push(JSON.parse(init.body));
				return new Response(JSON.stringify({ results: [
					{ title: "Allowed", url: "https://docs.example.com/a", snippet: "a" },
					{ title: "Duplicate", url: "https://docs.example.com/a", snippet: "again" },
					{ title: "Other allowed", url: "https://example.org/b", snippet: "b" },
					{ title: "Relative", url: "/relative", snippet: "r" },
					{ title: "Script", url: "javascript:alert(1)", snippet: "j" },
					{ title: "Ftp", url: "ftp://example.net/f", snippet: "f" },
					{ title: "Outside", url: "https://example.net/out", snippet: "o" },
					{ title: "Blocked", url: "https://private.example.com/p", snippet: "p" }
				] }), { status: 200, headers: { "content-type": "application/json" } });
			};
			const { searchWithDegoog } = await import(${JSON.stringify(degoogModuleUrl)});
			const filtered = await searchWithDegoog("several", { fetch: globalThis.fetch, domainFilter: ["example.com", "example.org", "-private.example.com"], numResults: 5 });
			const unfiltered = await searchWithDegoog("no filter", { fetch: globalThis.fetch, numResults: 5 });
			console.log(JSON.stringify({ bodies, filtered: filtered.results.map(r => r.url), unfiltered: unfiltered.results.map(r => r.url) }));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.bodies[0].query, "several (site:example.com OR site:example.org) -site:private.example.com");
		assert.equal(output.bodies[1].query, "no filter");
		assert.deepEqual(output.filtered, ["https://docs.example.com/a", "https://example.org/b"]);
		assert.deepEqual(output.unfiltered, [
			"https://docs.example.com/a",
			"https://example.org/b",
			"https://example.net/out",
			"https://private.example.com/p",
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a malformed degoog envelope reports invalid-response so routing can fall back", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		ssrf: { allowRanges: ["127.0.0.1"] },
		tavilyApiKey: "tavily-test-key",
		searchRouting: { providers: ["degoog", "tavily"], fallbackOn: ["invalid-response"] },
	});
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(target);
				if (target === "http://127.0.0.1:8443/api/search") return new Response(JSON.stringify({ foo: "bar" }), { status: 200, headers: { "content-type": "application/json" } });
				if (target === "https://api.tavily.com/search") return new Response(JSON.stringify({ answer: "fallback", results: [] }), { status: 200 });
				throw new Error("Unexpected fetch " + target);
			};
			const { searchWithDegoog } = await import(${JSON.stringify(degoogModuleUrl)});
			let directError = "";
			try { await searchWithDegoog("malformed", { fetch: globalThis.fetch }); } catch (error) { directError = String(error); }
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const routed = await search("malformed", { fetch: globalThis.fetch, provider: "auto" });
			console.log(JSON.stringify({ directError, provider: routed.provider, calls }));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.match(output.directError, /degoog returned invalid response: expected a results array/);
		assert.equal(output.provider, "tavily");
		assert.deepEqual(output.calls, [
			"http://127.0.0.1:8443/api/search",
			"http://127.0.0.1:8443/api/search",
			"https://api.tavily.com/search",
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("degoog redacts configured header secrets from upstream errors", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		degoogApiKey: "degoog-secret-key",
		degoogHeaders: { "CF-Access-Client-Secret": "header-secret-value", "X-Api-Key": "xyz", "X-Proxy-Secret": "  padded-secret  " },
		ssrf: { allowRanges: ["127.0.0.1"] },
	});
	try {
		const child = runChild(`
			let sentHeaders = null;
			globalThis.fetch = async (_url, init) => {
				sentHeaders = init.headers;
				return new Response("rejected header-secret-value, xyz, padded-secret! and degoog-secret-key", { status: 403 });
			};
			const { searchWithDegoog } = await import(${JSON.stringify(degoogModuleUrl)});
			const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
			let error = "";
			try { await searchWithDegoog("denied", { fetch: globalThis.fetch }); } catch (caught) { error = String(caught); }
			console.log(JSON.stringify({ sentHeaders, error, activityError: activityMonitor.getEntries().at(-1).error }));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.sentHeaders["CF-Access-Client-Secret"], "header-secret-value");
		assert.equal(output.sentHeaders["X-Proxy-Secret"], "padded-secret");
		assert.match(output.error, /degoog search error 403/);
		for (const text of [output.error, output.activityError]) {
			assert.match(text, /rejected \[redacted\], \[redacted\], \[redacted\]! and \[redacted\]/);
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("degoog records a request timeout as a failure but caller cancellation as completed", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		ssrf: { allowRanges: ["127.0.0.1"] },
	});
	try {
		const child = runChild(`
			globalThis.fetch = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
			const { searchWithDegoog } = await import(${JSON.stringify(degoogModuleUrl)});
			const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
			let timeoutError = "";
			try { await searchWithDegoog("timeout", { fetch: globalThis.fetch }); } catch (error) { timeoutError = String(error); }
			const timeoutEntry = activityMonitor.getEntries().at(-1);
			let abortError = "";
			try { await searchWithDegoog("cancelled", { fetch: globalThis.fetch, signal: AbortSignal.abort() }); } catch (error) { abortError = String(error); }
			const abortEntry = activityMonitor.getEntries().at(-1);
			console.log(JSON.stringify({
				timeoutError,
				abortError,
				timeoutEntry: { status: timeoutEntry.status, error: timeoutEntry.error },
				abortEntry: { status: abortEntry.status, error: abortEntry.error ?? null },
			}));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.match(output.timeoutError, /degoog request timed out after 30s/);
		assert.equal(output.timeoutEntry.status, null);
		assert.match(output.timeoutEntry.error, /timed out/);
		assert.equal(output.abortError, "Error: Aborted");
		assert.equal(output.abortEntry.status, 0);
		assert.equal(output.abortEntry.error, null);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an explicitly selected degoog provider searches the configured instance", async () => {
	const home = await createHome({
		degoogBaseUrl: "http://127.0.0.1:8443/",
		ssrf: { allowRanges: ["127.0.0.1"] },
	});
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				return new Response(JSON.stringify({
					results: [{ title: "degoog", url: "https://example.com/degoog", snippet: "answer" }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const response = await search("explicit", { fetch: globalThis.fetch, provider: "degoog" });
			console.log(JSON.stringify({ provider: response.provider, calls, results: response.results }));
		`, { PI_CODING_AGENT_DIR: home });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.provider, "degoog");
		assert.deepEqual(output.calls, ["http://127.0.0.1:8443/api/search"]);
		assert.deepEqual(output.results, [{ title: "degoog", url: "https://example.com/degoog", snippet: "answer" }]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
