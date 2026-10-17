import { stringify } from "smol-toml";
import { splitWebAccessConfig } from "../../web-access-config.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../mcp-server.ts";
import { initializeMetisConfig } from "../../metis-config.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const TOOL_NAMES = ["fetch_content", "get_search_content", "source_check", "web_search"];

function fakeCore(overrides = {}) {
	const calls = [];
	const record = (method) => async (params, signal) => {
		calls.push({ method, params });
		if (overrides[method]) return overrides[method](params, signal);
		return { content: [{ type: "text", text: `${method} ok` }], details: { method } };
	};
	return {
		calls,
		core: {
			webSearch: record("webSearch"),
			fetchContent: record("fetchContent"),
			getSearchContent: record("getSearchContent"),
			sourceCheck: record("sourceCheck"),
		},
	};
}

async function connect(t, core) {
	const server = createMcpServer(core, { name: "pi-web-access-test", version: "0.0.0" });
	const client = new Client({ name: "test-client", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	t.after(async () => { await client.close(); await server.close(); });
	return client;
}

test("tools/list exposes the four MCP tools with standalone-only input schemas", async (t) => {
	const client = await connect(t, fakeCore().core);
	const { tools } = await client.listTools();
	assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);
	for (const tool of tools) {
		assert.equal(tool.inputSchema.type, "object", tool.name);
		assert.ok(tool.description.length > 0, tool.name);
	}
	const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
	assert.deepEqual(byName.fetch_content.properties.mode.enum, ["readable", "raw"]);
	for (const piOnly of ["prompt", "answerModel", "timestamp", "frames", "model", "auth"]) {
		assert.equal(byName.fetch_content.properties[piOnly], undefined, `fetch_content exposes ${piOnly}`);
	}
	assert.equal(byName.web_search.properties.workflow, undefined);
	assert.deepEqual(byName.get_search_content.required, ["responseId"]);
	assert.deepEqual(byName.source_check.required, ["claim"]);
	const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
	const fetching = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
	assert.deepEqual(annotations, {
		web_search: fetching,
		fetch_content: fetching,
		get_search_content: { readOnlyHint: true, openWorldHint: false },
		source_check: fetching,
	});
});

test("a valid call reaches the core with its arguments and returns the core's content", async (t) => {
	const image = { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" };
	const { core, calls } = fakeCore({
		webSearch: async () => ({
			content: [{ type: "text", text: "results for a, b" }, image],
			details: { responseId: "search-1", queryCount: 2 },
		}),
	});
	const client = await connect(t, core);
	const args = { queries: ["a", "b"], numResults: 3, provider: ["brave", "exa"], recencyFilter: "week" };
	const result = await client.callTool({ name: "web_search", arguments: args });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, "webSearch");
	assert.deepEqual(calls[0].params, args);
	assert.deepEqual(result.content, [{ type: "text", text: "results for a, b" }, image]);
	// Codex shows the model structuredContent instead of content, so it must stay unset.
	assert.equal(result.structuredContent, undefined);
	assert.notEqual(result.isError, true);

	await client.callTool({ name: "get_search_content", arguments: { responseId: "search-1", findText: ["x"] } });
	assert.equal(calls[1].method, "getSearchContent");
	assert.deepEqual(calls[1].params, { responseId: "search-1", findText: ["x"] });
});

test("invalid arguments return a tool error naming the problem without calling the core", async (t) => {
	const { core, calls } = fakeCore();
	const client = await connect(t, core);
	const cases = [
		["web_search", { query: "q", numResults: 0 }, "/numResults"],
		["web_search", { query: "q", workflow: "summary-review" }, "workflow"],
		["web_search", { query: "q", provider: "bogus" }, "/provider"],
		["web_search", { query: "q", provider: "kimi" }, "/provider"],
		["web_search", { query: "q", provider: ["brave", "auto"] }, "/provider"],
		["fetch_content", { url: "https://example.com", mode: "answer" }, "/mode"],
		["fetch_content", { url: "https://example.com", prompt: "summarize" }, "prompt"],
		["get_search_content", { offset: 1 }, "responseId"],
		["source_check", { claim: 42 }, "/claim"],
	];
	for (const [name, args, mention] of cases) {
		const result = await client.callTool({ name, arguments: args });
		assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
		assert.match(result.content[0].text, new RegExp(`Invalid arguments for ${name}`));
		assert.ok(result.content[0].text.includes(mention), `${result.content[0].text} should mention ${mention}`);
	}
	assert.equal(calls.length, 0);
});

test("core failures become tool errors and core error results keep isError", async (t) => {
	const { core } = fakeCore({
		fetchContent: async () => { throw new Error("Blocked by fetch domain policy"); },
		sourceCheck: async () => ({ content: [{ type: "text", text: "No provider configured" }], details: {}, isError: true }),
	});
	const client = await connect(t, core);
	const thrown = await client.callTool({ name: "fetch_content", arguments: { url: "https://example.com" } });
	assert.equal(thrown.isError, true);
	assert.deepEqual(thrown.content, [{ type: "text", text: "Blocked by fetch domain policy" }]);

	const failed = await client.callTool({ name: "source_check", arguments: { claim: "c" } });
	assert.equal(failed.isError, true);
	assert.deepEqual(failed.content, [{ type: "text", text: "No provider configured" }]);
});

test("unknown tools are rejected as protocol errors", async (t) => {
	const { core, calls } = fakeCore();
	const client = await connect(t, core);
	await assert.rejects(client.callTool({ name: "code_search", arguments: {} }), (error) => {
		assert.equal(error.code, -32602);
		assert.match(error.message, /Unknown tool: code_search/);
		return true;
	});
	assert.equal(calls.length, 0);
});

test("client cancellation aborts the signal passed to the core", { timeout: 5_000 }, async (t) => {
	let started;
	const startedPromise = new Promise((resolve) => { started = resolve; });
	let observed;
	const abortedPromise = new Promise((resolve) => { observed = resolve; });
	const { core } = fakeCore({
		webSearch: (_params, signal) => new Promise(() => {
			signal.addEventListener("abort", () => observed(signal.aborted), { once: true });
			started(signal.aborted);
		}),
	});
	const client = await connect(t, core);
	const controller = new AbortController();
	const call = client.callTool({ name: "web_search", arguments: { query: "slow" } }, undefined, { signal: controller.signal });
	assert.equal(await startedPromise, false);
	controller.abort("user cancelled");
	await assert.rejects(call);
	assert.equal(await abortedPromise, true);
});

// The built bin runs from a directory whose node_modules mirrors the repo's
// without typebox or @earendil-works/*, proving the bundle carries typebox and
// needs no Pi packages. Metadata APIs are stubbed; page/image content uses real local HTTP.
const articleHtml = "<html><head><title>MCP Article</title></head><body><article><h1>MCP Article</h1>"
	+ "<p>" + "The MCP server fetched this readable paragraph without the Pi runtime. ".repeat(12) + "</p></article></body></html>";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const fetchMock = `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init) => {
	const url = String(input instanceof Request ? input.url : input);
	appendFileSync(process.env.MCP_TEST_REQUEST_LOG, JSON.stringify({ url, body: typeof init?.body === "string" ? init.body : undefined }) + "\\n");
	if (url.startsWith("https://api.search.brave.com/")) {
		return Response.json({ web: { results: [{ title: "MCP Article", url: process.env.MCP_TEST_ARTICLE_URL, description: "Brave snippet" }] } });
	}
	if (url === "https://api.exa.ai/search") return Response.json({ results: [] });
	throw new Error("Unexpected fetch: " + url);
};
`;

let binDir;
async function builtBinDir() {
	if (binDir) return binDir;
	const build = spawnSync("npm", ["run", "build"], { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" });
	assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-mcp-bin-"));
	await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	const cliDir = join(dir, "src", "pi-web-access", "dist");
	await mkdir(cliDir, { recursive: true });
	await copyFile(join(repoRoot, "dist", "mcp-cli.js"), join(cliDir, "mcp-cli.js"));
	for (const name of ["metis-config.ts", "web-access-config.ts"]) {
		await copyFile(join(repoRoot, "..", name), join(dir, "src", name));
	}
	for (const name of ["metis-pi.toml", "metis-pi-config.md"]) {
		await copyFile(join(repoRoot, "..", "..", name), join(dir, name));
	}
	await writeFile(join(dir, "mock-fetch.mjs"), fetchMock);
	const modules = join(dir, "node_modules");
	await mkdir(modules);
	const dependencies = join(repoRoot, "..", "..", "node_modules");
	for (const entry of await readdir(dependencies)) {
		if (entry === "typebox" || entry === "@earendil-works" || entry.startsWith(".")) continue;
		await symlink(join(dependencies, entry), join(modules, entry));
	}
	binDir = dir;
	return dir;
}
after(async () => { if (binDir) await rm(binDir, { recursive: true, force: true }); });

async function startBin(t, config) {
	const dir = await builtBinDir();
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-mcp-home-"));
	{
		const { preferences, credentials } = splitWebAccessConfig(config);
		await writeFile(join(home, "metis-pi.toml"), stringify({ webAccess: preferences }));
		await writeFile(join(home, "web-search.json"), JSON.stringify(credentials));
	}
	initializeMetisConfig(home);
	const requestLog = join(home, "requests.log");
	await writeFile(requestLog, "");
	const origin = createServer(async (request, response) => {
		const url = `http://127.0.0.1:${origin.address().port}${request.url}`;
		await appendFile(requestLog, JSON.stringify({ url, method: request.method }) + "\n");
		if (request.url === "/article") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(articleHtml);
		} else if (request.url === "/pixel.png") {
			response.writeHead(200, { "content-type": "image/png" }); response.end(png);
		} else { response.writeHead(404); response.end(); }
	});
	await new Promise(resolve => origin.listen(0, "127.0.0.1", resolve));
	t.after(async () => { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); });
	const articleUrl = `http://127.0.0.1:${origin.address().port}/article`;
	const imageUrl = `http://127.0.0.1:${origin.address().port}/pixel.png`;
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["--import", join(dir, "mock-fetch.mjs"), join(dir, "src", "pi-web-access", "dist", "mcp-cli.js")],
		cwd: dir,
		env: {
			HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "mcp-test-key", EXA_API_KEY: "mcp-test-key",
			MCP_TEST_REQUEST_LOG: requestLog, MCP_TEST_ARTICLE_URL: articleUrl,
			...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
		},
		stderr: "pipe",
	});
	const transportErrors = [];
	let stderr = "";
	transport.stderr.on("data", (chunk) => { stderr += chunk; });
	const client = new Client({ name: "mcp-e2e", version: "0.0.0" });
	client.onerror = (error) => transportErrors.push(error);
	t.after(async () => { await client.close(); await rm(home, { recursive: true, force: true }); });
	await client.connect(transport);
	return {
		client,
		articleUrl,
		imageUrl,
		transportErrors,
		stderr: () => stderr,
		requests: async () => (await readFile(requestLog, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}

const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("built pi-web-access-mcp bin runs the real tools over stdio without Pi packages", { timeout: 30_000 }, async (t) => {
	const bin = await startBin(t, { ssrf: { allowRanges: ["127.0.0.1/32"] } });
	const { client, articleUrl, imageUrl } = bin;
	assert.equal(client.getServerVersion().name, "pi-web-access");
	assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), TOOL_NAMES);

	const search = await client.callTool({ name: "web_search", arguments: { query: "mcp e2e", provider: "brave" } });
	assert.notEqual(search.isError, true, text(search));
	assert.ok(text(search).includes(`MCP Article\n   ${articleUrl}`));
	const responseId = text(search).match(/stored as responseId "([^"]+)"/)[1];
	const stored = await client.callTool({ name: "get_search_content", arguments: { responseId, queryIndex: 0 } });
	assert.notEqual(stored.isError, true, text(stored));
	assert.ok(text(stored).includes(`### MCP Article\n${articleUrl}\n\nBrave snippet`));

	const fetched = await client.callTool({ name: "fetch_content", arguments: { url: articleUrl } });
	assert.notEqual(fetched.isError, true, text(fetched));
	assert.match(text(fetched), /readable paragraph without the Pi runtime/);
	assert.doesNotMatch(text(fetched), /<p>|<article>/);

	const checked = await client.callTool({ name: "source_check", arguments: { claim: "The MCP server fetched a page", provider: "brave", fetchContent: true } });
	assert.notEqual(checked.isError, true, text(checked));
	assert.match(text(checked), /# Source check: The MCP server fetched a page[\s\S]*## Sources/);
	assert.ok(text(checked).includes(articleUrl));
	const artifactId = text(checked).match(/Artifact responseId: (\S+)/)[1];
	const evidence = await client.callTool({ name: "get_search_content", arguments: { responseId: artifactId } });
	assert.notEqual(evidence.isError, true, text(evidence));
	const artifact = JSON.parse(text(evidence));
	assert.equal(artifact.sources[0].url, articleUrl);
	assert.equal(artifact.sources[0].fetched, true);
	assert.match(artifact.sources[0].content_hash, /^sha256:[a-f0-9]{64}$/);

	await client.callTool({ name: "web_search", arguments: { query: "papers", provider: "exa", category: "research paper" } });
	const exaBody = JSON.parse((await bin.requests()).find((request) => request.url === "https://api.exa.ai/search").body);
	assert.equal(exaBody.category, "research paper");

	const requestsBefore = (await bin.requests()).length;
	const image = await client.callTool({ name: "fetch_content", arguments: { url: imageUrl } });
	assert.equal(image.isError, true);
	assert.match(text(image), /Direct image fetch is not supported over MCP/);
	assert.deepEqual((await bin.requests()).slice(requestsBefore).map((request) => request.url), [imageUrl]);

	const closeStarted = Date.now();
	await client.close();
	// StdioClientTransport sends SIGTERM only if the child is still running 2s after stdin ends.
	assert.ok(Date.now() - closeStarted < 1900, "server did not exit when stdin closed");
	// Any non-JSON-RPC stdout line would surface as a transport parse error.
	assert.deepEqual(bin.transportErrors, [], bin.stderr());
});

test("built bin lists only the tools enabled in metis-pi.toml", { timeout: 30_000 }, async (t) => {
	const { client } = await startBin(t, { webSearch: { enabled: false } });
	assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["fetch_content", "get_search_content"]);
	await assert.rejects(client.callTool({ name: "web_search", arguments: { query: "q" } }), /Unknown tool: web_search/);
});
