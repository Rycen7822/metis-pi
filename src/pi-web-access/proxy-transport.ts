import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWebAccessConfig, webAccessAgentDir } from "../configuration/web-access.ts";
import type { Dispatcher } from "undici";

const proxyStorage = new AsyncLocalStorage<string | null>();

export function normalizeProxyUrl(value: unknown, source: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error(`${source} must be an http(s) or socks proxy URL string`);
	const trimmed = value.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`${source} must be a valid proxy URL: ${JSON.stringify(trimmed)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:" &&
		parsed.protocol !== "socks4:" && parsed.protocol !== "socks4a:" &&
		parsed.protocol !== "socks5:" && parsed.protocol !== "socks5h:") {
		throw new Error(`${source} must use the http://, https://, or socks scheme: ${trimmed}`);
	}
	if (!parsed.hostname) throw new Error(`${source} must include a proxy host: ${trimmed}`);
	parsed.hash = "";
	parsed.search = "";
	return parsed.toString();
}

function redactProxyUrl(value: string): string {
	const parsed = new URL(value);
	if (parsed.username) parsed.username = "redacted";
	if (parsed.password) parsed.password = "redacted";
	return parsed.toString();
}

export function loadConfiguredProxy(): string | null {
	const configured = readWebAccessConfig(webAccessAgentDir()).proxy;
	if (configured === undefined) return null;
	return normalizeProxyUrl(configured, "webAccess.proxy");
}

export function runWithProxy<T>(proxy: string | undefined, fn: () => T): T {
	if (proxy === undefined) {
		const configured = loadConfiguredProxy();
		if (configured === null) return fn();
		return proxyStorage.run(configured, fn);
	}
	const normalized = normalizeProxyUrl(proxy, "proxy");
	return proxyStorage.run(normalized, fn);
}

export function getActiveProxy(): string | null {
	return proxyStorage.getStore() ?? null;
}

export function hasScopedProxyDecision(): boolean {
	return proxyStorage.getStore() !== undefined;
}

function noProxyEntryMatches(hostname: string, port: string, entry: string): boolean {
	const trimmed = entry.trim();
	if (!trimmed) return false;
	if (trimmed === "*") return true;
	let host = trimmed;
	let entryPort: string | undefined;
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close < 0) return false;
		const suffix = host.slice(close + 1);
		if (suffix && !/^:\d+$/.test(suffix)) return false;
		if (suffix) entryPort = suffix.slice(1);
		host = host.slice(0, close + 1);
	} else {
		const colon = host.lastIndexOf(":");
		if (colon > -1 && /^\d+$/.test(host.slice(colon + 1))) {
			entryPort = host.slice(colon + 1);
			host = host.slice(0, colon);
		}
	}
	if (entryPort !== undefined && entryPort !== port) return false;
	host = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!host) return false;
	if (hostname === host) return true;
	const suffix = host.startsWith("*.") ? host.slice(1) : host.startsWith(".") ? host : `.${host}`;
	return hostname.endsWith(suffix);
}

/** One routing policy for the transport and the SSRF proxy-trust preflight. */
export function isProxyBypassedUrl(url: URL): boolean {
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1") return true;
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	const noProxy = process.env.NO_PROXY || process.env.no_proxy;
	return Boolean(noProxy && noProxy.split(",").some(entry => noProxyEntryMatches(hostname, port, entry)));
}

export interface ProxiedRequestInit extends RequestInit {
	/** Caller-supplied proxy; bypasses AsyncLocalStorage for pLimit-safe contexts. */
	__proxy?: string;
	/** One checked URL/hop, frozen together with its actual proxy/DNS route. */
	__validated?: { url: string; proxy: string | null; addresses?: ReadonlyArray<{ address: string; family: number }> };
	dispatcher?: Dispatcher;
}

/** Snapshot the route actually used by Web fetch, including the operator's environment proxy. */
export function resolveWebProxy(url: URL, explicitProxy?: string): { proxy: string | null; operatorControlled: boolean; remoteDns: boolean } {
	const configured = loadConfiguredProxy();
	const scoped = proxyStorage.getStore();
	let proxy = explicitProxy !== undefined ? normalizeProxyUrl(explicitProxy, "proxy")
		: scoped !== undefined ? scoped : configured;
	let environment = false;
	if (proxy === null && explicitProxy === undefined && scoped === undefined && configured === null) {
		const candidates = url.protocol === "https:"
			? [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy]
			: [process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy];
		for (const candidate of candidates) {
			if (!candidate?.trim()) continue;
			try { proxy = normalizeProxyUrl(candidate, "proxy environment"); } catch { continue; }
			if (proxy) { environment = true; break; }
		}
	}
	if (isProxyBypassedUrl(url)) proxy = null;
	return { proxy, operatorControlled: proxy !== null && (environment || proxy === configured),
		remoteDns: proxy !== null && ["http:", "https:", "socks4a:", "socks5h:"].includes(new URL(proxy).protocol) };
}

