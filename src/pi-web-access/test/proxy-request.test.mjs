import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { webFetch, runWithProxy } from "../proxy-transport.ts";

const nativeFetch = globalThis.fetch;
const target = "http://request.example.test/resource";
const curlSkip = spawnSync("curl", ["--version"], { stdio: "ignore" }).status === 0 ? false : "requires curl on PATH";

async function withProxy(t, respond = (_request, response) => response.end("ok")) {
	const calls = [];
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		calls.push({ url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks) });
		respond(request, response);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const previousNoProxy = process.env.NO_PROXY;
	const previousNoProxyLower = process.env.no_proxy;
	process.env.NO_PROXY = "";
	process.env.no_proxy = "";
	globalThis.fetch = nativeFetch;
	t.after(async () => {
		globalThis.fetch = nativeFetch;
		if (previousNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = previousNoProxy;
		if (previousNoProxyLower === undefined) delete process.env.no_proxy;
		else process.env.no_proxy = previousNoProxyLower;
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	const proxy = `http://127.0.0.1:${server.address().port}`;
	return { calls, proxy, fetch: (input, init) => runWithProxy(proxy, () => webFetch(input, init)) };
}

test("Web proxy requests leave the host global fetch delegated to its owner", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const hostCalls = [];
	const hostFetch = async (input) => { hostCalls.push(input); return new Response("host transport"); };
	t.mock.method(globalThis, "fetch", hostFetch);
	const hostDelegate = globalThis.fetch;
	assert.equal(await runWithProxy(proxy.proxy, async () => (await globalThis.fetch(target)).text()), "host transport");
	assert.equal(globalThis.fetch, hostDelegate);
	assert.deepEqual(hostCalls, [target]);
	assert.equal(proxy.calls.length, 0);
	assert.equal(await runWithProxy(proxy.proxy, async () => (await webFetch(target)).text()), "ok");
	assert.equal(globalThis.fetch, hostDelegate);
	assert.deepEqual(hostCalls, [target]);
	assert.equal(proxy.calls.length, 1);
});

test("actual curl argv omits credentials while stdin config preserves escaped wire values", {
	skip: curlSkip || (process.platform !== "linux" && "requires Linux process argv"), timeout: 5000,
}, async (t) => {
	let acknowledge;
	const received = new Promise(resolve => { acknowledge = resolve; });
	let heldResponse;
	const proxy = await withProxy(t, (_request, response) => { heldResponse = response; acknowledge(); });
	const proxyUrl = new URL(proxy.proxy);
	const username = 'argv-proxy-user"\\';
	const password = 'argv-proxy-pass\\"';
	proxyUrl.username = username;
	proxyUrl.password = password;
	const url = new URL(target);
	const key = 'argv-query-key"\\';
	url.searchParams.set("api_key", key);
	const authorization = 'Bearer argv-auth-key"\\';
	const cookie = 'session=argv-cookie-key\\"';
	const apiHeader = 'argv-api-header"\\';
	const body = new Uint8Array([0, 255, 13, 10, 34, 92]);
	const pending = runWithProxy(proxyUrl.toString(), () => webFetch(url, {
		method: "POST", headers: { Authorization: authorization, Cookie: cookie, "X-Api-Key": apiHeader },
		body, signal: AbortSignal.timeout(4000),
	}));
	// Hold the real HTTP response so its curl process is inspectable, not a spawn stub.
	try {
		await received;
		const pids = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
		const commandLines = await Promise.all(pids.map(pid => readFile(`/proc/${pid}/cmdline`, "utf8")));
		const curlCommand = commandLines.find(line => /(?:^|\/)curl\0/.test(line));
		assert.ok(curlCommand, "actual curl subprocess is running");
		assert.ok(curlCommand.includes("--config\0-\0"));
		assert.ok(!curlCommand.includes("argv-"), "headers, query key and proxy user/password are absent from argv");
		const call = proxy.calls[0];
		assert.equal(call.headers.authorization, authorization);
		assert.equal(call.headers.cookie, cookie);
		assert.equal(call.headers["x-api-key"], apiHeader);
		assert.equal(new URL(call.url).searchParams.get("api_key"), key);
		assert.equal(Buffer.from(call.headers["proxy-authorization"].slice("Basic ".length), "base64").toString(), `${username}:${password}`);
		assert.deepEqual(call.body, Buffer.from(body));
	} finally {
		heldResponse?.end("ok");
		await pending.then(response => response.text());
	}
});

test("proxied Request retains its method, headers and JSON body", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const request = new Request(target, {
		method: "POST",
		headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
		body: JSON.stringify({ message: "hello" }),
	});
	assert.equal(await (await proxy.fetch(request)).text(), "ok");
	assert.equal(proxy.calls.length, 1);
	assert.equal(proxy.calls[0].url, target);
	assert.equal(proxy.calls[0].method, "POST");
	assert.equal(proxy.calls[0].headers.authorization, "Bearer test");
	assert.equal(proxy.calls[0].headers["content-type"], "application/json");
	assert.equal(proxy.calls[0].body.toString(), '{"message":"hello"}');
	assert.equal(request.bodyUsed, true);
});

test("proxied bodyless POST and PUT send a zero Content-Length", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	await proxy.fetch(new Request(target, { method: "POST" }));
	await proxy.fetch(target, { method: "PUT" });
	assert.deepEqual(proxy.calls.map(call => [call.method, call.headers["content-length"]]), [["POST", "0"], ["PUT", "0"]]);
});

