import assert from "node:assert/strict";
import dns from "node:dns";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { runWithProxy } from "../proxy-transport.ts";
import { fetchRemoteUrl } from "../ssrf-protection.ts";

const curlSkip = spawnSync("curl", ["--version"], { stdio: "ignore" }).status === 0 ? false : "requires curl on PATH";
const checked = "127.0.0.1";
const rebound = "127.0.0.2";
const hostname = "dial.example.test";

async function origin(t, address, port = 0, respond = (_request, response) => response.end(address)) {
	const calls = [];
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		calls.push({ path: request.url, host: request.headers.host, headers: request.headers, method: request.method, body: Buffer.concat(chunks) });
		respond(request, response);
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, address, resolve); });
	t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
	return { calls, port: server.address().port };
}

async function httpProxy(t, { connectAllowed = true } = {}) {
	const tunnels = [];
	const forwards = [];
	const sockets = new Set();
	const server = createServer((request, response) => { forwards.push(request.url); response.end("remote DNS proxy"); });
	server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
	server.on("connect", (request, client, head) => {
		tunnels.push(request.url);
		if (!connectAllowed) { client.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n"); return; }
		const [address, port] = request.url.split(":");
		// This fixture must never forward to any non-local or unvalidated name.
		if (![checked, rebound].includes(address)) { client.destroy(); return; }
		const upstream = connect({ host: address, port: Number(port) });
		sockets.add(upstream);
		upstream.on("error", () => client.destroy());
		upstream.on("close", () => sockets.delete(upstream));
		client.on("close", () => upstream.destroy());
		upstream.once("connect", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream); upstream.pipe(client);
		});
	});
	await new Promise(resolve => server.listen(0, checked, resolve));
	t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
	return { url: `http://${checked}:${server.address().port}`, tunnels, forwards };
}

function environment(t, values) {
	for (const [key, value] of Object.entries(values)) {
		const previous = process.env[key];
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
		t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	}
}

async function socksProxy(t) {
	const destinations = [];
	const sockets = new Set();
	const server = createTcpServer(client => {
		sockets.add(client);
		client.on("error", () => {});
		client.on("close", () => sockets.delete(client));
		let buffer = Buffer.alloc(0);
		let stage = "greeting";
		const onData = chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			if (stage === "greeting" && buffer[0] === 5) {
				if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
				buffer = buffer.subarray(2 + buffer[1]); stage = "socks5";
				client.write(Buffer.from([5, 0]));
			} else if (stage === "greeting" && buffer[0] === 4) stage = "socks4";
			let address, port, consumed;
			if (stage === "socks5") {
				if (buffer.length < 10) return;
				if (buffer[3] !== 1) { client.destroy(); return; } // Expected pin is a numeric IPv4 address, never DNS.
				address = [...buffer.subarray(4, 8)].join("."); port = buffer.readUInt16BE(8); consumed = 10;
			} else if (stage === "socks4") {
				if (buffer.length < 9) return;
				const userEnd = buffer.indexOf(0, 8); if (userEnd < 0) return;
				address = [...buffer.subarray(4, 8)].join("."); port = buffer.readUInt16BE(2); consumed = userEnd + 1;
				if (buffer[4] === 0 && buffer[5] === 0 && buffer[6] === 0 && buffer[7] !== 0) {
					const addressEnd = buffer.indexOf(0, consumed); if (addressEnd < 0) return;
					address = buffer.subarray(consumed, addressEnd).toString(); consumed = addressEnd + 1;
				}
			} else return;
			destinations.push({ address, port });
			if (![checked, rebound].includes(address)) { client.destroy(); return; }
			client.removeListener("data", onData); client.pause();
			const isV5 = stage === "socks5";
			const remainder = buffer.subarray(consumed);
			const upstream = connect({ host: address, port }); sockets.add(upstream);
			upstream.on("error", () => client.destroy());
			upstream.on("close", () => sockets.delete(upstream));
			client.on("close", () => upstream.destroy());
			upstream.once("connect", () => {
				client.write(Buffer.from(isV5 ? [5, 0, 0, 1, 127, 0, 0, 1, 0, 0] : [0, 90, 0, 0, 127, 0, 0, 1]));
				if (remainder.length) upstream.write(remainder);
				client.pipe(upstream); upstream.pipe(client); client.resume();
			});
		};
		client.on("data", onData);
	});
	await new Promise(resolve => server.listen(0, checked, resolve));
	t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
	return { port: server.address().port, destinations };
}