/** Web-owned HTTP requests; a custom dispatcher stays paired with its own native fetch implementation. */
export async function webFetch(
	input: RequestInfo | URL,
	init?: ProxiedRequestInit,
	nativeFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
	let url: URL | null = null;
	try {
		url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
	} catch {
		url = null;
	}
	if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
		return nativeFetch(input, init);
	}
	if (init?.__validated && init.__validated.url !== url.toString()) throw new Error("Validated route belongs to a different URL");
	const proxy = init?.__validated ? init.__validated.proxy : resolveWebProxy(url, init?.__proxy).proxy;
	if (!proxy) return nativeFetch(input, init);
	if (input instanceof Request) {
		const request = new Request(input, init);
		request.signal.throwIfAborted();
		// Abort body buffering as well as the curl process.
		const body = request.body === null ? null : new Uint8Array(await new Response(
			request.body.pipeThrough(new TransformStream(), { signal: request.signal }),
		).arrayBuffer());
		init = { ...init, method: request.method, headers: request.headers, body, signal: request.signal, redirect: request.redirect };
	}
	return fetchViaCurl(url, init ?? {}, proxy);
}

// GET bodies are decoded by --compressed, so their length/encoding headers no longer match.
// HEAD has no body, and its Content-Length is usually why the caller asked.
function parseHeaderDump(dump: string, keepLengthHeaders: boolean): { status: number; statusText: string; headers: Array<[string, string]> } {
	const blocks = dump.split(/\r?\n\r?\n/).filter((block) => /^HTTP\/[\d.]+\s+\d{3}/.test(block.trim()));
	const block = (blocks.length > 0 ? blocks[blocks.length - 1] : "").trim();
	const lines = block.split(/\r?\n/);
	let status = 0;
	let statusText = "";
	const headers: Array<[string, string]> = [];
	for (const line of lines) {
		const match = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(line.trim());
		if (match) {
			status = Number(match[1]);
			statusText = match[2] ?? "";
			headers.length = 0;
			continue;
		}
		const separator = line.indexOf(":");
		if (separator > 0) {
			const name = line.slice(0, separator).trim();
			if (!keepLengthHeaders && (name.toLowerCase() === "content-encoding" || name.toLowerCase() === "content-length")) continue;
			headers.push([name, line.slice(separator + 1).trim()]);
		}
	}
	return { status, statusText, headers };
}

class CurlTransportError extends Error {}

function curlConfigValue(value: string): string {
	return `"${value.replace(/[\\"\t\n\r\v]/g, character => ({
		"\\": "\\\\", '"': '\\"', "\t": "\\t", "\n": "\\n", "\r": "\\r", "\v": "\\v",
	}[character]!))}"`;
}

