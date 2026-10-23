import { errorMessage, redactSearchFailure } from "./search-error-redaction.ts";
import { SearchHttpError } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter, buildSiteFilteredQuery } from "./domain-filter-normalization.ts";
import { GOOGLE_RECENCY_TBS, loadWebAccessConfig, fetchWithCredentialRedirects, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential, requireProviderCredential } from "./credential-source.ts";

const SERPLY_SEARCH_URL = "https://api.serply.io/v1/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;


interface WebSearchConfig {
	serplyApiKey?: unknown;
}

interface SerplyOrganicResult {
	title?: unknown;
	link?: unknown;
	description?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Serply",
		configuredValue: loadConfig().serplyApiKey,
		environmentValue: process.env.SERPLY_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	return requireProviderCredential(await getApiKey(signal), {
		provider: "Serply", configPath: CONFIG_PATH,
		configKey: "serplyApiKey", envVar: "SERPLY_API_KEY",
		keyInstructions: "Get a key at https://serply.io",
	});
}

function invalidResponse(message: string): Error {
	return new Error(`Serply returned invalid response: ${message}`);
}

function parseResponse(value: unknown): SerplyOrganicResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (typeof envelope.detail === "string" && envelope.detail.trim()) throw invalidResponse(envelope.detail.trim());
	if (!Array.isArray(envelope.results)) throw invalidResponse("expected results array");
	return envelope.results as SerplyOrganicResult[];
}

export function isSerplyAvailable(): boolean {
	return hasCredentialSource({ provider: "Serply", configuredValue: loadConfig().serplyApiKey, environmentValue: process.env.SERPLY_API_KEY });
}

export async function searchWithSerply(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const requestCount = options.domainFilter?.length ? Math.min(20, numResults + 5) : numResults;
	const url = new URL(SERPLY_SEARCH_URL);
	url.searchParams.set("q", buildSiteFilteredQuery(query, filters));
	url.searchParams.set("num", String(requestCount));
	if (options.recencyFilter) url.searchParams.set("tbs", GOOGLE_RECENCY_TBS[options.recencyFilter]);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: SerplyOrganicResult[];
	try {
		response = await fetchWithCredentialRedirects(String(url), {
			headers: { Accept: "application/json", "X-Api-Key": apiKey },
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, ["X-Api-Key"]);
		if (!response.ok) {
			const errorText = await response.text();
			throw new SearchHttpError(response.status, `Serply error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
			throw new Error("Serply returned invalid JSON");
		}
		entries = parseResponse(rawData);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`Serply request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
			: redactSearchFailure(err instanceof Error ? err : new Error(errorMessage(err)), apiKey).error;
		activityMonitor.logError(activityId, redactCredential(errorMessage(outgoing), apiKey));
		throw outgoing;
	}
	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResponse["results"] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.link !== "string" || !entry.link) continue;
		let resultUrl: URL;
		try {
			resultUrl = new URL(entry.link);
		} catch {
			continue;
		}
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		if (!matchesDomainFilter(resultUrl, filters)) continue;
		results.push({
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: typeof entry.description === "string" ? entry.description : "",
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
