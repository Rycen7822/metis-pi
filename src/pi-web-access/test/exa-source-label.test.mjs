import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-access-exa-label-"));
delete process.env.EXA_API_KEY;
delete process.env.EXA_BASE_URL;

const { searchWithExa } = await import(new URL("../exa.ts", import.meta.url).href);
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.EXA_API_KEY;
});

const resultUrls = [
	"https://cdn.jsdelivr.net/npm/pi-web-access@0.27.0/index.ts",
	"mailto:team@example.com",
	"file:///tmp/notes.txt",
	"not-a-url",
	"https://example.com/kept",
];
const expectedTitles = ["cdn.jsdelivr.net", "Source 2", "Source 3", "Source 4", "Kept title"];

function assertLabels(result, includeContent) {
	assert.deepEqual(result.results.map((item) => item.title), expectedTitles);
	assert.deepEqual(
		result.answer.split("\n").filter((line) => line.startsWith("Source: ")),
		expectedTitles.map((title, i) => `Source: ${title} (${resultUrls[i]})`),
	);
	assert.deepEqual(
		result.inlineContent?.map(({ url, title }) => ({ url, title })),
		includeContent ? expectedTitles.map((title, i) => ({ url: resultUrls[i], title })) : undefined,
	);
}

test("keyed Exa search labels untitled results by hostname, else Source N", async () => {
	process.env.EXA_API_KEY = "exa-test-key";
	globalThis.fetch = async (url) => {
		assert.equal(String(url), "https://api.exa.ai/search");
		return Response.json({
			results: resultUrls.map((resultUrl, i) => ({
				title: i === 4 ? "Kept title" : "",
				url: resultUrl,
				highlights: [`snippet ${i + 1}`],
				text: `page ${i + 1}`,
			})),
		});
	};

	assertLabels(await searchWithExa("labels", { numResults: 10 }), false);
	assertLabels(await searchWithExa("labels", { numResults: 10, includeContent: true }), true);
});

test("keyless Exa MCP search labels untitled results by hostname, else Source N", async () => {
	const text = resultUrls
		.map((resultUrl, i) => `Title: ${i === 4 ? "Kept title" : ""}\nURL: ${resultUrl}\nText: snippet ${i + 1}`)
		.join("\n\n");
	globalThis.fetch = async (url) => {
		assert.ok(String(url).startsWith("https://mcp.exa.ai/mcp"));
		return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
	};

	assertLabels(await searchWithExa("labels"), false);
	assertLabels(await searchWithExa("labels", { includeContent: true }), true);
});
