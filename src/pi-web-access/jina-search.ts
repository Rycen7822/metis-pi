import { loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import type { ExtractedContent } from "./content.ts";
import { SearchHttpError, type SearchOptions, type SearchResponse } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter, type DomainFilters } from "./domain-filter-normalization.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";

const JINA_SEARCH_BASE_URL = "https://s.jina.ai/";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

interface WebSearchConfig {
	jinaApiKey?: unknown;
}

interface JinaSearchItem {
	title?: unknown;
	url?: unknown;
	description?: unknown;
	content?: unknown;
}

interface JinaSearchEnvelope {
	code?: unknown;
	data?: unknown;
}

interface JinaSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Jina Search",
		configuredValue: loadConfig().jinaApiKey,
		environmentValue: process.env.JINA_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"Jina Search API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "jinaApiKey": "your-key" }\n` +
			"  2. Set JINA_API_KEY environment variable\n" +
			"Get a key at https://jina.ai/api-dashboard",
		);
	}
	return apiKey;
}

function buildSearchRequest(query: string, options: JinaSearchOptions, numResults: number): { url: string; filters: DomainFilters } {
	const filters = normalizeDomainFilters(options.domainFilter);
	const recency = options.recencyFilter ? ` published in the past ${options.recencyFilter}` : "";
	const exclusions = filters.exclude.map((domain) => ` -site:${domain}`).join("");
	const constrainedQuery = `${query.trim()}${exclusions}${recency}`.trim();
	const url = new URL(encodeURIComponent(constrainedQuery), JINA_SEARCH_BASE_URL);
	url.searchParams.set("count", String(numResults));
	for (const domain of filters.include) url.searchParams.append("site", domain);
	return { url: url.toString(), filters };
}

function requestSignal(signal?: AbortSignal): { signal: AbortSignal; timeout: AbortSignal } {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return {
		timeout,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function parseItems(value: unknown): JinaSearchItem[] {
	if (Array.isArray(value)) return value as JinaSearchItem[];
	if (!value || typeof value !== "object") {
		throw new Error("Jina Search API returned invalid response: expected an object or array");
	}
	const envelope = value as JinaSearchEnvelope;
	if (typeof envelope.code === "number" && envelope.code !== 200) {
		throw new Error(`Jina Search API error ${envelope.code}: response envelope reported failure`);
	}
	if (!Array.isArray(envelope.data)) {
		throw new Error("Jina Search API returned invalid response: expected data array");
	}
	return envelope.data as JinaSearchItem[];
}

function mapItems(items: JinaSearchItem[], numResults: number, filters: DomainFilters): {
	results: SearchResponse["results"];
	content: ExtractedContent[];
} {
	const results: SearchResponse["results"] = [];
	const content: ExtractedContent[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const url = typeof item?.url === "string" ? item.url.trim() : "";
		if (!url || seen.has(url) || !URL.canParse(url) || !matchesDomainFilter(url, filters)) continue;
		seen.add(url);
		const title = typeof item.title === "string" && item.title.trim()
			? item.title.trim()
			: `Source ${results.length + 1}`;
		const snippet = typeof item.description === "string"
			? item.description.replace(/\s+/g, " ").trim()
			: "";
		results.push({ title, url, snippet });
		if (typeof item.content === "string" && item.content.trim()) {
			content.push({ url, title, content: item.content.trim(), error: null });
		}
		if (results.length >= numResults) break;
	}
	return { results, content };
}

function rethrowRequestError(
	err: unknown,
	apiKey: string,
	activityId: string,
	request: ReturnType<typeof requestSignal>,
	callerSignal?: AbortSignal,
): never {
	if (request.timeout.aborted && !callerSignal?.aborted) {
		activityMonitor.logComplete(activityId, 408);
		throw new SearchHttpError(408, "Jina Search API error 408: request timed out");
	}
	const message = errorMessage(err);
	const redactedMessage = redactCredential(message, apiKey);
	if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
	else activityMonitor.logError(activityId, redactedMessage);
	if (redactedMessage === message) throw err;
	const redactedError = new Error(redactedMessage);
	if (err instanceof Error) redactedError.name = err.name;
	throw redactedError;
}

export function isJinaSearchAvailable(): boolean {
	return hasCredentialSource({
		provider: "Jina Search",
		configuredValue: loadConfig().jinaApiKey,
		environmentValue: process.env.JINA_API_KEY,
	});
}

export async function searchWithJina(query: string, options: JinaSearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const { url, filters } = buildSearchRequest(query, options, numResults);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const request = requestSignal(options.signal);
	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				"Accept": "application/json",
				"Authorization": `Bearer ${apiKey}`,
				"User-Agent": "pi-web-access",
				"X-Respond-With": options.includeContent ? "content" : "no-content",
				"X-Retain-Images": "none",
			},
			signal: request.signal,
		});
	} catch (err) {
		rethrowRequestError(err, apiKey, activityId, request, options.signal);
	}

	if (!response.ok) {
		let body: string;
		try {
			body = redactCredential(await response.text(), apiKey);
		} catch (err) {
			rethrowRequestError(err, apiKey, activityId, request, options.signal);
		}
		activityMonitor.logComplete(activityId, response.status);
		throw new SearchHttpError(response.status, `Jina Search API error ${response.status}: ${body.slice(0, 300)}`);
	}

	let raw: unknown;
	try {
		raw = await response.json();
	} catch (err) {
		if (!(err instanceof SyntaxError)) {
			rethrowRequestError(err, apiKey, activityId, request, options.signal);
		}
		activityMonitor.logComplete(activityId, response.status);
		throw new Error("Jina Search API returned invalid JSON");
	}

	let mapped: ReturnType<typeof mapItems>;
	try {
		mapped = mapItems(parseItems(raw), numResults, filters);
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
	activityMonitor.logComplete(activityId, response.status);
	const result: SearchResponse = {
		answer: formatSearchResultsAsAnswer(mapped.results),
		results: mapped.results,
	};
	if (options.includeContent && mapped.content.length > 0) result.inlineContent = mapped.content;
	return result;
}
