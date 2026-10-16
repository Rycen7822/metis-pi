import { redactSearchFailure } from "./search-error-redaction.ts";
import { SearchHttpError } from "./search-types.ts";
import { webFetch as fetch } from "./proxy-transport.ts";
import { normalizeDomainFilters } from "./domain-filter-normalization.ts";
import { loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import type { ExtractedContent, ExtractOptions } from "./content.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";

const SEARCH1API_SEARCH_URL = "https://api.search1api.com/search";
const SEARCH1API_CRAWL_URL = "https://api.search1api.com/crawl";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const CRAWL_TIMEOUT_MS = 60_000;

interface WebSearchConfig {
	search1apiApiKey?: unknown;
}

interface Search1APISearchResult {
	title?: string | null;
	link?: string | null;
	snippet?: string | null;
	content?: string | null;
}

interface Search1APISearchResponse {
	searchParameters?: Record<string, unknown>;
	results?: Search1APISearchResult[];
}

interface Search1APICrawlResult {
	title?: string | null;
	link?: string | null;
	content?: string | null;
	metadata?: Record<string, unknown>;
}

interface Search1APICrawlResponse {
	crawlParameters?: { url?: string };
	results?: Search1APICrawlResult;
}

interface Search1APISearchOptions extends SearchOptions {
	includeContent?: boolean;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	const key = await resolveCredential({
		provider: "Search1API",
		configuredValue: loadConfig().search1apiApiKey,
		environmentValue: process.env.SEARCH1API_KEY,
		signal,
	});
	if (!key) {
		throw new Error(
			"Search1API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "search1apiApiKey": "your-key" }\n` +
			"  2. Set SEARCH1API_KEY environment variable\n" +
			"Create a key at https://dashboard.search1api.com",
		);
	}
	return key;
}

export function isSearch1APIAvailable(): boolean {
	return hasCredentialSource({
		provider: "Search1API",
		configuredValue: loadConfig().search1apiApiKey,
		environmentValue: process.env.SEARCH1API_KEY,
	});
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function buildSearchBody(query: string, options: Search1APISearchOptions): Record<string, unknown> {
	const numResults = normalizeSearchResultCount(options.numResults);
	const { include: includeSites, exclude: excludeSites } = normalizeDomainFilters(options.domainFilter);
	return {
		query,
		max_results: numResults,
		crawl_results: options.includeContent ? numResults : 0,
		...(includeSites.length > 0 ? { include_sites: includeSites } : {}),
		...(excludeSites.length > 0 ? { exclude_sites: excludeSites } : {}),
		...(options.recencyFilter ? { time_range: options.recencyFilter } : {}),
	};
}

async function search1APIJsonRequest<T>(
	label: "Search" | "Crawl",
	url: string,
	apiKey: string,
	body: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(signal, timeoutMs),
		});
	} catch (err) {
		throw redactSearchFailure(err, apiKey).error;
	}

	const raw = await response.text();
	if (!response.ok) {
		throw new SearchHttpError(response.status, `Search1API ${label} API error ${response.status}: ${redactCredential(raw, apiKey).slice(0, 300)}`);
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`Search1API ${label} API returned invalid JSON`);
	}
}

function mapSearchResults(results: Search1APISearchResult[] | undefined): SearchResponse["results"] {
	if (!Array.isArray(results)) {
		throw new Error("Search1API Search API returned an unexpected response shape");
	}
	return results.flatMap((item) => {
		if (!item || typeof item.link !== "string" || item.link.trim().length === 0) return [];
		const url = item.link.trim();
		return [{
			title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : url,
			url,
			snippet: typeof item.snippet === "string" ? item.snippet.replace(/\s+/g, " ").trim() : "",
		}];
	});
}

function mapInlineContent(results: Search1APISearchResult[] | undefined): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		if (!item || typeof item.link !== "string" || item.link.trim().length === 0) return [];
		if (typeof item.content !== "string" || item.content.trim().length === 0) return [];
		return [{
			url: item.link.trim(),
			title: typeof item.title === "string" ? item.title.trim() : "",
			content: item.content,
			error: null,
		}];
	});
}

export async function searchWithSearch1API(
	query: string,
	options: Search1APISearchOptions = {},
): Promise<SearchResponse> {
	const apiKey = await getApiKey(options.signal);
	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		const data = await search1APIJsonRequest<Search1APISearchResponse>(
			"Search",
			SEARCH1API_SEARCH_URL,
			apiKey,
			buildSearchBody(query, options),
			SEARCH_TIMEOUT_MS,
			options.signal,
		);
		const results = mapSearchResults(data.results);
		const response: SearchResponse = { answer: formatSearchResultsAsAnswer(results), results };
		if (options.includeContent) {
			const inlineContent = mapInlineContent(data.results);
			if (inlineContent.length > 0) response.inlineContent = inlineContent;
		}
		activityMonitor.logComplete(activityId, 200);
		return response;
	} catch (err) {
		const failure = redactSearchFailure(err, apiKey);
		if (failure.message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, failure.message);
		throw failure.error;
	}
}

export async function extractWithSearch1API(
	url: string,
	signal?: AbortSignal,
	options: ExtractOptions = {},
): Promise<ExtractedContent | null> {
	const apiKey = await getApiKey(signal);
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	try {
		const data = await search1APIJsonRequest<Search1APICrawlResponse>(
			"Crawl",
			SEARCH1API_CRAWL_URL,
			apiKey,
			{ url },
			typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
				? Math.max(1, Math.floor(options.timeoutMs))
				: CRAWL_TIMEOUT_MS,
			signal,
		);
		const result = data.results;
		if (!result || typeof result !== "object") {
			throw new Error("Search1API Crawl API returned an unexpected response shape");
		}
		const content = typeof result.content === "string" ? result.content.trim() : "";
		if (!content) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}
		activityMonitor.logComplete(activityId, 200);
		return {
			url,
			title: typeof result.title === "string" ? result.title.trim() : "",
			content,
			error: null,
		};
	} catch (err) {
		const failure = redactSearchFailure(err, apiKey);
		if (failure.message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, failure.message);
		throw failure.error;
	}
}