async function fetchViaCurl(url: URL, init: RequestInit, proxyUrl: string): Promise<Response> {
	let current = url;
	let currentInit = init;
	for (let redirects = 0; ; redirects++) {
		const response = await fetchViaCurlOnce(current, currentInit, proxyUrl);
		const location = response.headers.get("location");
		if (!location || ![301, 302, 303, 307, 308].includes(response.status)) {
			if (redirects > 0) Object.defineProperty(response, "redirected", { value: true, configurable: true });
			return response;
		}
		if (currentInit.redirect === "manual") return response;
		if (currentInit.redirect === "error") throw new TypeError(`Proxy fetch redirect blocked from ${current.toString()}`);
		if (redirects === 20) throw new Error(`Too many proxy redirects from ${url.toString()}`);

		const next = new URL(location, current);
		if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error(`Proxy redirect from ${current.origin} must use HTTP(S)`);

		let headers = new Headers(currentInit.headers);
		let nextInit: RequestInit;
		const method = currentInit.method?.toUpperCase() ?? "GET";
		if (((response.status === 301 || response.status === 302) && method === "POST") || (response.status === 303 && method !== "GET" && method !== "HEAD")) {
			for (const name of ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type"]) headers.delete(name);
			const { body: _body, ...withoutBody } = currentInit;
			nextInit = { ...withoutBody, method: "GET", headers };
		} else {
			nextInit = { ...currentInit, headers };
		}

		if (next.origin !== current.origin) {
			headers = new Headers();
			nextInit = { ...nextInit, headers };
		}
		current = next;
		currentInit = nextInit;
	}
}

async function fetchViaCurlOnce(url: URL, init: RequestInit, proxyUrl: string): Promise<Response> {
	const method = (init.method ?? "GET").toUpperCase();
	const headers = new Headers(init.headers);

	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-proxy-"));
	const headerFile = join(dir, "headers");
	const bodyFile = join(dir, "body");
	const requestBodyFile = join(dir, "request-body");

	const args: string[] = [
		"--disable",
		"--silent",
		"--show-error",
		"--compressed",
		"--connect-timeout", "20",
		"-D", headerFile,
		"--output", bodyFile,
		"--write-out", "%{json}",
		"--config", "-",
	];
	// URLs (including query credentials), proxy credentials and headers belong in
	// the pipe, not in the process command line. The request body retains its file.
	const config = [`proxy = ${curlConfigValue(proxyUrl)}`, `noproxy = ""`, `url = ${curlConfigValue(url.toString())}`];
	const addresses = (init as ProxiedRequestInit).__validated?.addresses;
	if (addresses?.length) {
		const address = addresses[0].address;
		const target = address.includes(":") ? `[${address}]` : address;
		const port = url.port || (url.protocol === "https:" ? "443" : "80");
		// HTTP proxies use CONNECT to the checked numeric destination. SOCKS uses
		// that same numeric destination; Host, TLS SNI and certificate checks use URL.
		config.push(`connect-to = ${curlConfigValue(`${url.hostname}:${port}:${target}:${port}`)}`);
	}

	if (method === "HEAD") args.push("--head");
	else if (method !== "GET") args.push("-X", method);

	for (const [name, value] of headers.entries()) {
		if (value === "") continue;
		config.push(`header = ${curlConfigValue(`${name}: ${value}`)}`);
	}

	const body = init.body;
	if (body !== undefined && body !== null) {
		let buffer: Buffer;
		if (typeof body === "string") buffer = Buffer.from(body, "utf-8");
		else if (body instanceof URLSearchParams) buffer = Buffer.from(body.toString(), "utf-8");
		else if (body instanceof ArrayBuffer) buffer = Buffer.from(body);
		else if (ArrayBuffer.isView(body)) buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
		else throw new Error(`Unsupported request body type for proxy fetch: ${typeof body}`);
		await writeFile(requestBodyFile, buffer, { mode: 0o600 });
		args.push("--data-binary", `@${requestBodyFile}`);
		if (method === "GET") args.push("-X", "GET");
	} else if ((method === "POST" || method === "PUT") && !headers.has("content-length")) {
		// Native fetch sends a zero length for a bodyless POST/PUT; some origins answer 411 without it.
		config.push(`header = ${curlConfigValue("Content-Length: 0")}`);
	}

	const signal = init.signal ?? null;
	let stdout: string;
	try {
		stdout = await new Promise<string>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new DOMException("The operation was aborted.", "AbortError"));
				return;
			}
			const child = spawn("curl", args, { windowsHide: true });
			let out = "";
			let stderr = "";
			const onAbort = () => { try { child.kill(); } catch {} };
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf-8"); });
			child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf-8"); });
			child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code !== "EPIPE") reject(new CurlTransportError(`curl configuration pipe failed: ${err.message}`));
			});
			child.once("error", (err: NodeJS.ErrnoException) => {
				signal?.removeEventListener("abort", onAbort);
				reject(new CurlTransportError(err.code === "ENOENT"
					? "curl executable not found on PATH; proxy transport requires curl"
					: `curl failed to start: ${err.message}`));
			});
			child.once("close", (code) => {
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) return reject(new DOMException("The operation was aborted.", "AbortError"));
				if (code !== 0) {
					const pinHint = addresses?.length && ["http:", "https:"].includes(new URL(proxyUrl).protocol) && /CONNECT/i.test(stderr)
						? ". Strict DNS pinning requires CONNECT support; for an operator-controlled remote-DNS proxy, set ssrf.trustEnvProxy=true."
						: "";
					return reject(new CurlTransportError(`curl exited with code ${code ?? "unknown"} via ${redactProxyUrl(proxyUrl)}${stderr.trim() ? `: ${stderr.trim()}` : ""}${pinHint}`));
				}
				resolve(out);
			});
			child.stdin?.end(`${config.join("\n")}\n`);
		});
	} catch (err) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		if (err instanceof CurlTransportError) throw new Error(err.message);
		throw err;
	}

	let bodyBuffer = Buffer.alloc(0);
	let dump = "";
	try {
		[dump, bodyBuffer] = await Promise.all([readFile(headerFile, "utf-8"), readFile(bodyFile)]);
	} catch {
		// HEAD or empty responses may not produce output files.
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}

	const { status, statusText, headers: responseHeaders } = parseHeaderDump(dump, method === "HEAD");
	if (status === 0) {
		throw new Error(`Proxy fetch to ${url.toString()} via ${redactProxyUrl(proxyUrl)} returned no HTTP status`);
	}

	let finalUrl = url.toString();
	let redirected = false;
	try {
		const trimmed = stdout.trim();
		if (trimmed.startsWith("{")) {
			const writeOut = JSON.parse(trimmed) as { url_effective?: string; num_redirects?: number };
			if (writeOut.url_effective) finalUrl = writeOut.url_effective;
			redirected = (writeOut.num_redirects ?? 0) > 0;
		}
	} catch {
		// Older curl without %{json}; the header dump already provided the status.
	}

	const nullBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
	const response = new Response(nullBody ? null : new Uint8Array(bodyBuffer), {
		status,
		statusText: statusText || undefined,
		headers: new Headers(responseHeaders),
	});
	Object.defineProperty(response, "url", { value: finalUrl, configurable: true });
	Object.defineProperty(response, "redirected", { value: redirected, configurable: true });
	return response;
}