test("proxied HEAD uses HEAD on the wire and returns no body", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t, (_request, response) => {
		response.setHeader("Content-Length", "4");
		response.setHeader("X-Test", "head");
		response.end("body");
	});
	for (const [input, init] of [[new Request(target, { method: "HEAD" }), undefined], [target, { method: "HEAD" }]]) {
		const response = await proxy.fetch(input, init);
		assert.equal(proxy.calls.at(-1).method, "HEAD");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-test"), "head");
		assert.equal(response.headers.get("content-length"), "4");
		assert.equal(response.body, null);
		assert.equal(await response.text(), "");
	}
	assert.deepEqual(proxy.calls.map(call => call.method), ["HEAD", "HEAD"]);
});

test("proxied Request applies init overrides and replaces headers", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const request = new Request(target, {
		method: "POST", headers: { "X-Original": "old" }, body: "original",
	});
	await proxy.fetch(request, {
		method: "PUT", headers: { "X-Override": "new" }, body: new Uint8Array([0, 255, 13, 10]),
	});
	assert.equal(proxy.calls[0].method, "PUT");
	assert.equal(proxy.calls[0].headers["x-original"], undefined);
	assert.equal(proxy.calls[0].headers["x-override"], "new");
	assert.deepEqual(proxy.calls[0].body, Buffer.from([0, 255, 13, 10]));
});

test("proxied Request inherits body and content type when init only overrides method", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	await proxy.fetch(new Request(target, {
		method: "POST", body: new URLSearchParams({ query: "a b" }),
	}), { method: "PATCH" });
	assert.equal(proxy.calls[0].method, "PATCH");
	assert.equal(proxy.calls[0].headers["content-type"], "application/x-www-form-urlencoded;charset=UTF-8");
	assert.equal(proxy.calls[0].body.toString(), "query=a+b");
});

test("proxied Request keeps multipart headers and bytes from the same body", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const form = new FormData();
	form.set("message", "hello");
	await proxy.fetch(new Request(target, { method: "POST", body: form }));
	const boundary = proxy.calls[0].headers["content-type"].split("boundary=")[1];
	assert.ok(boundary);
	assert.ok(proxy.calls[0].body.toString().startsWith(`--${boundary}\r\n`));
	assert.ok(proxy.calls[0].body.toString().includes('name="message"\r\n\r\nhello'));
});

test("proxied Request replays its bytes on 307 and drops its body on 303", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t, (request, response) => {
		const status = request.url === target ? 307 : request.url.endsWith("/retry") ? 303 : 200;
		response.writeHead(status, { Location: request.url === target ? "/retry" : "/final" });
		response.end("ok");
	});
	await proxy.fetch(new Request(target, { method: "POST", body: "replayed" }));
	assert.deepEqual(proxy.calls.map((call) => [call.method, call.body.toString()]), [
		["POST", "replayed"], ["POST", "replayed"], ["GET", ""],
	]);
	assert.equal(proxy.calls[2].headers["content-type"], undefined);
});

test("proxied Request retains redirect policy and allows init to override it", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t, (_request, response) => {
		response.writeHead(302, { Location: "http://other.example.test/final" });
		response.end();
	});
	const response = await proxy.fetch(new Request(target, { redirect: "manual" }));
	assert.equal(response.status, 302);
	assert.equal(proxy.calls.length, 1);
	await assert.rejects(proxy.fetch(new Request(target, { redirect: "manual" }), { redirect: "error" }), /redirect blocked/);
	assert.equal(proxy.calls.length, 2);
});

test("proxied Request inherits abort signal and supports an override", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(proxy.fetch(new Request(target, { signal: controller.signal })), { name: "AbortError" });
	assert.equal(proxy.calls.length, 0);
	await proxy.fetch(new Request(target, { signal: controller.signal }), { signal: new AbortController().signal });
	assert.equal(proxy.calls.length, 1);
});

test("proxied Request aborts a running curl request", { timeout: 5000, skip: curlSkip }, async (t) => {
	let received;
	const started = new Promise((resolve) => { received = resolve; });
	const proxy = await withProxy(t, () => received());
	const controller = new AbortController();
	const pending = proxy.fetch(new Request(target, { signal: controller.signal }));
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await started;
	controller.abort();
	await rejected;
});

test("proxied Request cancels body buffering when its signal aborts", { timeout: 5000, skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	let cancelled = false;
	let reading;
	const started = new Promise((resolve) => { reading = resolve; });
	const body = new ReadableStream({
		pull() { reading(); },
		cancel() { cancelled = true; },
	});
	const controller = new AbortController();
	const pending = proxy.fetch(new Request(target, { method: "POST", body, duplex: "half", signal: controller.signal }));
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await started;
	controller.abort();
	await rejected;
	assert.equal(cancelled, true);
	assert.equal(proxy.calls.length, 0);
});

test("proxied Request rejects a consumed body before sending a request", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const request = new Request(target, { method: "POST", body: "used" });
	await request.text();
	await assert.rejects(proxy.fetch(request), TypeError);
	assert.equal(proxy.calls.length, 0);
	await proxy.fetch(request, { body: "replacement" });
	assert.equal(proxy.calls[0].body.toString(), "replacement");
});


test("proxied response rejects curl partial-transfer failure after HTTP 200 headers", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t, (_request, response) => {
		response.writeHead(200, { "Content-Length": "30", Connection: "close" });
		response.end("partial");
	});
	await assert.rejects(proxy.fetch(target), /curl exited with code 18/);
	assert.equal(proxy.calls.length, 1);
});

test("proxied complete HTTP errors remain responses rather than transport failures", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t, (_request, response) => {
		response.writeHead(503);
		response.end("service unavailable");
	});
	const response = await proxy.fetch(target);
	assert.equal(response.status, 503);
	assert.equal(await response.text(), "service unavailable");
});
