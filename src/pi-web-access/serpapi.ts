import { SearchHttpError } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter, type DomainFilters } from "./domain-filter-normalization.ts";
import { loadWebAccessConfig, getWebSearchConfigPath, fetchWithCredentialRedirects } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";

const SERPAPI_SEARCH_URL = "https://serpapi.com/search.json";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const RECENCY_TBS: Record<NonNullable<SearchOptions["recencyFilter"]>, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

interface WebSearchConfig {
	serpapiApiKey?: unknown;
}

interface SerpApiOrganicResult {
	title?: unknown;
	link?: unknown;
	snippet?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "SerpApi",
		configuredValue: loadConfig().serpapiApiKey,
		environmentValue: process.env.SERPAPI_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"SerpApi API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "serpapiApiKey": "your-key" }\n` +
			"  2. Set SERPAPI_KEY environment variable\n" +
			"Get a key at https://serpapi.com/manage-api-key",
		);
	}
	return apiKey;
}

function buildQuery(query: string, filters: DomainFilters): string {
	const parts = [query];
	if (filters.include.length === 1) parts.push(`site:${filters.include[0]}`);
	if (filters.include.length > 1) parts.push(`(${filters.include.map(domain => `site:${domain}`).join(" OR ")})`);
	for (const domain of filters.exclude) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`SerpApi returned invalid response: ${message}`);
}

function parseResponse(value: unknown): SerpApiOrganicResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (typeof envelope.error === "string" && envelope.error.trim()) throw invalidResponse(envelope.error.trim());
	if (!Array.isArray(envelope.organic_results)) throw invalidResponse("expected organic_results array");
	return envelope.organic_results as SerpApiOrganicResult[];
}

export function isSerpApiAvailable(): boolean {
	return hasCredentialSource({ provider: "SerpApi", configuredValue: loadConfig().serpapiApiKey, environmentValue: process.env.SERPAPI_KEY });
}

export async function searchWithSerpApi(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const requestCount = options.domainFilter?.length ? Math.min(20, numResults + 5) : numResults;
	const url = new URL(SERPAPI_SEARCH_URL);
	url.searchParams.set("engine", "google");
	url.searchParams.set("q", buildQuery(query, filters));
	url.searchParams.set("api_key", apiKey);
	url.searchParams.set("num", String(requestCount));
	if (options.recencyFilter) url.searchParams.set("tbs", RECENCY_TBS[options.recencyFilter]);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: SerpApiOrganicResult[];
	try {
		response = await fetchWithCredentialRedirects(url.toString(), {
			headers: { Accept: "application/json" },
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, [], ["api_key"]);
		if (!response.ok) {
			const errorText = await response.text();
			throw new SearchHttpError(response.status, `SerpApi error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
			throw new Error("SerpApi returned invalid JSON");
		}
		entries = parseResponse(rawData);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`SerpApi request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
			: (() => {
				const redactedMessage = redactCredential(message, apiKey);
				if (redactedMessage === message && err instanceof Error) return err;
				const redactedError = err instanceof SearchHttpError
					? new SearchHttpError(err.status, redactedMessage)
					: new Error(redactedMessage);
				if (err instanceof Error) redactedError.name = err.name;
				return redactedError;
			})();
		activityMonitor.logError(activityId, redactCredential(errorMessage(outgoing), apiKey));
		throw outgoing;
	}
	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResponse["results"] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.link !== "string" || !entry.link) continue;
		if (!matchesDomainFilter(entry.link, filters)) continue;
		results.push({
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Source ${results.length + 1}`,
			url: entry.link,
			snippet: typeof entry.snippet === "string" ? entry.snippet : "",
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
