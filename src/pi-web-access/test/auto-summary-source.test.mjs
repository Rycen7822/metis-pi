import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveWebSearchWorkflow } from "../curator-run.ts";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const commandSrc = readFileSync(new URL("../tool-commands.ts", import.meta.url), "utf8");
const coreSrc = readFileSync(new URL("../web-tool-core.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("web_search accepts auto-summary workflow in schema and config resolution", () => {
	assert.match(indexSrc, /StringEnum\(\["none", "summary-review", "auto-summary"\]/);
	assert.equal(resolveWebSearchWorkflow("auto-summary", true), "auto-summary");
	assert.match(commandSrc, /arg === "none" \|\| arg === "summary-review" \|\| arg === "auto-summary"/);
});

test("auto-summary skips curator and reuses summary model fallback plumbing", () => {
	assert.match(indexSrc, /const shouldCurate = workflow === "summary-review"/);
	assert.match(indexSrc, /if \(workflow === "auto-summary"\)/);
	assert.match(indexSrc, /await loadSummaryModelChoices\(summaryContext\)/);
	assert.match(coreSrc, /workflow: call\.summarize \? "auto-summary" : undefined/);
});

test("README documents auto-summary", () => {
	assert.match(readmeSrc, /workflow: "auto-summary"/);
	assert.match(readmeSrc, /generate a summary without opening the curator/);
});

test("auto-summary defaults retain fallback and report a reached ambiguity", () => {
	for (const { ambiguous, summaryModel } of [
		{ ambiguous: false }, { ambiguous: true },
		{ ambiguous: false, summaryModel: "invalid-selector" },
	]) {
		const dir = mkdtempSync(join(tmpdir(), "metis-auto-summary-"));
		try {
			writeFileSync(join(dir, "metis-pi.toml"), '[webAccess]\nprovider = "brave"\nworkflow = "auto-summary"\n'
				+ (summaryModel ? `summaryModel = ${JSON.stringify(summaryModel)}\n` : ""));
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				input: `
					globalThis.fetch = async url => {
						if (!String(url).startsWith("https://api.search.brave.com/")) throw new Error("Unexpected fetch: " + url);
						return Response.json({ web: { results: [{ title: "Source", url: "https://example.com", description: "Evidence" }] } });
					};
					const { default: initializeExtension } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
					const tools = [];
					initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
					const native = { provider: "anthropic", id: "claude-haiku-4-5" };
					const models = [native, ...(${ambiguous}
						? ["openrouter", "requesty"].map(provider => ({ provider, id: "google/gemini-3.6-flash" }))
						: [{ provider: "google", id: "gemini-3.6-flash" }])];
					const calls = [];
					const ctx = { hasUI: false, model: native, scopedModels: [], modelRegistry: {
						getAvailable: () => models,
						find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
						complete: async model => {
							calls.push(model.provider);
							return model.provider === "anthropic" ? { stopReason: "error", errorMessage: "unavailable", content: [] }
								: { stopReason: "stop", content: [{ type: "text", text: "Fallback summary" }] };
						},
					} };
					let result;
					try {
						result = await tools.find(tool => tool.name === "web_search").execute("auto", { query: "default fallback", provider: "brave", workflow: "auto-summary" }, undefined, undefined, ctx);
					} catch (error) { result = { error: error.message }; }
					console.log(JSON.stringify({ result, calls }));
				`, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: dir, BRAVE_API_KEY: "test-key" },
			});
			assert.equal(child.status, 0, child.stderr);
			const { result, calls } = JSON.parse(child.stdout);
			if (ambiguous) {
				assert.deepEqual(calls, ["anthropic"]);
				assert.match(result.error, /Ambiguous.*google\/gemini/);
			} else {
				assert.deepEqual(calls, ["anthropic", "google"]);
				assert.match(result.content[0].text, /Fallback summary/);
			}
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}
});
