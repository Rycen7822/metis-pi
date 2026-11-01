import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

import initializeExtension from "../index.ts";

function getTool(name) {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find(tool => tool.name === name);
}

const theme = {
	bold: text => text,
	fg: (_name, text) => text,
	bg: (_name, text) => text,
};

test("fetch_content renderCall falls back to url when urls is empty", () => {
	const tool = getTool("fetch_content");
	const lines = tool.renderCall({
		url: "https://example.com/docs",
		urls: [],
		frames: 1,
		prompt: "",
		model: "",
	}, theme).render(120).map(line => line.trimEnd());

	assert.deepEqual(lines, ["fetch 1 URL", "  https://example.com/docs"]);
});

test("fetch_content renderCall tolerates invalid normalized parameters", () => {
	const tool = getTool("fetch_content");
	for (const args of [{ auth: 1 }, { mode: "invalid" }, { proxy: null }]) {
		const lines = tool.renderCall(args, theme).render(120).map(line => line.trimEnd());
		assert.deepEqual(lines, ["fetch", "  (invalid parameters)"]);
	}
});

test("search queries and fetch URLs remain complete in wide tool-call labels", () => {
	const query = "Google Cloud API key best practices restrict HTTP referrers and APIs";
	const url = "https://developers.google.com/maps/api-security-best-practices";
	assert.deepEqual(getTool("web_search").renderCall({ query }, theme).render(200).map(line => line.trimEnd()), [
		"search 1 query", `  "${query}"`,
	]);
	assert.deepEqual(getTool("fetch_content").renderCall({ url }, theme).render(200).map(line => line.trimEnd()), [
		"fetch 1 URL", `  ${url}`,
	]);
	assert.deepEqual(getTool("web_search").renderCall({ queries: [query, query] }, theme).render(200).map(line => line.trimEnd()), [
		"search 2 queries", `  "${query}"`, `  "${query}"`,
	]);
	assert.deepEqual(getTool("fetch_content").renderCall({ urls: [url, `${url}?ref=docs`] }, theme).render(200).map(line => line.trimEnd()), [
		"fetch 2 URLs", `  ${url}`, `  ${url}?ref=docs`,
	]);
});

const longUrl = "https://example.com/" + "long-path/".repeat(20) + "page";

function assertIndented(rows, width) {
	const visible = rows.map(stripVTControlCharacters).filter(line => line.trim());
	assert.ok(visible.length, "the renderer must produce content rows");
	assert.match(visible[0], /^ {2}\S/, "peer fields start at the two-cell baseline, without double padding");
	for (const row of visible) {
		assert.match(row, /^ {2}/, `expected a two-cell content inset: ${JSON.stringify(row)}`);
		assert.ok(visibleWidth(row) <= width, `row exceeds ${width} columns`);
	}
}

test("web tool arguments retain a two-cell inset on wrapped rows", () => {
	for (const width of [12, 40, 120]) {
		for (const [name, args] of [
			["fetch_content", { urls: [longUrl, "https://short.test"], mode: "raw" }],
			["web_search", { queries: ["long query ".repeat(20), "short query"] }],
			["get_search_content", { responseId: "stored-id", query: "stored query" }],
		]) {
			const rows = getTool(name).renderCall(args, theme).render(width);
			assert.ok(rows.length > 1, "arguments occupy an indented area below the title");
			assertIndented(rows.slice(1), width);
		}
		const rows = getTool("fetch_content").renderCall({ url: longUrl }, theme).render(width);
		assertIndented(rows.slice(1), width);
		assert.equal(rows.slice(1).map(row => row.slice(2).trimEnd()).join(""), longUrl, "wrapping preserves the complete URL");
	}
});

test("web tool results share the same inset across success, progress, error and expansion", () => {
	const outcomes = [
		["web_search", { queryCount: 2, successfulQueries: 2, totalResults: 5 }],
		["fetch_content", { urlCount: 4, successful: 2 }],
		["fetch_content", { urlCount: 1, title: "Fetched page", totalChars: 200 }],
		["get_search_content", { title: "Stored page", contentLength: 200 }],
	];
	for (const width of [12, 40, 120]) for (const expanded of [false, true]) {
		for (const [name, details] of outcomes) {
			const tool = getTool(name);
			const result = { content: [{ type: "text", text: "Providers used: parallel\n" + longUrl }], details };
			assertIndented(tool.renderResult(result, { expanded, isPartial: false }, theme).render(width), width);
			const error = { ...result, details: { error: "fetch failed", queryCount: 2, successfulQueries: 0 } };
			assertIndented(tool.renderResult(error, { expanded, isPartial: false }, theme).render(width), width);
		}
		for (const name of ["web_search", "fetch_content"]) {
			const result = { content: [], details: { phase: "searching", currentQuery: "long query ".repeat(8), progress: 0.5 } };
			assertIndented(getTool(name).renderResult(result, { expanded, isPartial: true }, theme).render(width), width);
		}
	}
});
