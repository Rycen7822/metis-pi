import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const root = await mkdtemp(join(tmpdir(), "pi-fetch-error-status-"));
process.env.PI_CODING_AGENT_DIR = root;
// Direct node --test runs should not inherit the user's fetched-content cache.
delete process.env.PI_WEB_ACCESS_CACHE_ROOT;
await writeFile(join(root, "web-search.json"), JSON.stringify({ fetchRouting: { providers: ["http"] } }));

const { default: initializeExtension } = await import("../index.ts");
const { clearResults } = await import("../storage.ts");
const tools = [];
initializeExtension({
	registerTool(tool) { tools.push(tool); },
	registerCommand() {},
	registerShortcut() {},
	on() {},
	appendEntry() {},
});
const fetchTool = tools.find(tool => tool.name === "fetch_content");
const getContentTool = tools.find(tool => tool.name === "get_search_content");
assert.ok(fetchTool);
assert.ok(getContentTool);

const goodUrl = "https://93.184.216.34/ok";
const badUrl = "https://93.184.216.34/blocked";

beforeEach(() => {
	clearResults();
	globalThis.fetch = async input => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === goodUrl || url === `${goodUrl}-also`) {
			return new Response("Fetched page body.", { headers: { "content-type": "text/plain" } });
		}
		if (url === badUrl || url === `${badUrl}-also`) return new Response("Forbidden", { status: 403 });
		throw new Error("Unexpected fetch: " + url);
	};
});

after(async () => {
	clearResults();
	globalThis.fetch = originalFetch;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await rm(root, { recursive: true, force: true });
});

test("Pi fetch_content marks a failed single URL as an error and keeps its diagnostics", async () => {
	const result = await fetchTool.execute("failed-single", { url: badUrl });
	assert.equal(result.isError, true);
	assert.equal(result.details.successful, 0);
	assert.match(result.content[0].text, /HTTP 403/);
	assert.match(result.details.error, /HTTP 403/);
	assert.ok(result.details.responseId);

	const stored = await getContentTool.execute("stored-failure", { responseId: result.details.responseId, urlIndex: 0 });
	assert.match(stored.content[0].text, /HTTP 403/);
});

test("Pi fetch_content marks a batch as an error when every URL fails", async () => {
	const result = await fetchTool.execute("failed-batch", { urls: [badUrl, `${badUrl}-also`] });
	assert.equal(result.isError, true);
	assert.equal(result.details.urlCount, 2);
	assert.equal(result.details.successful, 0);
	assert.ok(result.content[0].text.includes(badUrl));
	assert.ok(result.content[0].text.includes(`${badUrl}-also`));
	assert.equal(result.content[0].text.match(/Error - HTTP 403/g)?.length, 2);
});

test("Pi fetch_content keeps mixed batches successful and retains both outcomes", async () => {
	const result = await fetchTool.execute("mixed-batch", { urls: [goodUrl, badUrl] });
	assert.equal(result.isError, undefined);
	assert.equal(result.details.successful, 1);
	assert.match(result.content[0].text, /\(18 chars\)/);
	assert.match(result.content[0].text, /Error - HTTP 403/);

	const stored = await getContentTool.execute("stored-success", { responseId: result.details.responseId, urlIndex: 0 });
	assert.match(stored.content[0].text, /Fetched page body\.$/);
});

test("Pi fetch_content leaves a successful single URL unchanged", async () => {
	const result = await fetchTool.execute("successful-single", { url: goodUrl });
	assert.equal(result.isError, undefined);
	assert.equal(result.details.successful, 1);
	assert.equal(result.content[0].text, "Fetched page body.");
});

test("Pi fetch_content leaves a fully successful batch unchanged", async () => {
	const result = await fetchTool.execute("successful-batch", { urls: [goodUrl, `${goodUrl}-also`] });
	assert.equal(result.isError, undefined);
	assert.equal(result.details.successful, 2);
	assert.doesNotMatch(result.content[0].text, /Error -/);
});
