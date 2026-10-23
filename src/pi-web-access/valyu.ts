import { redactSearchFailure } from "./search-error-redaction.ts";
import { SearchHttpError } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter } from "./domain-filter-normalization.ts";
import { loadWebAccessConfig, getWebSearchConfigPath, fetchWithCredentialRedirects } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./content.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { formatSearchResultsAsAnswer, normalizeSearchText } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential, requireProviderCredential } from "./credential-source.ts";

const VALYU_SEARCH_URL = "https://api.valyu.ai/v1/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_SNIPPET_CHARS = 2_500;
const MAX_CONTENT_CHARS = 4_000;

interface WebSearchConfig {
	valyuApiKey?: unknown;
}

interface ValyuResult {
	title?: unknown;
	url?: unknown;
	description?: unknown;
	content?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Valyu",
		configuredValue: loadConfig().valyuApiKey,
		environmentValue: process.env.VALYU_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	return requireProviderCredential(await getApiKey(signal), {
		provider: "Valyu", configPath: CONFIG_PATH,
		configKey: "valyuApiKey", envVar: "VALYU_API_KEY",
		keyInstructions: "Get a key at https://platform.valyu.ai",
	});
}

function mapDomainFilter(domains: ReturnType<typeof normalizeDomainFilters>): { included_sources?: string[]; excluded_sources?: string[] } {
	const { include: included_sources, exclude: excluded_sources } = domains;
	return {
		...(included_sources.length > 0 ? { included_sources } : {}),
		...(excluded_sources.length > 0 ? { excluded_sources } : {}),
	};
}

function recencyToStartDate(filter: SearchOptions["recencyFilter"]): string | undefined {
	if (!filter) return undefined;
	const days = { day: 1, week: 7, month: 30, year: 365 }[filter];
	return days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : undefined;
}

function invalidResponse(message: string): Error {
	return new Error(`Valyu API returned invalid response: ${message}`);
}

function parseResponse(value: unknown): ValyuResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (envelope.success !== true) throw invalidResponse("expected success true");
	if (!Array.isArray(envelope.results)) throw invalidResponse("expected results array");
	return envelope.results as ValyuResult[];
}

export function isValyuAvailable(): boolean {
	return hasCredentialSource({ provider: "Valyu", configuredValue: loadConfig().valyuApiKey, environmentValue: process.env.VALYU_API_KEY });
}

export async function searchWithValyu(query: string, options: SearchOptions & { includeContent?: boolean } = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const domains = normalizeDomainFilters(options.domainFilter);
	const startDate = recencyToStartDate(options.recencyFilter);
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetchWithCredentialRedirects(VALYU_SEARCH_URL, {
			method: "POST",
			headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ query, max_num_results: numResults, ...mapDomainFilter(domains), ...(startDate ? { start_date: startDate } : {}) }),
			signal: options.signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		}, ["x-api-key"]);
	} catch (err) {
		const failure = redactSearchFailure(err, apiKey);
		if (failure.message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, failure.message);
		throw failure.error;
	}
	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new SearchHttpError(response.status, `Valyu API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: unknown;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
		throw new Error("Valyu API returned invalid JSON");
	}
	let entries: ValyuResult[];
	try {
		entries = parseResponse(rawData);
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw err;
	}
	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResponse["results"] = [];
	const inlineContent: ExtractedContent[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const url = normalizeSearchText(entry.url);
		if (!url || !matchesDomainFilter(url, domains)) continue;
		const title = normalizeSearchText(entry.title) || `Source ${results.length + 1}`;
		const content = normalizeSearchText(entry.content).slice(0, MAX_CONTENT_CHARS);
		const description = normalizeSearchText(entry.description).slice(0, MAX_SNIPPET_CHARS);
		results.push({ title, url, snippet: (content || description).slice(0, MAX_SNIPPET_CHARS) });
		if (options.includeContent && content) inlineContent.push({ url, title, content, error: null });
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results, ...(inlineContent.length > 0 ? { inlineContent } : {}) };
}