test("actual native dial uses checked DNS even when the host resolver and an existing pool point elsewhere", { timeout: 5000 }, async (t) => {
	const allowed = await origin(t, checked);
	const attacker = await origin(t, rebound, allowed.port);
	t.mock.method(dns, "lookup", (_name, options, callback) => {
		if (typeof options === "function") { callback = options; options = {}; }
		queueMicrotask(() => options.all ? callback(null, [{ address: rebound, family: 4 }]) : callback(null, rebound, 4));
	});
	const url = `http://${hostname}:${allowed.port}/resource`;
	// Control: the actual host fetch resolves and dials the second local address.
	assert.equal(await (await globalThis.fetch(url, { signal: AbortSignal.timeout(3000) })).text(), rebound);
	assert.equal(attacker.calls.length, 1);
	let lookups = 0;
	const response = await runWithProxy("", () => fetchRemoteUrl(url, { signal: AbortSignal.timeout(3000) }, {
		allowRanges: [`${checked}/32`], lookup: async name => { assert.equal(name, hostname); lookups++; return [{ address: checked, family: 4 }]; },
	}));
	assert.equal(await response.text(), checked);
	assert.equal(lookups, 1);
	assert.equal(allowed.calls.length, 1);
	assert.equal(allowed.calls[0].host, `${hostname}:${allowed.port}`);
	assert.equal(attacker.calls.length, 1, "no second request reaches the rebound address or host pool");
});

test("each actual redirect hop uses a newly checked address and refreshes path-specific headers", { timeout: 5000 }, async (t) => {
	const first = await origin(t, checked, 0, (_request, response) => { response.writeHead(302, { Location: "/next" }); response.end(); });
	const next = await origin(t, rebound, first.port);
	let lookups = 0;
	const paths = [];
	const response = await runWithProxy("", () => fetchRemoteUrl(`http://${hostname}:${first.port}/start`, {
		method: "POST", body: "first body", signal: AbortSignal.timeout(3000),
	}, {
		allowRanges: [`${checked}/32`, `${rebound}/32`],
		lookup: async () => [{ address: lookups++ === 0 ? checked : rebound, family: 4 }],
		beforeRequest: async (url, init) => {
			paths.push(url.pathname); const headers = new Headers(init.headers); headers.set("Cookie", `path=${url.pathname}`);
			return { ...init, headers };
		},
	}));
	assert.equal(await response.text(), rebound);
	assert.equal(lookups, 2);
	assert.deepEqual(paths, ["/start", "/next"]);
	assert.equal(first.calls[0].headers.cookie, "path=/start");
	assert.equal(next.calls[0].headers.cookie, "path=/next");
	assert.equal(first.calls[0].method, "POST");
	assert.equal(next.calls[0].method, "GET");
	assert.equal(next.calls[0].body.length, 0);
	assert.equal(next.calls[0].host, `${hostname}:${first.port}`);
});

test("rebound redirect DNS is rejected before the new dial and before its auth hook", { timeout: 5000 }, async (t) => {
	const first = await origin(t, checked, 0, (_request, response) => { response.writeHead(307, { Location: "/next" }); response.end(); });
	const attacker = await origin(t, rebound, first.port);
	let lookups = 0;
	const beforePaths = [];
	await assert.rejects(runWithProxy("", () => fetchRemoteUrl(`http://${hostname}:${first.port}/start`, {
		signal: AbortSignal.timeout(3000),
	}, {
		allowRanges: [`${checked}/32`], lookup: async () => [{ address: lookups++ === 0 ? checked : rebound, family: 4 }],
		beforeRequest: async (url, init) => { beforePaths.push(url.pathname); return init; },
	})), /Blocked internal address/);
	assert.equal(lookups, 2);
	assert.deepEqual(beforePaths, ["/start"]);
	assert.equal(attacker.calls.length, 0);
});

test("a pinned native response remains readable until its caller finishes the body", { timeout: 5000 }, async (t) => {
	let held;
	const allowed = await origin(t, checked, 0, (_request, response) => { held = response; response.write("first"); });
	const response = await runWithProxy("", () => fetchRemoteUrl(`http://${hostname}:${allowed.port}/body`, { signal: AbortSignal.timeout(3000) }, {
		allowRanges: [`${checked}/32`], lookup: async () => [{ address: checked, family: 4 }],
	}));
	const reader = response.body.getReader();
	assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
	held.end("last");
	assert.equal(new TextDecoder().decode((await reader.read()).value), "last");
	assert.equal((await reader.read()).done, true);
});

test("caller abort rejects a pinned native body still in flight", { timeout: 5000 }, async (t) => {
	const allowed = await origin(t, checked, 0, (_request, response) => { response.write("partial"); });
	const controller = new AbortController();
	const response = await runWithProxy("", () => fetchRemoteUrl(`http://${hostname}:${allowed.port}/body`, { signal: controller.signal }, {
		allowRanges: [`${checked}/32`], lookup: async () => [{ address: checked, family: 4 }],
	}));
	const body = response.text();
	const rejected = assert.rejects(body, { name: "AbortError" });
	controller.abort();
	await rejected;
	assert.equal(allowed.calls.length, 1);
});

