import { stringify } from "smol-toml";
import { splitWebAccessConfig } from "../../web-access-config.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const metisEntryUrl = new URL("../../../extensions/web-access.ts", import.meta.url).href;
const coreUrl = new URL("../web-tool-core.ts", import.meta.url).href;
const storageUrl = new URL("../storage.ts", import.meta.url).href;
const configUrl = new URL("../utils.ts", import.meta.url).href;

function run(script, config = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-entry-workflow-"));
	try {
		{
			const { preferences, credentials } = splitWebAccessConfig({
			webSearch: { allowedProviders: ["brave", "kagi"] },
			braveApiKey: "entry-test-brave", kagiApiKey: "entry-test-kagi",
			autoOpenBrowser: false, curatorTimeoutSeconds: 30, toolActivation: "eager",
			...config,
		});
			writeFileSync(join(dir, "metis-pi.toml"), stringify({ webAccess: preferences }));
			writeFileSync(join(dir, "web-search.json"), JSON.stringify(credentials));
		}
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: script,
			encoding: "utf8",
			timeout: 10_000,
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_WEB_ACCESS_CACHE_ROOT: dir },
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim().split("\n").at(-1));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const harness = `
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const url = String(input instanceof Request ? input.url : input);
	if (url.startsWith("https://api.search.brave.com/")) {
		return Response.json({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "source" }] } });
	}
	if (url === "https://kagi.com/api/v1/search") {
		return Response.json({ data: { search: [{ title: "Kagi", url: "https://example.com/kagi", snippet: "source" }] } });
	}
	if (["127.0.0.1", "localhost"].includes(new URL(url).hostname)) return nativeFetch(input, init);
	throw new Error("Unexpected outbound request: " + url);
};
const { default: initialize } = await import(${JSON.stringify(indexUrl)});
const instances = [];
let nextCall = 0;
function instance(branch = []) {
	const tools = new Map(), commands = new Map(), handlers = new Map();
	let reveal;
	const curatorUrl = new Promise(resolve => { reveal = resolve; });
	const show = value => {
		const url = typeof value === "string" ? value.match(/http:\\/\\/[^\\s]+/)?.[0] : value.details?.curatorUrl;
		if (url) reveal(url);
	};
	const ctx = {
		hasUI: true, modelRegistry: { getAvailable() { return []; }, find() {} },
		scopedModels: [], sessionManager: { getBranch() { return branch; } },
		cwd: process.cwd(), isProjectTrusted() { return true; },
		ui: { notify: show, setWidget() {}, theme: { fg(_name, text) { return text; } } },
	};
	initialize({
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerShortcut() {}, appendEntry() {}, sendMessage() {},
		on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
	});
	const current = {
		curatorUrl,
		tool(name) { return tools.get(name); },
		toolNames() { return [...tools.keys()]; },
		async emit(event) { for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx); },
		call(name, params, signal, onUpdate = show) { return tools.get(name).execute("entry-" + nextCall++, params, signal, onUpdate, ctx); },
		command(name, args) { return commands.get(name).handler(args, ctx); },
	};
	instances.push(current);
	return current;
}
async function urlFrom(instance) {
	let timer;
	try { return await Promise.race([instance.curatorUrl, new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error("Curator did not start")), 3000);
	})]); } finally { clearTimeout(timer); }
}
async function closeAll() { for (const current of instances) await current.emit("session_shutdown"); }
`;

