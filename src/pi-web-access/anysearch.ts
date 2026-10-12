import { redactSearchFailure } from "./search-error-redaction.ts";
import { SearchHttpError, SearchUnsupportedFilterError } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter } from "./domain-filter-normalization.ts";
import { webFetch as fetch } from "./proxy-transport.ts";
import { loadWebAccessConfig } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import type { ExtractedContent } from "./content.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { redactCredential, resolveCredential } from "./credential-source.ts";

const ANYSEARCH_API_URL = "https://api.anysearch.com/v1/search";
const SEARCH_TIMEOUT_MS = 30_000;

interface WebSearchConfig {
	anysearchApiKey?: unknown;
}

interface AnySearchResult {
	title: string;
	url: string;
	snippet: string;
	content: string;
}

interface AnySearchSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

interface AnySearchResponse {
	code: 0;
	data: {
		results: AnySearchResult[];
		metadata: Record<string, unknown>;
	};
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "AnySearch",
		configuredValue: loadConfig().anysearchApiKey,
		environmentValue: process.env.ANYSEARCH_API_KEY,
		signal,
	});
}

function invalidResponse(message: string): Error {
	return new Error(`AnySearch API returned invalid response: ${message}`);
}

function parseResponse(value: unknown): AnySearchResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw invalidResponse("expected an object envelope");
	}
	const envelope = value as Record<string, unknown>;
	if (envelope.code !== 0) throw invalidResponse("expected code 0");
	if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
		throw invalidResponse("expected data object");
	}
	const data = envelope.data as Record<string, unknown>;
	if (!Array.isArray(data.results)) throw invalidResponse("expected data.results array");
	if (!data.metadata || typeof data.metadata !== "object" || Array.isArray(data.metadata)) {
		throw invalidResponse("expected data.metadata object");
	}

	const results: AnySearchResult[] = [];
	for (const [index, value] of data.results.entries()) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw invalidResponse(`expected data.results[${index}] object`);
		}
		const result = value as Record<string, unknown>;
		const { title, url, snippet, content } = result;
		if (typeof title !== "string") throw invalidResponse(`expected data.results[${index}].title string`);
		if (typeof url !== "string") throw invalidResponse(`expected data.results[${index}].url string`);
		if (typeof snippet !== "string") throw invalidResponse(`expected data.results[${index}].snippet string`);
		if (content !== undefined && content !== null && typeof content !== "string") {
			throw invalidResponse(`expected data.results[${index}].content string`);
		}
		if (!url) throw invalidResponse(`expected data.results[${index}].url to be non-empty`);
		results.push({ title, url, snippet, content: typeof content === "string" ? content : "" });
	}

	return { code: 0, data: { results, metadata: data.metadata as Record<string, unknown> } };
}

export function isAnySearchAvailable(): boolean {
	return true;
}

export async function searchWithAnySearch(query: string, options: AnySearchSearchOptions = {}): Promise<SearchResponse> {
	if (options.recencyFilter) throw new SearchUnsupportedFilterError("AnySearch search adapter does not support recencyFilter");
	const apiKey = await getApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const hasDomains = filters.include.length > 0 || filters.exclude.length > 0;
	const body = { query, max_results: hasDomains ? 20 : numResults };
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;

	try {
		response = await fetch(ANYSEARCH_API_URL, {
			method: "POST",
			headers: {
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});
	} catch (err) {
		const failure = redactSearchFailure(err, apiKey);
		if (failure.message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, failure.message);
		throw failure.error;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new SearchHttpError(response.status, `AnySearch API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let rawData: unknown;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
		throw new Error("AnySearch API returned invalid JSON");
	}

	let data: AnySearchResponse;
	try {
		data = parseResponse(rawData);
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw err;
	}

	activityMonitor.logComplete(activityId, response.status);
	const retained = data.data.results.filter(result => matchesDomainFilter(result.url, filters)).slice(0, numResults);
	const results = retained.map((result) => ({
		title: result.title,
		url: result.url,
		snippet: result.snippet,
	}));
	const mapped: SearchResponse = { answer: formatSearchResultsAsAnswer(results), results };
	if (options.includeContent) {
		const inlineContent: ExtractedContent[] = retained
			.filter(result => result.content.length > 0)
			.map(result => ({ url: result.url, title: result.title, content: result.content, error: null }));
		if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
	}
	return mapped;
}
