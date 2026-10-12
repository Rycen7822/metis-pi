import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const isolateEnvUrl = new URL("./isolate-env.mjs", import.meta.url).href;
const activityUrl = new URL("../activity.ts", import.meta.url).href;
const perplexityUrl = new URL("../perplexity.ts", import.meta.url).href;
const ollamaUrl = new URL("../ollama.ts", import.meta.url).href;

function runChild(script) {
	const child = spawnSync(process.execPath, ["--import", isolateEnvUrl, "--input-type=module"], {
		input: script,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("Perplexity missing credentials never starts an HTTP activity", () => {
	const output = runChild(`
		let fetches = 0;
		globalThis.fetch = async () => {
			fetches++;
			return new Response(JSON.stringify({ results: [] }));
		};
		const { activityMonitor } = await import(${JSON.stringify(activityUrl)});
		const { searchWithPerplexity } = await import(${JSON.stringify(perplexityUrl)});
		let error;
		try { await searchWithPerplexity("missing credentials"); }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, fetches, entries: activityMonitor.getEntries() }));
	`);
	assert.match(output.error, /Perplexity API key not found/);
	assert.equal(output.fetches, 0);
	assert.deepEqual(output.entries, []);
});

for (const operation of ["search", "fetch"]) {
	test(`Ollama ${operation} closes its activity after a malformed result envelope`, () => {
		const output = runChild(`
			process.env.OLLAMA_API_KEY = "synthetic-ollama-key";
			const requests = [];
			globalThis.fetch = async (url) => {
				requests.push(String(url));
				return new Response(JSON.stringify({ unexpected: true }));
			};
			const { activityMonitor } = await import(${JSON.stringify(activityUrl)});
			const { searchWithOllama, extractWithOllama } = await import(${JSON.stringify(ollamaUrl)});
			let error;
			try {
				${operation === "search"
					? 'await searchWithOllama("malformed search");'
					: 'await extractWithOllama("https://example.com/source", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });'}
			} catch (err) { error = err.message; }
			console.log(JSON.stringify({ error, requests, entries: activityMonitor.getEntries() }));
		`);
		assert.match(output.error, /Ollama API returned invalid response/);
		assert.deepEqual(output.requests, [`https://ollama.com/api/web_${operation}`]);
		assert.equal(output.entries.length, 1);
		assert.equal(typeof output.entries[0].endTime, "number");
		assert.equal(output.entries[0].error, output.error);
	});
}