test("grouped web_access continuation is executable for every stored result kind", () => {
	const out = run(`
		const { createWebToolCore, DEFAULT_TOOL_NAMES } = await import(${JSON.stringify(coreUrl)});
		const { storeResult } = await import(${JSON.stringify(storageUrl)});
		const core = createWebToolCore({
			settings: { toolNames: { ...DEFAULT_TOOL_NAMES, getSearchContent: "web_access action=content" },
				enabledTools: { webSearch: true, sourceCheck: true, fetchContent: true, getSearchContent: true },
				maxInlineContentChars: 1000, fetchModes: { defaultMode: "readable", allowedModes: ["readable"] } },
			formatStoredContentCall: args => 'tools.web_access({ action: "content", params: { ' + args + ' } })',
			storeFetchedContent: storeResult,
		});
		const content = "Stored original text. ".repeat(200);
		const fixtures = [
			{ id: "entry-fetch", type: "fetch", urls: [{ url: "https://example.com/page", title: "Page", content, error: null }] },
			{ id: "entry-search", type: "search", queries: [{ query: "Query", answer: content, results: [], error: null }] },
			{ id: "entry-research", type: "research", artifact: { id: "entry-research", type: "research", timestamp: Date.now(), query: "Claim", sources: [], passages: [], summary: content } },
		];
		const outcomes = [];
		for (const fixture of fixtures) {
			storeResult(fixture.id, { timestamp: Date.now(), ...fixture });
			const page = await core.getSearchContent({ responseId: fixture.id, queryIndex: 0, urlIndex: 0, limit: 1000 });
			const expression = page.content[0].text.match(/Use (.+) for the next slice\\./)?.[1];
			let params, error;
			try { params = Function("tools", "return " + expression)({ web_access: call => call }); }
			catch (err) { error = String(err); }
			outcomes.push({ id: fixture.id, expression, params, error });
		}
		console.log(JSON.stringify(outcomes));
	`);
	for (const result of out) {
		assert.equal(result.error, undefined, `${result.id}: ${result.expression}`);
		assert.equal(result.params.action, "content");
		assert.equal(result.params.params.responseId, result.id);
		assert.ok(result.params.params.offset > 0);
	}
});

test("Metis bundled deferred web_access executes stored-content continuation", () => {
	const out = run(harness.replace(JSON.stringify(indexUrl), JSON.stringify(metisEntryUrl)) + `
		const content = "Stored original text. ".repeat(200);
		const timestamp = Date.now();
		const fixtures = [
			{ id: "metis-fetch", type: "fetch", timestamp, urls: [{ url: "https://example.com/page", title: "Page", content, error: null }] },
			{ id: "metis-search", type: "search", timestamp, queries: [{ query: "Query", answer: content, results: [], error: null }] },
			{ id: "metis-research", type: "research", timestamp, artifact: { id: "metis-research", type: "research", timestamp, query: "Claim", sources: [], passages: [], summary: content } },
		];
		const a = instance(fixtures.map(data => ({ type: "custom", customType: "web-search-results", data })));
		await a.emit("session_start");
		try {
			const described = await a.call("web_access", { action: "describe", target: "content" });
			const outcomes = [];
			for (const fixture of fixtures) {
				const page = await a.call("web_access", { action: "content", params: { responseId: fixture.id, queryIndex: 0, urlIndex: 0, limit: 1000 } });
				const expression = page.content[0].text.match(/Use (.+) for the next slice\\./)?.[1];
				let invocation;
				const next = await Function("tools", "return " + expression)({ web_access: params => {
					invocation = params;
					return a.call("web_access", params);
				} });
				outcomes.push({ id: fixture.id, invocation, error: next.details?.error, text: next.content[0].text, action: next.details?.metisAction });
			}
			console.log(JSON.stringify({ names: a.toolNames(), exposure: a.tool("web_access").exposure, described: described.structuredContent, outcomes }));
		} finally { await closeAll(); }
	`, { maxInlineContentChars: 1000 });
	assert.deepEqual(out.names, ["web_access"]);
	assert.equal(out.exposure, "deferred");
	assert.equal(out.described.action, "content");
	assert.equal(out.described.parameters.properties.responseId.type, "string");
	for (const result of out.outcomes) {
		assert.equal(result.invocation.action, "content");
		assert.equal(result.invocation.params.responseId, result.id);
		assert.ok(result.invocation.params.offset > 0);
		assert.equal(result.error, undefined);
		assert.equal(result.action, "content");
		assert.ok(result.text.length > 0);
	}
});