test("actual untrusted HTTP proxy CONNECT uses the checked address and original Host and body", { skip: curlSkip, timeout: 5000 }, async (t) => {
	const allowed = await origin(t, checked);
	const attacker = await origin(t, rebound, allowed.port);
	const proxy = await httpProxy(t);
	let lookups = 0;
	const body = new Uint8Array([0, 255, 34, 92]);
	const response = await fetchRemoteUrl(`http://${hostname}:${allowed.port}/resource`, {
		method: "POST", body, headers: { "X-Api-Key": "synthetic-only" }, signal: AbortSignal.timeout(3000),
	}, {
		proxy: proxy.url, trustEnvProxy: true, allowRanges: [`${checked}/32`],
		lookup: async () => { lookups++; return [{ address: checked, family: 4 }]; },
	});
	assert.equal(await response.text(), checked);
	assert.equal(lookups, 1, "an arbitrary per-call proxy does not acquire operator trust");
	assert.deepEqual(proxy.tunnels, [`${checked}:${allowed.port}`]);
	assert.deepEqual(proxy.forwards, []);
	assert.equal(allowed.calls[0].host, `${hostname}:${allowed.port}`);
	assert.equal(allowed.calls[0].headers["x-api-key"], "synthetic-only");
	assert.deepEqual(allowed.calls[0].body, Buffer.from(body));
	assert.equal(attacker.calls.length, 0);
});

test("a strict forward-only HTTP proxy fails without a forward or direct fallback", { skip: curlSkip, timeout: 5000 }, async (t) => {
	const allowed = await origin(t, checked);
	const proxy = await httpProxy(t, { connectAllowed: false });
	await assert.rejects(fetchRemoteUrl(`http://${hostname}:${allowed.port}/resource`, { signal: AbortSignal.timeout(3000) }, {
		proxy: proxy.url, allowRanges: [`${checked}/32`], lookup: async () => [{ address: checked, family: 4 }],
	}), /Strict DNS pinning requires CONNECT support/);
	assert.deepEqual(proxy.tunnels, [`${checked}:${allowed.port}`]);
	assert.deepEqual(proxy.forwards, []);
	assert.equal(allowed.calls.length, 0);
});

test("actual SOCKS4/4a/5/5h handshakes all dial the checked numeric destination", { skip: curlSkip, timeout: 8000 }, async (t) => {
	const allowed = await origin(t, checked);
	const attacker = await origin(t, rebound, allowed.port);
	for (const protocol of ["socks4", "socks4a", "socks5", "socks5h"]) {
		await t.test(protocol, async sub => {
			const proxy = await socksProxy(sub);
			const response = await fetchRemoteUrl(`http://${hostname}:${allowed.port}/${protocol}`, { signal: AbortSignal.timeout(3000) }, {
				proxy: `${protocol}://${checked}:${proxy.port}`, allowRanges: [`${checked}/32`], lookup: async () => [{ address: checked, family: 4 }],
			});
			assert.equal(await response.text(), checked);
			assert.deepEqual(proxy.destinations, [{ address: checked, port: allowed.port }]);
			assert.equal(allowed.calls.at(-1).host, `${hostname}:${allowed.port}`);
		});
	}
	assert.equal(attacker.calls.length, 0);
});

test("operator-trusted remote-DNS forward proxy remains opt-in while literal targets stay checked", { skip: curlSkip, timeout: 5000 }, async (t) => {
	const proxy = await httpProxy(t, { connectAllowed: false });
	environment(t, { HTTP_PROXY: proxy.url, NO_PROXY: "", no_proxy: "" });
	const url = `http://${hostname}/resource`;
	const response = await fetchRemoteUrl(url, { signal: AbortSignal.timeout(3000) }, {
		trustEnvProxy: true, lookup: async () => { throw new Error("trusted remote DNS must not use local lookup"); },
	});
	assert.equal(await response.text(), "remote DNS proxy");
	assert.deepEqual(proxy.forwards, [url]);
	assert.deepEqual(proxy.tunnels, []);
	await assert.rejects(fetchRemoteUrl("http://127.0.0.2/resource", {}, { trustEnvProxy: true }), /Blocked internal address/);
	assert.deepEqual(proxy.forwards, [url], "literal deny runs before the trusted proxy packet");
});

test("port-aware NO_PROXY removes remote-DNS trust and pins the actual direct route", { skip: curlSkip, timeout: 5000 }, async (t) => {
	const allowed = await origin(t, checked);
	const proxy = await httpProxy(t);
	environment(t, { HTTP_PROXY: proxy.url, NO_PROXY: `${hostname}:${allowed.port}`, no_proxy: "" });
	let lookups = 0;
	const response = await fetchRemoteUrl(`http://${hostname}:${allowed.port}/resource`, { signal: AbortSignal.timeout(3000) }, {
		trustEnvProxy: true, allowRanges: [`${checked}/32`], lookup: async () => { lookups++; return [{ address: checked, family: 4 }]; },
	});
	assert.equal(await response.text(), checked);
	assert.equal(lookups, 1);
	assert.deepEqual(proxy.tunnels, []);
	assert.deepEqual(proxy.forwards, []);
	assert.equal(allowed.calls.length, 1);
});
