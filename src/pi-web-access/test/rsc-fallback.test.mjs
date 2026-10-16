import assert from "node:assert/strict";
import { test } from "node:test";

import { extractContent } from "../extract.ts";
import { extractRSCContent } from "../rsc-extract.ts";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const originalFetch = globalThis.fetch;

test("weak Readability output falls back to useful RSC content", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	const article = "RSC article content survives the loading shell. ".repeat(20);
	const payload = `23:${JSON.stringify(["$", "article", null, { children: ["$", "p", null, { children: article }] }])}\n`;
	globalThis.fetch = async () => new Response(
		`<!doctype html><html><head><title>RSC article</title></head><body><article>Loading...</article><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`,
		{
			status: 200,
			headers: {
				"content-type": "text/html",
				link: '</openapi.json>; rel="service-desc"',
			},
		},
	);

	const result = await extractContent("https://example.com/rsc", undefined, { fetch: globalThis.fetch, lookup });
	assert.equal(result.error, null);
	assert.equal(result.title, "RSC article");
	assert.match(result.content, /RSC article content survives the loading shell/);
	assert.match(result.content, /https:\/\/example\.com\/openapi\.json/);
});

test("null Readability output falls back to local Defuddle extraction", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	let fetchCalls = 0;
	const article = "Useful local Defuddle fallback content with enough detail. ".repeat(20);
	globalThis.fetch = async () => {
		fetchCalls += 1;
		if (fetchCalls > 1) throw new Error("Defuddle attempted a hidden network request");
		return new Response(
			`<!doctype html><html><head><title>Defuddle article</title></head><body><aside><main>${article}</main></aside></body></html>`,
			{
				status: 200,
				headers: {
					"content-type": "text/html",
					link: '</openapi.json>; rel="service-desc"',
				},
			},
		);
	};

	const result = await extractContent("https://example.com/defuddle-null", undefined, { fetch: globalThis.fetch, lookup });
	assert.equal(fetchCalls, 1);
	assert.equal(result.error, null);
	assert.equal(result.title, "Defuddle article");
	assert.match(result.content, /Useful local Defuddle fallback content/);
	assert.match(result.content, /https:\/\/example\.com\/openapi\.json/);
});

test("Defuddle fallback resolves relative canonical URLs against the fetched URL", async (t) => {
	const originalConsoleWarn = console.warn;
	t.after(() => {
		globalThis.fetch = originalFetch;
		console.warn = originalConsoleWarn;
	});
	const article = "Defuddle content with a relative canonical URL stays quiet. ".repeat(20);
	globalThis.fetch = async () => new Response(
		`<!doctype html><html><head><title>Relative canonical</title><link rel="canonical" href="/relative-canonical"></head><body><aside><main>${article}</main></aside></body></html>`,
		{ status: 200, headers: { "content-type": "text/html" } },
	);
	const warnings = [];
	console.warn = (...args) => { warnings.push(args); };

	const result = await extractContent("https://example.com/relative-canonical", undefined, { fetch: globalThis.fetch, lookup });
	assert.equal(result.error, null);
	assert.deepEqual(warnings, []);
});

test("short Readability output falls back to useful Defuddle content", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	const article = "Useful Defuddle content after the short Readability article. ".repeat(20);
	globalThis.fetch = async () => new Response(
		`<!doctype html><html><head><title>Short article fallback</title></head><body><article>Loading...</article><aside><main>${article}</main></aside></body></html>`,
		{ status: 200, headers: { "content-type": "text/html" } },
	);

	const result = await extractContent("https://example.com/defuddle-short", undefined, { fetch: globalThis.fetch, lookup });
	assert.equal(result.error, null);
	assert.equal(result.title, "Short article fallback");
	assert.match(result.content, /Useful Defuddle content after the short Readability article/);
});

test("Defuddle processing failures stay contained and do not return the fallback body", async (t) => {
	const originalConsoleError = console.error;
	t.after(() => {
		globalThis.fetch = originalFetch;
		console.error = originalConsoleError;
	});
	const paragraph = "This is substantial article text that should be extracted as the page's main content. ";
	const html = `<!doctype html><html><head><title>Defuddle selector failure</title></head><body><nav><a href="/">Home</a></nav><template id="B:0"></template><div hidden id="S:a"><h1>Defuddle selector failure</h1><p>${paragraph.repeat(20)}</p></div><template id="P:a"></template><footer><p>Copyright 2026 Example Inc. All rights reserved.</p></footer></body></html>`;
	globalThis.fetch = async () => new Response(html, {
		status: 200,
		headers: { "content-type": "text/html" },
	});

	const consoleErrors = [];
	console.error = (...args) => { consoleErrors.push(args); };
	const result = await extractContent("https://example.com/defuddle-selector-failure", undefined, { fetch: globalThis.fetch, lookup });

	assert.equal(consoleErrors.length, 0);
	assert.match(result.error, /Defuddle failed to process document: Unknown pseudo-class :a/);
	assert.doesNotMatch(result.content, /Copyright 2026/);
});

test("short non-RSC pages remain incomplete", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	globalThis.fetch = async () => new Response(
		"<!doctype html><html><head><title>Short</title></head><body><article>Loading...</article></body></html>",
		{ status: 200, headers: { "content-type": "text/html" } },
	);

	const result = await extractContent("https://example.com/short", undefined, { fetch: globalThis.fetch, lookup });
	assert.notEqual(result.error, null);
});

test("short RSC payloads remain incomplete", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	const payload = `23:${JSON.stringify(["$", "article", null, { children: "Short RSC content" }])}\n`;
	globalThis.fetch = async () => new Response(
		`<!doctype html><html><head><title>Short RSC</title></head><body><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`,
		{ status: 200, headers: { "content-type": "text/html" } },
	);

	const result = await extractContent("https://example.com/short-rsc", undefined, { fetch: globalThis.fetch, lookup });
	assert.notEqual(result.error, null);
});

test("RSC specialized blocks preserve code, escaped cells, shared refs and cycles", () => {
	const element = (tag, children) => ["$", tag, null, { children }];
	const intro = "Introductory article evidence. ".repeat(4);
	const main = element("article", [element("p", intro), element("p", element("code", "$undefined")),
		element("pre", element("code", "const alpha = 1;")), element("table", [
			element("thead", element("tr", [element("th", "Left"), element("th", "Right")])),
			element("tbody", element("tr", [element("td", "a|b"), element("td", "c\\d")])),
		]), "$L1", "$L1", "$L2"]);
	const payload = `23:${JSON.stringify(main)}\n1:${JSON.stringify(element("p", "Shared passage."))}\n` +
		`2:${JSON.stringify(element("div", "$L2"))}\n`;
	const html = `<title>Blocks</title><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
	assert.deepEqual(extractRSCContent(html), { title: "Blocks", content: intro.trim() +
		"\n\n`$undefined`\n\n```\nconst alpha = 1;\n```\n\n" +
		"| Left | Right |\n| --- | --- |\n| a\\|b | c\\\\d |\n\nShared passage.\n\nShared passage." });
});
