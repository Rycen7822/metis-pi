import { redactSearchFailure } from "./search-error-redaction.ts";
import { SearchHttpError } from "./search-types.ts";
import { webFetch as fetch } from "./proxy-transport.ts";
import { normalizeDomainFilters, matchesDomainFilter } from "./domain-filter-normalization.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { hasCredentialSource, redactCredential, resolveCredential, requireProviderCredential } from "./credential-source.ts";

const BOCHA_SEARCH_URL = "https://api.bochaai.com/v1/web-search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

interface WebSearchConfig {
	bochaApiKey?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Bocha",
		configuredValue: loadConfig().bochaApiKey,
		environmentValue: process.env.BOCHA_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	return requireProviderCredential(await getApiKey(signal), {
		provider: "Bocha", configPath: CONFIG_PATH,
		configKey: "bochaApiKey", envVar: "BOCHA_API_KEY",
		keyInstructions: "Create a key at https://open.bochaai.com/",
	});
}

function mapFreshness(value: SearchOptions["recencyFilter"]): string {
	switch (value) {
		case "day": return "oneDay";
		case "week": return "oneWeek";
		case "month": return "oneMonth";
		case "year": return "oneYear";
		default: return "noLimit";
	}
}

function invalidResponse(message: string): Error {
	return new Error(`Bocha API returned invalid response: ${message}`);
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function parseSearchResponse(value: unknown): { results: SearchResponse["results"] } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (envelope.code !== undefined && Number(envelope.code) !== 200) {
		throw invalidResponse(`code ${String(envelope.code)}: ${firstString(envelope.msg) ?? "unknown error"}`);
	}
	const data = envelope.data;
	const pages = (typeof data === "object" && data !== null && !Array.isArray(data))
		? (data as Record<string, unknown>).webPages
		: undefined;
	const items = (typeof pages === "object" && pages !== null && !Array.isArray(pages))
		? (pages as Record<string, unknown>).value
		: undefined;
	if (!Array.isArray(items)) throw invalidResponse("missing data.webPages.value array");
	const results: SearchResponse["results"] = [];
	for (const item of items) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const entry = item as Record<string, unknown>;
		const url = firstString(entry.url, entry.link, entry.href);
		if (!url) continue;
		const title = firstString(entry.title, entry.name) ?? url;
		const snippet = firstString(entry.summary, entry.snippet, entry.description, entry.content) ?? "";
		results.push({ title, url, snippet });
	}
	return { results };
}

export function isBochaAvailable(): boolean {
	return hasCredentialSource({ provider: "Bocha", configuredValue: loadConfig().bochaApiKey, environmentValue: process.env.BOCHA_API_KEY });
}

export async function searchWithBocha(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetch(BOCHA_SEARCH_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ query, count: numResults, freshness: mapFreshness(options.recencyFilter), summary: true }),
			signal: options.signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
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
		throw new SearchHttpError(response.status, `Bocha API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: unknown;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
		throw new Error("Bocha API returned invalid JSON");
	}
	let parsed: { results: SearchResponse["results"] };
	try {
		parsed = parseSearchResponse(rawData);
	} catch (err) {
		const failure = redactSearchFailure(err, apiKey);
		activityMonitor.logError(activityId, failure.message);
		throw failure.error;
	}
	activityMonitor.logComplete(activityId, response.status);
	const results = parsed.results.filter((result) => matchesDomainFilter(result.url, filters)).slice(0, numResults);
	return { answer: formatSearchResultsAsAnswer(results), results };
}
