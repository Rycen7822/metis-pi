import { runChild } from "./provider-fixtures.mjs";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

test("web_search preserves OpenAI answers even when no sources are returned", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-answer-"));
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({
			output: [
				{ type: "web_search_call", action: { sources: [] } },
				{
					type: "message",
					content: [{ type: "output_text", text: "Direct answer without citations." }],
				},
			],
		}), { status: 200, headers: { "content-type": "application/json" } });

		const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
		const tools = [];
		initializeExtension({
			registerTool(tool) { tools.push(tool); },
			registerCommand() {},
			registerShortcut() {},
			on() {},
			appendEntry() {},
			sendMessage() {},
			exec() { return { code: 0 }; },
		});
		const webSearch = tools.find((tool) => tool.name === "web_search");
		const result = await webSearch.execute("call", {
			query: "answer only",
			provider: "openai",
			workflow: "none",
		});
		console.log(JSON.stringify({ text: result.content[0].text, details: result.details }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		OPENAI_API_KEY: "openai-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.text, /Direct answer without citations\./);
	assert.match(output.text, /No sources returned\./);
	assert.doesNotMatch(output.text, /No results found/);
	assert.equal(output.details.successfulQueries, 1);
	assert.equal(output.details.totalResults, 0);
});
