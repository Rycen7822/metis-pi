import { join } from "node:path";
import { metisConfigPath } from "../configuration/store.ts";
import { readWebAccessConfig, updateWebAccessConfig } from "../configuration/web-access.ts";
import { webAccessAgentDir, WEB_CREDENTIALS_FILE } from "../configuration/web-access.ts";
import { webFetch } from "./proxy-transport.ts";
import { isLoopbackHostname } from "./hostname.ts";

export function getWebSearchConfigDir(): string {
	return webAccessAgentDir();
}

export function getWebSearchConfigPath(): string {
	return join(getWebSearchConfigDir(), WEB_CREDENTIALS_FILE);
}

export function getWebAccessConfigPath(): string {
	return metisConfigPath(getWebSearchConfigDir());
}

export function loadWebAccessConfig(): Record<string, any> {
	return readWebAccessConfig(getWebSearchConfigDir());
}

export function saveWebAccessConfig(patch: Record<string, unknown>): void {
	updateWebAccessConfig(getWebSearchConfigDir(), patch);
}

export function normalizeSearchBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		url.pathname = url.pathname.replace(/\/+$/, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

function isValidHeaderValue(value: string): boolean {
	try {
		new Headers({ "x-pi-web-access-validation": value });
		return true;
	} catch {
		return false;
	}
}

export function normalizeSearchHeaders(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const headers: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
		if (typeof headerValue !== "string") continue;
		const name = key.trim();
		// RFC 7230 token chars only — reject empty or malformed header names.
		if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
		if (!isValidHeaderValue(headerValue)) continue;
		// Fetch strips surrounding whitespace before sending; store the sent form so
		// redaction matches what an upstream error body can echo back.
		headers[name] = headerValue.trim();
	}
	return headers;
}

interface ApiBaseUrlOptions {
	configKey: string;
	configuredValue: unknown;
	defaultValue: string;
	environmentKey: string;
	environmentValue: string | undefined;
}

export function resolveApiBaseUrl(options: ApiBaseUrlOptions): string {
	const fromEnvironment = options.environmentValue !== undefined;
	const value = fromEnvironment ? options.environmentValue : options.configuredValue;
	if (value === undefined) return options.defaultValue;

	const source = fromEnvironment
		? options.environmentKey
		: `webAccess.${options.configKey} in ${getWebAccessConfigPath()}`;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${source} must be an absolute HTTP(S) URL`);
	}

	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(`${source} must be an absolute HTTP(S) URL`);
	}
	if (url.protocol !== "https:" && (url.protocol !== "http:" || !isLoopbackHostname(url.hostname))) {
		throw new Error(`${source} must be an absolute HTTPS URL`);
	}
	if (url.username || url.password) {
		throw new Error(`${source} must not include credentials`);
	}
	if (url.search || url.hash) {
		throw new Error(`${source} must not include query parameters or fragments`);
	}

	url.search = "";
	url.hash = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/+$/, "");
}

const API_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const API_REQUEST_BODY_HEADERS = ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type"];
const MAX_API_REDIRECTS = 5;

export async function fetchWithCredentialRedirects(
	url: string,
	init: RequestInit,
	credentialHeaders: readonly string[],
	credentialQueryParameters: readonly string[] = [],
): Promise<Response> {
	let current = new URL(url);
	let requestInit = init;

	for (let redirects = 0; ; redirects++) {
		const response = await webFetch(current, { ...requestInit, redirect: "manual" });
		if (!API_REDIRECT_STATUSES.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === MAX_API_REDIRECTS) {
			throw new Error(`Too many API redirects from ${url}`);
		}

		const next = new URL(location, current);
		if (next.protocol !== "http:" && next.protocol !== "https:") {
			throw new Error(`API redirect from ${current.origin} must use HTTP(S)`);
		}
		const method = requestInit.method?.toUpperCase() ?? "GET";
		if (
			((response.status === 301 || response.status === 302) && method === "POST")
			|| (response.status === 303 && method !== "GET" && method !== "HEAD")
		) {
			const headers = new Headers(requestInit.headers);
			for (const name of API_REQUEST_BODY_HEADERS) headers.delete(name);
			const { body: _body, ...withoutBody } = requestInit;
			requestInit = { ...withoutBody, method: "GET", headers };
		}
		if (next.origin !== current.origin) {
			for (const name of credentialQueryParameters) next.searchParams.delete(name);
			const headers = new Headers(requestInit.headers);
			for (const name of credentialHeaders) headers.delete(name);
			requestInit = { ...requestInit, headers };
		}
		current = next;
	}
}

export const GOOGLE_RECENCY_TBS: Record<string, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};
