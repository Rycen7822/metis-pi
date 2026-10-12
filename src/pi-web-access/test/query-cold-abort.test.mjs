import assert from "node:assert/strict";
import { test } from "node:test";
import { answerFromPage } from "../page-query.ts";
import { rewriteSearchQuery } from "../query-rewrite.ts";

for (const kind of ["page", "rewrite"]) {
	const invoke = (ctx, signal = new AbortController().signal) => kind === "page"
		? answerFromPage({ question: "Q", pageText: "P", sourceUrl: "https://example.com" }, ctx, signal)
		: rewriteSearchQuery("Q", ctx, signal);
	test(`${kind} rejects pre-abort and an aborted native completion with partial text`, async () => {
		let calls = 0;
		const model = { provider: "anthropic", id: "claude-haiku-4-5", input: ["text"], contextWindow: 10000 };
		const ctx = { model, scopedModels: [], modelRegistry: {
			find: () => model, getAvailable: () => [model],
			complete: async () => { calls++; return { stopReason: "aborted", content: [{ type: "text", text: "partial" }] }; },
		} };
		await assert.rejects(invoke(ctx, AbortSignal.abort()), /Aborted/);
		assert.equal(calls, 0);
		await assert.rejects(invoke(ctx), /Aborted/);
		assert.equal(calls, 1);
	});
}
