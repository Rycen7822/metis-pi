import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { startCuratorServer } from "../curator-server.ts";
import { AmbiguousModelError } from "../summary-model-scope.ts";

const TEST_TIMEOUT_MS = 8000;

test("summary ambiguity keeps the curator usable and carries a typed selection error", async () => {
	const callbacks = baseCallbacks(() => {});
	callbacks.onSummarize = async () => { throw new AmbiguousModelError("Ambiguous model; choose provider/model"); };
	const handle = await startCuratorServer(baseOptions(30), callbacks);
	handle.pushResult(0, { answer: "Evidence", provider: "exa", results: [] });
	try {
		const summarize = model => fetch(new URL("/summarize", handle.url), {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "test-token", selected: [0], model }),
		});
		const failure = await summarize();
		assert.equal(failure.status, 500);
		assert.equal((await failure.json()).code, "ambiguous_model");
		callbacks.onSummarize = async (_selected, _signal, model) => ({
			summary: `Selected ${model}`, meta: { model, durationMs: 1, tokenEstimate: 1, fallbackUsed: false },
		});
		const success = await summarize("router/model");
		assert.equal(success.status, 200);
		assert.equal((await success.json()).summary, "Selected router/model");
	} finally { handle.close(); }
});

function baseOptions(timeout = 1) {
	return {
		queries: ["test query"],
		sessionToken: "test-token",
		timeout,
		availableProviders: { all: true, openai: false, brave: false, parallel: false, tinyfish: false, search1api: false, searchinfinity: false, querit: false, tavily: false, serpdive: false, searxng: false, perplexity: false, exa: true, gemini: false, kimi: false, anysearch: false },
		defaultProvider: "exa",
		searchProvider: "exa",
		summaryModels: [],
		defaultSummaryModel: null,
	};
}

function baseCallbacks(resolveCancel) {
	return {
		onSubmit: () => {},
		onCancel: resolveCancel,
		onProviderChange: () => {},
		onAddSearch: async () => [{ answer: "", results: [], provider: "exa" }],
		onAddSearchResults: () => {},
		onSummarize: async () => ({
			summary: "",
			meta: { model: null, durationMs: 0, tokenEstimate: 0, fallbackUsed: true },
		}),
		onRewriteQuery: async (query) => query,
	};
}