for (const bundled of [false, true]) test(`${bundled ? "Metis bundled: " : ""}another instance's start, tree and shutdown leave a pending Curator open`, () => {
	const params = { query: "q", provider: "brave", workflow: "summary-review" };
	const out = run((bundled ? harness.replace(JSON.stringify(indexUrl), JSON.stringify(metisEntryUrl)) : harness) + `
		const a = instance(); await a.emit("session_start");
		const controller = new AbortController();
		const pending = a.call(${JSON.stringify(bundled ? "web_access" : "web_search")}, ${JSON.stringify(bundled ? { action: "search", params } : params)}, controller.signal);
		try {
			const url = await urlFrom(a);
			const statuses = [(await nativeFetch(url)).status];
			const b = instance();
			for (const event of ["session_start", "session_tree", "session_shutdown"]) {
				await b.emit(event);
				statuses.push(await nativeFetch(url).then(response => response.status, () => null));
			}
			console.log(JSON.stringify(statuses));
		} finally { controller.abort(); await pending; await closeAll(); }
	`);
	assert.deepEqual(out, [200, 200, 200, 200]);
});

test("cancelling one parallel Curator call leaves the other call open", () => {
	const out = run(harness + `
		const a = instance(); await a.emit("session_start");
		const controllers = [new AbortController(), new AbortController()];
		const pending = [];
		try {
			const urls = await Promise.all(controllers.map((controller, index) => new Promise(resolve => {
				pending.push(a.call("web_search", { query: "query-" + index, provider: "brave", workflow: "summary-review" }, controller.signal,
					update => { if (update.details?.curatorUrl) resolve(update.details.curatorUrl); }));
			})));
			const before = await Promise.all(urls.map(url => nativeFetch(url).then(response => response.status)));
			controllers[0].abort(); await pending[0];
			const remaining = await nativeFetch(urls[1]).then(response => response.status, () => null);
			console.log(JSON.stringify({ distinct: urls[0] !== urls[1], before, remaining }));
		} finally { controllers.forEach(controller => controller.abort()); await Promise.all(pending); await closeAll(); }
	`);
	assert.equal(out.distinct, true);
	assert.deepEqual(out.before, [200, 200]);
	assert.equal(out.remaining, 200);
});

for (const entry of ["tool", "command"]) test(`${entry} Curator cannot install a late server after its session ends`, () => {
	const out = run(harness + `
		const a = instance(); await a.emit("session_start");
		const controller = new AbortController();
		const pending = ${entry === "tool" ? 'a.call("web_search", { query: "q", provider: "brave", workflow: "summary-review" }, controller.signal)' : 'a.command("websearch", "q")'};
		try {
			await a.emit("session_shutdown");
			const outcome = await Promise.race([
				pending.then(result => ({ finished: true, cancelled: result?.details?.cancelled })),
				a.curatorUrl.then(() => ({ lateServer: true })),
			]);
			console.log(JSON.stringify(outcome));
		} finally { controller.abort(); await closeAll(); await pending; }
	`);
	assert.equal(out.lateServer, undefined);
	assert.equal(out.finished, true);
	if (entry === "tool") assert.equal(out.cancelled, true);
});

for (const entry of ["tool", "command"]) test(`${entry} Curator persists a new default over searchProvider`, () => {
	const out = run(harness + `
		const a = instance(); await a.emit("session_start");
		const controller = new AbortController();
		const pending = ${entry === "tool" ? 'a.call("web_search", { query: "q", workflow: "summary-review" }, controller.signal)' : 'a.command("websearch", "q")'};
		try {
			const url = new URL(await urlFrom(a));
			const response = await nativeFetch(new URL("/provider", url), { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: url.searchParams.get("session"), provider: "brave" }) });
			if (response.status !== 200) throw new Error("Provider update rejected: " + await response.text());
			const { loadWebAccessConfig } = await import(${JSON.stringify(configUrl)});
			for (let tries = 0; loadWebAccessConfig().provider !== "brave" && tries < 100; tries++) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			const result = await a.call("web_search", { query: "next request", workflow: "none" });
			console.log(JSON.stringify({ providers: result.details.queryProviders[0].providers }));
		} finally { controller.abort(); await closeAll(); await pending; }
	`, { searchProvider: "kagi" });
	assert.deepEqual(out.providers, ["brave"]);
});
