import { SearchHttpError } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter, type DomainFilters } from "./domain-filter-normalization.ts";
import { loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import { fetchRemoteUrl, loadSsrfConfig } from "./ssrf-protection.ts";
import type { SearchOptions, SearchResult, SearchResponse } from "./search-types.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { redactCredential } from "./credential-source.ts";

const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;

interface WebSearchConfig {
	searxngBaseUrl?: unknown;
	searxngHeaders?: unknown;
}

interface SearXNGResult {
	title?: string;
	url?: string;
	content?: string;
}

interface SearXNGResponse {
	results?: SearXNGResult[];
	answers?: string[];
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

function normalizeBaseUrl(value: unknown): string | null {
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

function getBaseUrl(): string | null {
	const configured = process.env.SEARXNG_BASE_URL;
	return configured !== undefined
		? normalizeBaseUrl(configured)
		: normalizeBaseUrl(loadConfig().searxngBaseUrl);
}

function isValidHeaderValue(value: string): boolean {
	try {
		new Headers({ "x-pi-web-access-validation": value });
		return true;
	} catch {
		return false;
	}
}

function normalizeHeaders(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const headers: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
		if (typeof headerValue !== "string") continue;
		const name = key.trim();
		// RFC 7230 token chars only — reject empty or malformed header names.
		if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
		if (!isValidHeaderValue(headerValue)) continue;
		headers[name] = headerValue.trim();
	}
	return headers;
}

function getConfiguredHeaders(): Record<string, string> {
	return normalizeHeaders(loadConfig().searxngHeaders);
}

function mergeDefaultHeaders(configured: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	for (const [name, value] of Object.entries(configured)) {
		for (const existing of Object.keys(headers)) {
			if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
		}
		headers[name] = value;
	}
	return headers;
}

function requireBaseUrl(): string {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"SearXNG base URL is invalid or missing. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "searxngBaseUrl": "https://search.example.com" }\n` +
			"  2. Set SEARXNG_BASE_URL to an HTTP(S) URL",
		);
	}
	return baseUrl;
}

function buildSearXNGQuery(query: string, filters: DomainFilters): string {
	const parts = [query];
	if (filters.include.length === 1) {
		parts.push(`site:${filters.include[0]}`);
	} else if (filters.include.length > 1) {
		parts.push(filters.include.map(domain => `site:${domain}`).join(" OR "));
	}
	for (const domain of filters.exclude) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

function mapTimeRange(recencyFilter: SearchOptions["recencyFilter"]): string | null {
	return recencyFilter === "day" || recencyFilter === "week" || recencyFilter === "month" || recencyFilter === "year"
		? recencyFilter
		: null;
}

export function isSearXNGAvailable(): boolean {
	const baseUrl = getBaseUrl();
	if (baseUrl === null) return false;
	loadSsrfConfig();
	return true;
}

export async function searchWithSearXNG(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const baseUrl = requireBaseUrl();
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const searchQuery = buildSearXNGQuery(query, filters);
	const url = new URL(`${baseUrl}/search`);
	url.searchParams.set("q", searchQuery);
	url.searchParams.set("format", "json");
	const timeRange = mapTimeRange(options.recencyFilter);
	if (timeRange) url.searchParams.set("time_range", timeRange);
	const configuredHeaders = getConfiguredHeaders();
	const headers = mergeDefaultHeaders(configuredHeaders);
	const secrets = Object.values(configuredHeaders);
	const redact = (text: string) => secrets.reduce((message, secret) => redactCredential(message, secret), text);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });

	try {
		const response = await fetchRemoteUrl(url, {
			method: "GET",
			headers,
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		}, {
			...loadSsrfConfig(),
			onRedirect: ({ from, to, init }) => from.origin === to.origin ? init : { ...init, headers: { Accept: "application/json" } },
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = redact(await response.text());
			throw new SearchHttpError(response.status, `SearXNG search error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		let data: SearXNGResponse;
		try {
			data = await response.json() as SearXNGResponse;
		} catch (err) {
			if (options.signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) throw err;
			throw new Error("SearXNG returned invalid JSON");
		}

		activityMonitor.logComplete(activityId, response.status);
		const results: SearchResult[] = [];
		for (const item of data.results ?? []) {
			if (!item.url || !matchesDomainFilter(item.url, filters)) continue;
			results.push({ title: item.title || item.url, url: item.url, snippet: item.content || "" });
			if (results.length >= numResults) break;
		}

		const answerParts = (data.answers ?? []).filter((answer): answer is string => typeof answer === "string" && answer.trim().length > 0).map(answer => answer.trim());
		answerParts.push(...results.map(result => result.snippet
			? `${result.snippet}\nSource: ${result.title} (${result.url})`
			: `Source: ${result.title} (${result.url})`));
		return { answer: answerParts.join("\n\n"), results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const safeMessage = redact(message);
		if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, safeMessage);
		if (safeMessage === message) throw err;
		if (err instanceof SearchHttpError) throw new SearchHttpError(err.status, safeMessage);
		if (err instanceof TypeError) throw new TypeError(safeMessage);
		const safeError = new Error(safeMessage);
		if (err instanceof Error) safeError.name = err.name;
		throw safeError;
	}
}
