import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const isolate = new URL("./isolate-env.mjs", import.meta.url).href;
const modules = new URL("../", import.meta.url).href;
function run(script) {
	const child = spawnSync(process.execPath, ["--import", isolate, "--input-type=module"], {
		input: script, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

for (const [operation, delayBody] of [["search", false], ["ask", true]]) {
	test(`Perplexity ${operation} deadline covers ${delayBody ? "the response body" : "waiting for headers"}`, () => {
		const output = run(`
			const { createServer } = await import("node:http");
			process.env.PERPLEXITY_API_KEY = "synthetic-perplexity-key";
			const packets = [], calls = [], deadlines = [];
			const server = createServer(async (req, res) => {
				let body = ""; for await (const part of req) body += part;
				JSON.parse(body);
				packets.push({ method: req.method, headers: req.headers });
				${delayBody ? 'res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders();' : ""}
				setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ results: [], choices: [{ message: { content: "late answer" } }] })); }, 250);
			});
			await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
			const origin = "http://127.0.0.1:" + server.address().port;
			const nativeFetch = globalThis.fetch, nativeTimeout = AbortSignal.timeout;
			AbortSignal.timeout = ms => { deadlines.push(ms); return nativeTimeout(100); };
			globalThis.fetch = (url, init) => {
				calls.push({ hasSignal: !!init.signal });
				return nativeFetch(origin + new URL(url).pathname, init);
			};
			const { searchWithPerplexity, askPerplexity } = await import(${JSON.stringify(modules)} + "perplexity.ts");
			const { activityMonitor } = await import(${JSON.stringify(modules)} + "activity.ts");
			let failure, result;
			try { result = await ${operation === "search" ? "searchWithPerplexity" : "askPerplexity"}("slow local request"); }
			catch (err) { failure = { name: err.name, message: err.message }; }
			const entries = activityMonitor.getEntries();
			server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
			console.log(JSON.stringify({ packets, calls, deadlines, failure, result, entries }));
		`);
		assert.equal(output.packets.length, 1);
		assert.equal(output.packets[0].headers.authorization, "Bearer synthetic-perplexity-key");
		assert.equal(output.packets[0].method, "POST");
		assert.equal(output.calls[0].hasSignal, true);
		assert.deepEqual(output.deadlines, [60_000]);
		assert.match(output.failure?.message ?? "", /Perplexity request timed out after 60s/);
		assert.equal(output.result, undefined);
		assert.equal(output.entries.length, 1);
		assert.equal(output.entries[0].error, output.failure.message);
		assert.equal(typeof output.entries[0].endTime, "number");
	});
}

test("Perplexity caller cancellation stays an abort and closes its activity", () => {
	const output = run(`
		process.env.PERPLEXITY_API_KEY = "synthetic-perplexity-key";
		const calls = [], controller = new AbortController();
		globalThis.fetch = async (url, init) => {
			JSON.parse(init.body);
			calls.push({ headers: Object.fromEntries(new Headers(init.headers)) });
			return await new Promise((resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
				controller.abort(new DOMException("caller cancelled", "AbortError"));
			});
		};
		const { searchWithPerplexity } = await import(${JSON.stringify(modules)} + "perplexity.ts");
		const { activityMonitor } = await import(${JSON.stringify(modules)} + "activity.ts");
		let failure;
		try { await searchWithPerplexity("cancel local request", { signal: controller.signal }); }
		catch (err) { failure = { name: err.name, message: err.message }; }
		console.log(JSON.stringify({ calls, failure, entries: activityMonitor.getEntries() }));
	`);
	assert.equal(output.calls.length, 1);
	assert.equal(output.calls[0].headers.authorization, "Bearer synthetic-perplexity-key");
	assert.match(output.failure?.message ?? "", /Aborted|abort|cancel/i);
	assert.equal(output.entries[0].status, 0);
	assert.equal(typeof output.entries[0].endTime, "number");
});

const providers = [
	{ file: "parallel", method: "searchWithParallel", env: "PARALLEL_API_KEY", header: "x-api-key", payload: { results: [{ title: "Docs", url: "https://docs.example/", excerpts: ["native snippet"] }] } },
	{ file: "tinyfish", method: "searchWithTinyFish", env: "TINYFISH_API_KEY", header: "x-api-key", payload: { results: [{ title: "Docs", url: "https://docs.example/", snippet: "native snippet" }] } },
	{ file: "serper", method: "searchWithSerper", env: "SERPER_API_KEY", header: "x-api-key", payload: { organic: [{ title: "Docs", link: "https://docs.example/", snippet: "native snippet" }] } },
	{ file: "serpapi", method: "searchWithSerpApi", env: "SERPAPI_KEY", query: "api_key", payload: { organic_results: [{ title: "Docs", link: "https://docs.example/", snippet: "native snippet" }] } },
	{ file: "serpbase", method: "searchWithSerpBase", env: "SERPBASE_API_KEY", query: "api_key", payload: { organic_results: [{ title: "Docs", link: "https://docs.example/", snippet: "native snippet" }] } },
	{ file: "xai-search", method: "searchWithXai", env: "XAI_API_KEY", header: "x-tenant-key", registry: true, payload: { output: [{ type: "web_search_call", action: { sources: [{ title: "Docs", url: "https://docs.example/" }] } }, { type: "message", content: [{ type: "output_text", text: "native answer" }] }] } },
	{ file: "valyu", method: "searchWithValyu", env: "VALYU_API_KEY", header: "x-api-key", payload: { success: true, results: [{ title: "Docs", url: "https://docs.example/", content: "native snippet" }] } },
	{ file: "kimi-search", method: "searchWithKimi", header: "x-tenant-key", registry: "kimi", payload: { search_results: [{ title: "Docs", url: "https://docs.example/", snippet: "native snippet" }] } },
	{ file: "gemini-search", method: "searchWithGeminiApi", env: "GEMINI_API_KEY", header: "x-goog-api-key", payload: { candidates: [{ content: { parts: [{ text: "native answer" }] }, groundingMetadata: { groundingChunks: [{ web: { title: "Docs", uri: "https://docs.example/" } }] } }] } },
];

for (const provider of providers) {
	for (const foreign of [true, false]) {
		test(`${provider.file} ${foreign ? "strips credentials at a foreign origin" : "keeps credentials for same-origin redirects"}`, () => {
			const output = run(`
				const { createServer } = await import("node:http");
				${provider.env ? `process.env[${JSON.stringify(provider.env)}] = "synthetic-redirect-key";` : ""}
				const packets = [];
				let originA, originB;
				const handler = async (req, res) => {
					let body = ""; for await (const part of req) body += part;
					packets.push({ port: req.socket.localPort, method: req.method, url: req.url, headers: req.headers, body });
					if (!req.url.startsWith("/landing")) {
						const path = "/landing" + new URL(req.url, originA).search;
						res.writeHead(307, { location: ${foreign ? "originB + path" : "path"} }); res.end();
					} else { res.setHeader("Content-Type", "application/json"); res.end(${JSON.stringify(JSON.stringify(provider.payload))}); }
				};
				const a = createServer(handler), b = createServer(handler);
				await new Promise(resolve => a.listen(0, "127.0.0.1", resolve));
				await new Promise(resolve => b.listen(0, "127.0.0.1", resolve));
				originA = "http://127.0.0.1:" + a.address().port; originB = "http://127.0.0.1:" + b.address().port;
				const nativeFetch = globalThis.fetch;
				globalThis.fetch = (url, init) => {
					const target = new URL(url);
					const mapped = target.hostname === "127.0.0.1" ? target.href : originA + target.pathname + target.search;
					return nativeFetch(mapped, init);
				};
				const leaf = await import(${JSON.stringify(modules)} + ${JSON.stringify(provider.file + ".ts")});
				const ctx = ${provider.registry ? '{ modelRegistry: { find: (provider, id) => ({ provider, id }), getAll: () => [{ provider: "kimi-coding", id: "kimi-for-coding" }], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-redirect-key", headers: { "X-Tenant-Key": "synthetic-redirect-key" } }) } }' : "undefined"};
				const result = await leaf[${JSON.stringify(provider.method)}]("redirect docs", { numResults: 1 }, ctx);
				a.closeAllConnections(); b.closeAllConnections();
				await Promise.all([new Promise(resolve => a.close(resolve)), new Promise(resolve => b.close(resolve))]);
				console.log(JSON.stringify({ packets, result }));
			`);
			assert.equal(output.packets.length, 2);
			const first = output.packets[0], second = output.packets[1];
			const credential = packet => provider.header ? packet.headers[provider.header] : new URL(packet.url, "http://fixture").searchParams.get(provider.query);
			assert.equal(credential(first), "synthetic-redirect-key");
			if (foreign) {
				assert.notEqual(first.port, second.port);
				assert.ok(!credential(second), JSON.stringify(second));
			} else {
				assert.equal(first.port, second.port);
				assert.equal(credential(second), "synthetic-redirect-key");
			}
			assert.equal(second.method, first.method);
			assert.equal(second.body, first.body);
			assert.deepEqual(output.result.results.map(r => r.url), ["https://docs.example/"]);
		});
	}
}

for (const type of ["authorized_user", "service_account"]) {
	test(`Gemini ADC ${type} exchange never forwards its credential body through a redirect`, () => {
		const output = run(`
			const { createServer } = await import("node:http");
			const { writeFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			const { generateKeyPairSync } = await import("node:crypto");
			const packets = [];
			let originA, originB;
			const handler = async (req, res) => {
				let body = ""; for await (const part of req) body += part;
				packets.push({ port: req.socket.localPort, method: req.method, url: req.url, headers: req.headers, body: Object.fromEntries(new URLSearchParams(body)) });
				if (req.url !== "/landing") { res.writeHead(307, { location: originB + "/landing" }); res.end(); }
				else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ access_token: "synthetic-adc-access", expires_in: 3600 })); }
			};
			const a = createServer(handler), b = createServer(handler);
			await new Promise(resolve => a.listen(0, "127.0.0.1", resolve));
			await new Promise(resolve => b.listen(0, "127.0.0.1", resolve));
			originA = "http://127.0.0.1:" + a.address().port; originB = "http://127.0.0.1:" + b.address().port;
			const file = join(process.env.PI_CODING_AGENT_DIR, "synthetic-adc.json");
			const privateKey = ${type === "service_account" ? 'generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" })' : "undefined"};
			writeFileSync(file, JSON.stringify({ type: ${JSON.stringify(type)}, client_id: "synthetic-client", client_secret: "synthetic-client-secret", refresh_token: "synthetic-refresh", client_email: "synthetic@example.test", private_key: privateKey }));
			process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
			const nativeFetch = globalThis.fetch;
			globalThis.fetch = (url, init) => nativeFetch(new URL(url).hostname === "127.0.0.1" ? url : originA + "/token", init);
			const { getAdcAccessToken } = await import(${JSON.stringify(modules)} + "gemini-adc.ts");
			let token, failure;
			try { token = await getAdcAccessToken(); } catch (err) { failure = err.message; }
			a.closeAllConnections(); b.closeAllConnections();
			await Promise.all([new Promise(resolve => a.close(resolve)), new Promise(resolve => b.close(resolve))]);
			console.log(JSON.stringify({ packets, token, failure }));
		`);
		assert.equal(output.packets.length, 1, JSON.stringify(output.packets));
		assert.equal(output.packets[0].method, "POST");
		if (type === "authorized_user") assert.equal(output.packets[0].body.refresh_token, "synthetic-refresh");
		else assert.equal(output.packets[0].body.assertion.split(".").length, 3);
		assert.equal(output.token, undefined);
		assert.ok(output.failure);
	});
}

for (const [foreign, status] of [[true, 302], [false, 302], [false, 303]]) {
	test(`Firecrawl configured loopback ${foreign ? "cannot authorize another loopback origin" : `keeps its existing POST and body after ${status}`}`, () => {
		const output = run(`
			const { createServer } = await import("node:http");
			const packets = [];
			let originA, originB;
			const handler = async (req, res) => {
				let body = ""; for await (const part of req) body += part;
				packets.push({ port: req.socket.localPort, method: req.method, url: req.url, headers: req.headers, body });
				if (req.url !== "/landing") { res.writeHead(${status}, { location: ${foreign ? "originB" : "originA"} + "/landing" }); res.end(); }
				else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ success: true, data: { markdown: "native redirected page" } })); }
			};
			const a = createServer(handler), b = createServer(handler);
			await new Promise(resolve => a.listen(0, "127.0.0.1", resolve));
			await new Promise(resolve => b.listen(0, "127.0.0.1", resolve));
			originA = "http://127.0.0.1:" + a.address().port; originB = "http://127.0.0.1:" + b.address().port;
			process.env.FIRECRAWL_BASE_URL = originA; process.env.FIRECRAWL_API_KEY = "synthetic-firecrawl-key";
			const { extractWithFirecrawl } = await import(${JSON.stringify(modules)} + "firecrawl.ts");
			let result, failure;
			try { result = await extractWithFirecrawl("https://docs.example/", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] }); }
			catch (err) { failure = err.message; if (err.cause) failure += ": " + String(err.cause); }
			a.closeAllConnections(); b.closeAllConnections();
			await Promise.all([new Promise(resolve => a.close(resolve)), new Promise(resolve => b.close(resolve))]);
			console.log(JSON.stringify({ packets, result, failure }));
		`);
		assert.notEqual(output.packets.length, 0, JSON.stringify(output));
		assert.equal(output.packets[0].headers.authorization, "Bearer synthetic-firecrawl-key");
		assert.equal(output.packets[0].method, "POST");
		assert.equal(JSON.parse(output.packets[0].body).url, "https://docs.example/");
		if (foreign) {
			assert.equal(output.packets.length, 1);
			assert.match(output.failure ?? "", /Blocked internal address/);
		} else {
			assert.equal(output.packets.length, 2);
			assert.equal(output.packets[1].method, "POST");
			assert.equal(output.packets[1].body, output.packets[0].body);
			assert.equal(output.packets[1].headers["content-type"], "application/json");
			assert.equal(output.packets[1].headers.authorization, "Bearer synthetic-firecrawl-key");
			assert.match(output.result?.content ?? "", /native redirected page/);
		}
	});
}

for (const [status, foreign] of [[302, false], [303, false], [307, true]]) {
	test(`Unlocker keeps its existing POST and body after ${status}${foreign ? " while stripping foreign-origin auth" : ""}`, () => {
		const output = run(`
			const { createServer } = await import("node:http");
			const { fetch: nativeFetch } = await import("undici");
			const packets = [], calls = [];
			let originA, originB;
			const handler = async (req, res) => {
				let body = ""; for await (const part of req) body += part;
				packets.push({ port: req.socket.localPort, method: req.method, url: req.url, headers: req.headers, body });
				if (req.url !== "/landing") { res.writeHead(${status}, { location: ${foreign ? 'originB + "/landing"' : '"/landing"'} }); res.end(); }
				else res.end("native unlocked body " + "x".repeat(800));
			};
			const a = createServer(handler), b = createServer(handler);
			await new Promise(resolve => a.listen(0, "127.0.0.1", resolve));
			await new Promise(resolve => b.listen(0, "127.0.0.1", resolve));
			originA = "http://127.0.0.1:" + a.address().port; originB = "http://127.0.0.1:" + b.address().port;
			process.env.BRIGHTDATA_API_KEY = "synthetic-unlocker-key"; process.env.BRIGHTDATA_UNLOCKER_ZONE = "synthetic_zone";
			const injectedFetch = (url, init) => {
				const target = new URL(url); calls.push({ redirect: init.redirect });
				return nativeFetch(target.hostname === "127.0.0.1" ? url : originA + target.pathname, init);
			};
			const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(modules)} + "brightdata-unlocker.ts");
			const result = await extractWithBrightDataUnlocker("https://docs.example/", undefined, {
				fetch: injectedFetch, lookup: async () => [{ address: "127.0.0.1", family: 4 }], ssrf: { allowRanges: ["127.0.0.1"], trustEnvProxy: false },
			});
			a.closeAllConnections(); b.closeAllConnections();
			await Promise.all([new Promise(resolve => a.close(resolve)), new Promise(resolve => b.close(resolve))]);
			console.log(JSON.stringify({ packets, calls, result }));
		`);
		assert.equal(output.packets.length, 2);
		assert.equal(output.packets[0].headers.authorization, "Bearer synthetic-unlocker-key");
		assert.equal(output.packets[1].headers.authorization, foreign ? undefined : "Bearer synthetic-unlocker-key");
		assert.equal(output.packets[1].method, "POST");
		assert.equal(output.packets[1].body, output.packets[0].body);
		assert.equal(output.packets[1].headers["content-type"], "application/json");
		assert.ok(output.calls.every(call => call.redirect === "manual"));
		assert.match(output.result.content, /native unlocked body/);
	});
}
