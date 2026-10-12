import { SearchHttpError } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter, type DomainFilters } from "./domain-filter-normalization.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { loadWebAccessConfig, getWebSearchConfigPath, fetchWithCredentialRedirects } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";

const SERPBASE_API_URL = "https://api.serpbase.dev/google/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const RECENCY_TBS: Record<string, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

interface WebSearchConfig {
	serpbaseApiKey?: unknown;
}

interface SerpBaseOrganicResult {
	title?: unknown;
	link?: unknown;
	url?: unknown;
	snippet?: unknown;
	description?: unknown;
}

interface SerpBaseResponse {
	organic_results?: SerpBaseOrganicResult[];
	organic?: SerpBaseOrganicResult[];
	results?: SerpBaseOrganicResult[];
	status?: unknown;
	error?: unknown;
	message?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "SerpBase",
		configuredValue: loadConfig().serpbaseApiKey,
		environmentValue: process.env.SERPBASE_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"SerpBase API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "serpbaseApiKey": "your-key" }\n` +
			"  2. Set SERPBASE_API_KEY environment variable\n" +
			"Get a key at https://serpbase.dev",
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
	return new Error(`SerpBase API returned invalid response: ${message}`);
}

function parseResponse(value: unknown): SerpBaseResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as SerpBaseResponse;
	if (typeof envelope.error === "string" && envelope.error.trim()) {
		const suffix = typeof envelope.status === "number" || typeof envelope.status === "string" ? ` (status ${envelope.status})` : "";
		throw invalidResponse(`${envelope.error}${suffix}`);
	}
	const organic = envelope.organic_results ?? envelope.organic ?? envelope.results;
	if (!Array.isArray(organic)) throw invalidResponse("expected organic_results array");
	return { ...envelope, organic_results: organic };
}

export function isSerpBaseAvailable(): boolean {
	return hasCredentialSource({ provider: "SerpBase", configuredValue: loadConfig().serpbaseApiKey, environmentValue: process.env.SERPBASE_API_KEY });
}

export async function searchWithSerpBase(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const url = new URL(SERPBASE_API_URL);
	url.searchParams.set("q", buildQuery(query, filters));
	// SerpBase's Google Search endpoint authenticates with an `api_key` query parameter.
	url.searchParams.set("api_key", apiKey);
	url.searchParams.set("num", String(numResults));
	if (options.recencyFilter && RECENCY_TBS[options.recencyFilter]) url.searchParams.set("tbs", RECENCY_TBS[options.recencyFilter]);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	try {
		const response = await fetchWithCredentialRedirects(url.toString(), {
			headers: { Accept: "application/json" },
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, [], ["api_key"]);
		if (!response.ok) {
			const errorText = redactCredential(await response.text(), apiKey);
			throw new SearchHttpError(response.status, `SerpBase API error ${response.status}: ${errorText.slice(0, 300)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (options.signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) throw err;
			throw new Error("SerpBase API returned invalid JSON");
		}
		const data = parseResponse(rawData);
		const results: SearchResponse["results"] = [];
		for (const item of data.organic_results ?? []) {
			if (!item || typeof item !== "object") continue;
			const resultUrl = typeof item.link === "string" ? item.link : typeof item.url === "string" ? item.url : "";
			if (!resultUrl || !matchesDomainFilter(resultUrl, filters)) continue;
			results.push({
				title: typeof item.title === "string" && item.title.trim() ? item.title : `Source ${results.length + 1}`,
				url: resultUrl,
				snippet: typeof item.snippet === "string" ? item.snippet : typeof item.description === "string" ? item.description : "",
			});
			if (results.length >= numResults) break;
		}
		activityMonitor.logComplete(activityId, response.status);
		return { answer: formatSearchResultsAsAnswer(results), results };
	} catch (err) {
		if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError" && !timeoutSignal.aborted)) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		const safeMessage = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError")
			? "SerpBase request timed out after 60s" : redactCredential(message, apiKey);
		const outgoing = safeMessage === message && err instanceof Error ? err
			: err instanceof SearchHttpError ? new SearchHttpError(err.status, safeMessage)
			: err instanceof TypeError ? new TypeError(safeMessage) : new Error(safeMessage);
		if (outgoing instanceof SearchHttpError) activityMonitor.logComplete(activityId, outgoing.status);
		else activityMonitor.logError(activityId, safeMessage);
		throw outgoing;
	}
}