function withTimeout(promise, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out`)), TEST_TIMEOUT_MS);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readEventStreamUntil(response, marker, label) {
	assert.equal(response.status, 200);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		await withTimeout((async () => {
			while (!text.includes(marker)) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += decoder.decode(chunk.value, { stream: true });
			}
		})(), label);
	} finally {
		await reader.cancel().catch(() => {});
	}
	return text;
}

test("curator times out when searches finish but no browser connects", async () => {
	let resolveCancel;
	const cancelPromise = new Promise((resolve) => { resolveCancel = resolve; });
	const handle = await startCuratorServer(baseOptions(1), baseCallbacks(resolveCancel));

	try {
		handle.pushResult(0, { answer: "answer", results: [], provider: "exa" });
		handle.searchesDone();

		const reason = await withTimeout(cancelPromise, "no-browser timeout");
		assert.equal(reason, "timeout");
	} finally {
		handle.close();
	}
});

test("curator replays search events after SSE reconnect", async () => {
	const handle = await startCuratorServer(baseOptions(20), baseCallbacks(() => {}));

	try {
		const eventsUrl = new URL("/events", handle.url);
		eventsUrl.searchParams.set("session", "test-token");
		const firstResponse = await fetch(eventsUrl);
		assert.equal(firstResponse.status, 200);

		handle.pushResult(0, { answer: "answer", results: [], provider: "exa" });
		await firstResponse.body.cancel().catch(() => {});

		const secondResponse = await fetch(eventsUrl);
		const body = await readEventStreamUntil(secondResponse, "event: result", "sse replay");
		assert.match(body, /event: result/);
		assert.match(body, /"answer":"answer"/);
	} finally {
		handle.close();
	}
});

test("curator add-search indexes do not collide with reserved initial provider results", async () => {
	const handle = await startCuratorServer({
		...baseOptions(20),
		queries: ["initial one", "initial two"],
		initialResultIndexCapacity: 6,
	}, baseCallbacks(() => {}));

	try {
		const searchResponse = await fetch(new URL("/search", handle.url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "test-token", query: "added search" }),
		});
		assert.equal(searchResponse.status, 200);
		const added = await searchResponse.json();
		assert.equal(added.queryIndex, 6);

		// Index 2 is a later provider result for the first initial query. Before
		// reserving the initial range, the added search also received index 2.
		handle.pushResult(2, {
			query: "initial one",
			slotIndex: 0,
			answer: "late provider answer",
			results: [],
			provider: "brave",
		});
		handle.searchesDone();

		const eventsUrl = new URL("/events", handle.url);
		eventsUrl.searchParams.set("session", "test-token");
		const events = await readEventStreamUntil(await fetch(eventsUrl), "event: done", "reserved-index replay");
		assert.match(events, /"query":"initial one"[\s\S]*"queryIndex":2/);
	} finally {
		handle.close();
	}
});

test("curator submit rejects contradictory summary metadata", async () => {
	const handle = await startCuratorServer(baseOptions(20), baseCallbacks(() => {}));

	try {
		for (const summaryMeta of [
			{ model: null, durationMs: 0, tokenEstimate: 0, fallbackUsed: false, phase: "deterministic-fallback" },
			{ model: "model", durationMs: 0, tokenEstimate: 0, fallbackUsed: true, phase: "summary-model" },
		]) {
			const response = await fetch(new URL("/submit", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: "test-token", selected: [], summaryMeta }),
			});
			assert.equal(response.status, 400);
			assert.deepEqual(await response.json(), { ok: false, error: "Invalid summaryMeta" });
		}
	} finally {
		handle.close();
	}
});

test("curator assigns one selectable result index per provider", async () => {
	const indexedEntries = [];
	let summarySelection = [];
	const callbacks = baseCallbacks(() => {});
	callbacks.onAddSearch = async () => [
		{
			answer: "Exa answer",
			results: [{ title: "Exa", url: "https://example.com/exa", domain: "example.com" }],
			provider: "exa",
		},
		{
			answer: "Brave answer",
			results: [{ title: "Brave", url: "https://example.com/brave", domain: "example.com" }],
			provider: "brave",
		},
	];
	callbacks.onAddSearchResults = (entries) => indexedEntries.push(...entries);
	callbacks.onSummarize = async (selected) => {
		summarySelection = selected;
		return {
			summary: "Combined summary",
			meta: { model: null, durationMs: 0, tokenEstimate: 0, fallbackUsed: true },
		};
	};

	const handle = await startCuratorServer(baseOptions(20), callbacks);
	try {
		const searchResponse = await fetch(new URL("/search", handle.url), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "test-token", query: "combined query", provider: "all" }),
		});
		assert.equal(searchResponse.status, 200);
		const searchBody = await searchResponse.json();
		assert.deepEqual(searchBody.entries.map(entry => entry.provider), ["exa", "brave"]);
		assert.deepEqual(searchBody.entries.map(entry => entry.queryIndex), [1, 2]);
		assert.deepEqual(indexedEntries.map(entry => entry.queryIndex), [1, 2]);

		const summarizeResponse = await fetch(new URL("/summarize", handle.url), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "test-token", selected: [1, 2] }),
		});
		assert.equal(summarizeResponse.status, 200);
		assert.deepEqual(summarySelection, [1, 2]);
	} finally {
		handle.close();
	}
});

test("curator heartbeat timeout finalizes connected idle browser sessions", async () => {
	let resolveCancel;
	const cancelPromise = new Promise((resolve) => { resolveCancel = resolve; });
	const handle = await startCuratorServer(baseOptions(20), baseCallbacks(resolveCancel));

	try {
		await fetch(handle.url);
		handle.pushResult(0, { answer: "answer", results: [], provider: "exa" });
		handle.searchesDone();

		const response = await fetch(new URL("/heartbeat", handle.url), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "test-token", idleMs: 21000, timeoutSec: 20 }),
		});
		assert.equal(response.status, 200);

		const reason = await withTimeout(cancelPromise, "idle heartbeat timeout");
		assert.equal(reason, "timeout");
	} finally {
		handle.close();
	}
});

test("curator state replay keeps current results and compacts superseded history", async () => {
	const handle = await startCuratorServer(baseOptions(20), baseCallbacks(() => {}));

	try {
		for (let i = 0; i < 205; i++) {
			handle.pushResult(i, { answer: `answer ${i}`, results: [], provider: "exa", query: `query ${i}` });
		}
		handle.pushError(0, "updated", "exa", { query: "query 0" });

		const response = await fetch(new URL("/state?session=test-token", handle.url));
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.events.length, 205);
		assert.equal(body.events[0].event, "search-error");
		assert.equal(body.events[0].data.queryIndex, 0);
		assert.equal(body.events[204].data.queryIndex, 204);
	} finally {
		handle.close();
	}
});

test("curator state replay keeps all-provider entries that share one slot", async () => {
	const handle = await startCuratorServer(baseOptions(20), baseCallbacks(() => {}));

	try {
		handle.pushResult(0, { answer: "exa answer", results: [], provider: "exa", query: "query", slotIndex: 0 });
		handle.pushResult(1, { answer: "brave answer", results: [], provider: "brave", query: "query", slotIndex: 0 });

		const response = await fetch(new URL("/state?session=test-token", handle.url));
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.deepEqual(body.events.map((event) => event.data.provider), ["exa", "brave"]);
		assert.deepEqual(body.events.map((event) => event.data.queryIndex), [0, 1]);
		assert.deepEqual(body.events.map((event) => event.data.slotIndex), [0, 0]);
	} finally {
		handle.close();
	}
});

test("curator exposes and signals approve remaining searches for this prompt", async () => {
	let resolveSubmit;
	const submitPromise = new Promise((resolve) => { resolveSubmit = resolve; });
	const callbacks = baseCallbacks(() => {});
	callbacks.onSubmit = resolveSubmit;
	const handle = await startCuratorServer(baseOptions(20), callbacks);

	try {
		const pageResponse = await fetch(handle.url);
		assert.equal(pageResponse.status, 200);
		assert.match(await pageResponse.text(), /Approve \+ auto-summary remaining searches for this prompt/);

		const response = await fetch(new URL("/submit", handle.url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: "test-token",
				selected: [0],
				summary: "Approved draft",
				autoApproveRemainingSearches: true,
			}),
		});
		assert.equal(response.status, 200);
		const payload = await withTimeout(submitPromise, "approve remaining submit");
		assert.equal(payload.summary, "Approved draft");
		assert.equal(payload.autoApproveRemainingSearches, true);
	} finally {
		handle.close();
	}
});

test("curator accepts SerpApi and Parallel MCP and projects their labels into the page", async () => {
	const options = baseOptions(20);
	options.availableProviders = { ...options.availableProviders, serpapi: true, "parallel-mcp": true };
	const callbacks = baseCallbacks(() => {});
	callbacks.onAddSearch = async (_query, provider) => [{ answer: "synthetic answer", results: [], provider }];
	const handle = await startCuratorServer(options, callbacks);
	try {
		const html = await (await fetch(handle.url)).text();
		assert.match(html, /data-provider="serpapi"[^>]*>SerpApi<\/button>/);
		assert.match(html, /data-provider="parallel-mcp"[^>]*>Parallel MCP<\/button>/);
		const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)[1];
		new Script(script);
		const hrefSource = script.match(/function sanitizeHref\(url\) \{[\s\S]*?\n  \}/)[0];
		const sanitizeHref = new Script(`(${hrefSource})`).runInNewContext();
		assert.equal(sanitizeHref(" https://example.test/page "), "https://example.test/page");
		assert.equal(sanitizeHref("http://example.test/page"), "http://example.test/page");
		assert.equal(sanitizeHref("/relative-page"), "#");
		const data = JSON.parse(script.match(/var DATA = ([^\n]+);/)[1]);
		assert.equal(data.providerLabels["parallel-mcp"], "Parallel MCP");
		assert.equal(data.providerLabels.serpapi, "SerpApi");
		for (const provider of ["serpapi", "parallel-mcp"]) {
			const preference = await fetch(new URL("/provider", handle.url), {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "test-token", provider }),
			});
			assert.equal(preference.status, 200);
			const response = await fetch(new URL("/search", handle.url), {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "test-token", query: "synthetic query", provider }),
			});
			assert.equal(response.status, 200);
			assert.equal((await response.json()).entries[0].provider, provider);
		}
		const rejected = await fetch(new URL("/provider", handle.url), {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "test-token", provider: "constructor" }),
		});
		assert.equal(rejected.status, 400);
	} finally {
		handle.close();
	}
});

test("curator normal rewrite replies stay uncancelled and invalid sessions never call the worker", async () => {
	let calls = 0;
	let rewriteSignal;
	const callbacks = baseCallbacks(() => {});
	callbacks.onRewriteQuery = async (query, signal) => {
		calls++;
		rewriteSignal = signal;
		await new Promise(resolve => setTimeout(resolve, 25));
		assert.equal(signal.aborted, false);
		return `rewritten ${query}`;
	};
	const handle = await startCuratorServer(baseOptions(20), callbacks);
	try {
		const response = await fetch(new URL("/rewrite", handle.url), {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "test-token", query: "synthetic query" }),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, query: "rewritten synthetic query" });
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(rewriteSignal.aborted, false);
		const invalid = await fetch(new URL("/rewrite", handle.url), {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "invalid-token", query: "synthetic query" }),
		});
		assert.equal(invalid.status, 403);
		assert.equal(calls, 1);
		handle.close();
		assert.equal(rewriteSignal.aborted, false);
	} finally {
		handle.close();
	}
});

test("curator aborts rewrite work on a real response disconnect and remains usable", async () => {
	let resolveStarted, resolveAborted;
	const started = new Promise(resolve => { resolveStarted = resolve; });
	const aborted = new Promise(resolve => { resolveAborted = resolve; });
	const callbacks = baseCallbacks(() => {});
	callbacks.onRewriteQuery = (query, signal) => {
		if (query === "later") return Promise.resolve("later rewrite");
		resolveStarted(signal);
		return new Promise((_, reject) => {
			signal.addEventListener("abort", () => {
				resolveAborted(signal.aborted);
				reject(new Error("Synthetic rewrite aborted"));
			}, { once: true });
		});
	};
	const handle = await startCuratorServer(baseOptions(20), callbacks);
	const client = new AbortController();
	try {
		const request = fetch(new URL("/rewrite", handle.url), {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "test-token", query: "disconnect" }), signal: client.signal,
		}).then(() => "unexpected response", error => error.name);
		const signal = await withTimeout(started, "rewrite start");
		assert.equal(signal.aborted, false);
		client.abort();
		assert.equal(await request, "AbortError");
		assert.equal(await withTimeout(aborted, "rewrite disconnect cancellation"), true);
		const later = await fetch(new URL("/rewrite", handle.url), {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "test-token", query: "later" }),
		});
		assert.equal(later.status, 200);
		assert.equal((await later.json()).query, "later rewrite");
	} finally {
		client.abort();
		handle.close();
		handle.server.closeAllConnections();
	}
});

for (const finish of ["cancel", "close"]) {
	test(`curator ${finish} cancels owned rewrite work without publishing a late success`, async () => {
		let resolveStarted;
		const started = new Promise(resolve => { resolveStarted = resolve; });
		const callbacks = baseCallbacks(() => {});
		callbacks.onRewriteQuery = (_query, signal) => {
			resolveStarted(signal);
			return new Promise((resolve, reject) => {
				signal.addEventListener("abort", () => {
					if (finish === "close") resolve("synthetic late success");
					else reject(new Error("Synthetic rewrite aborted"));
				}, { once: true });
			});
		};
		const handle = await startCuratorServer(baseOptions(20), callbacks);
		try {
			const request = fetch(new URL("/rewrite", handle.url), {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "test-token", query: "synthetic query" }),
			}).then(response => ({ response }), error => ({ error }));
			const signal = await withTimeout(started, "rewrite start");
			if (finish === "cancel") {
				const cancelled = await fetch(new URL("/cancel", handle.url), {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ token: "test-token", reason: "user" }),
				});
				assert.equal(cancelled.status, 200);
			} else {
				handle.close();
			}
			assert.equal(signal.aborted, true);
			const result = await withTimeout(request, "cancelled rewrite response");
			assert.equal(result.error, undefined);
			assert.equal(result.response.status, 409);
		} finally {
			handle.close();
			handle.server.closeAllConnections();
		}
	});
}
