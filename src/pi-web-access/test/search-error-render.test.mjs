// Repro + guard for the web_search Ctrl+O error-path dead-end (ronin fix).
//
// BEFORE the fix, web_search renderResult early-returned a SINGLE line on the
// error/cancel path (before the collapsed/expanded branch), so Ctrl+O flipped
// `expanded` with zero visible effect and discarded the partial results. This
// test pins the new behavior: the error/cancel path produces a rich, EXPANDABLE
// plan (>1 line, with diagnostics + a "ctrl+o to expand" hint), routed through
// the dep-free buildSearchErrorPlan() that index.ts.renderResult delegates to.
//
// Runner: node --test (matches the package's existing .test.mjs convention).
// Node >= 22.6 imports the .ts source directly (no build step).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import initializeExtension from "../index.ts";
import { buildSearchErrorPlan } from "../render-search-error.ts";

const staleCancel = {
	error: "Search curation cancelled (stale).",
	cancelled: true,
	cancelReason: "stale",
	browserConnected: false,
	lastHeartbeatAgeMs: 31200,
	queryCount: 3,
	cancelledQueries: [
		{ query: "z.ai API usage endpoint coding plan credits", provider: "perplexity", error: null, resultCount: 5 },
		{ query: "z.ai GLM coding plan API key usage limits", provider: "perplexity", error: "Connection error", resultCount: 0 },
	],
};

test("cancel/error path is NOT a dead-end single line: expanded plan has >1 line", () => {
	const plan = buildSearchErrorPlan(staleCancel);
	assert.notEqual(plan, null, "a cancelled result must produce a plan, not null");
	const expanded = plan.expanded.join("\n");
	assert.ok(plan.expanded.length > 1, `expanded must be >1 line, got ${plan.expanded.length}`);
	assert.match(expanded, /Search curation cancelled \(stale\)/);
});

test("expanded plan surfaces the diagnostics that were previously discarded", () => {
	const plan = buildSearchErrorPlan(staleCancel);
	const expanded = plan.expanded.join("\n");
	assert.match(expanded, /cancel reason\s*:\s*stale/);
	assert.match(expanded, /browser\s*:\s*never connected/);
	assert.match(expanded, /queries started\s*:\s*3/);
	assert.match(expanded, /queries done\s*:\s*2/);
	assert.match(expanded, /z\.ai API usage endpoint/);
	assert.match(expanded, /5 sources/);
	assert.match(expanded, /\[err\]/);
	assert.match(expanded, /Connection error/);
});

test("collapsed view is a short summary WITH a ctrl+o expand hint (Ctrl+O now does something)", () => {
	const plan = buildSearchErrorPlan(staleCancel);
	const collapsed = plan.collapsed.join("\n");
	assert.match(collapsed, /2\/3 queries completed/);
	assert.match(collapsed, /browser never connected/);
	assert.equal(typeof plan.expandHint, "string");
	assert.match(plan.expandHint, /ctrl\+o to expand/i, "expand hint must mention ctrl+o");
	assert.match(plan.expandHint, /\d+ more lines/);
});

test("plain (non-cancel) error stays a clean single line — no diagnostic noise", () => {
	const plan = buildSearchErrorPlan({ error: "No query provided" });
	assert.notEqual(plan, null);
	assert.equal(plan.expanded.length, 1, "plain error must be a single line");
	assert.equal(plan.collapsed.length, 0);
	assert.equal(plan.expandHint, null, "plain error must have no expand hint");
});

// --- other tools (fetch_content / get_search_content): the same
// dead-end exists in their renderResults; they now reuse buildSearchErrorPlan via
// extraLines. These pin that non-cancel errors with detail become expandable
// WITHOUT the curator/browser diagnostics (which are web_search-only). ---

test("fetch_content-style error (extras, no cancel) is expandable without browser diagnostics", () => {
	const plan = buildSearchErrorPlan({
		error: "Failed to fetch: https://example.com/x (404)",
		extraLines: ["urls: 1/2 succeeded", "response id: resp_abc", "  \u25b8 https://example.com/x"],
	});
	assert.notEqual(plan, null);
	const expanded = plan.expanded.join("\n");
	assert.ok(plan.expanded.length > 1);
	assert.match(expanded, /urls: 1\/2 succeeded/);
	assert.match(expanded, /resp_abc/);
	assert.doesNotMatch(expanded, /browser|cancel reason|queries started/);
	assert.equal(typeof plan.expandHint, "string");
	assert.match(plan.expandHint, /ctrl\+o to expand/i);
});

test("non-search error with extras shows detail without browser diagnostics", () => {
	const plan = buildSearchErrorPlan({
		error: "Exa search failed: connection reset",
		extraLines: ["query: how to use p-limit concurrency"],
	});
	assert.notEqual(plan, null);
	assert.match(plan.expanded.join("\n"), /query: how to use p-limit concurrency/);
	assert.doesNotMatch(plan.expanded.join("\n"), /browser/);
	assert.equal(typeof plan.expandHint, "string");
});


test("non-error result yields null so the caller falls through to the success renderer", () => {
	assert.equal(buildSearchErrorPlan({ queryCount: 3, totalResults: 9 }), null);
	assert.equal(buildSearchErrorPlan(undefined), null);
	assert.equal(buildSearchErrorPlan(null), null);
});

test("registered search, fetch and retrieval actions reveal error diagnostics when expanded", () => {
	const tools = new Map();
	initializeExtension({
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {},
	});
	const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
	for (const [name, details, diagnostic] of [
		["web_search", staleCancel, /5 sources/],
		["fetch_content", { error: "Fetch failed", urlCount: 2, successful: 1 }, /urls: 1\/2 succeeded/],
		["get_search_content", { error: "Not found", query: "sample query" }, /query: sample query/],
	]) {
		const tool = tools.get(name);
		const render = expanded => tool.renderResult({ content: [], details }, { expanded, isPartial: false }, theme).render(120).join("\n");
		assert.match(render(false), /ctrl\+o to expand/i, name);
		assert.match(render(true), diagnostic, name);
	}
});

test("curation cancellation carries partial results into its return", () => {
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(source, /buildCurationCancelledReturn\(reason, \{/);
	assert.match(source, /cancelledQueries/);
});
