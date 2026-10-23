import { errorMessage } from "./search-error-redaction.ts";
import { loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { webFetch as fetch } from "./proxy-transport.ts";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent, ExtractOptions } from "./content.ts";
import { SearchHttpError, SearchUnsupportedFilterError, type SearchOptions, type SearchResponse } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter } from "./domain-filter-normalization.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchRemoteUrl, loadFetchContentDomainPolicy, loadSsrfConfig, validateRemoteUrl, type SsrfConfig } from "./ssrf-protection.ts";

const OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";
const OLLAMA_FETCH_URL = "https://ollama.com/api/web_fetch";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

interface WebSearchConfig {
	ollamaApiKey?: unknown;
}

interface OllamaSearchResult {
	title: string;
	url: string;
	content: string;
}

interface OllamaSearchResponse {
	results: OllamaSearchResult[];
}

interface OllamaFetchResponse {
	title: string;
	content: string;
}

interface OllamaSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

export interface OllamaExtractOptions extends Pick<ExtractOptions, "timeoutMs" | "lookup" | "fetch"> {
	ssrf?: SsrfConfig;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Ollama",
		configuredValue: loadConfig().ollamaApiKey,
		environmentValue: process.env.OLLAMA_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"Ollama API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "ollamaApiKey": "your-key" }\n` +
			"  2. Set OLLAMA_API_KEY environment variable\n" +
			"Create a key at https://ollama.com/settings/keys",
		);
	}
	return apiKey;
}

function invalidResponse(message: string): Error {
	return new Error(`Ollama API returned invalid response: ${message}`);
}

function parseSearchResponse(value: unknown): OllamaSearchResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (!Array.isArray(envelope.results)) throw invalidResponse("expected results array");
	const results: OllamaSearchResult[] = [];
	for (const [index, value] of envelope.results.entries()) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(`expected results[${index}] object`);
		const item = value as Record<string, unknown>;
		if (typeof item.title !== "string") throw invalidResponse(`expected results[${index}].title string`);
		if (typeof item.url !== "string" || !item.url) throw invalidResponse(`expected results[${index}].url non-empty string`);
		if (typeof item.content !== "string") throw invalidResponse(`expected results[${index}].content string`);
		results.push({ title: item.title, url: item.url, content: item.content });
	}
	return { results };
}

function parseFetchResponse(value: unknown): OllamaFetchResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected fetch object envelope");
	const envelope = value as Record<string, unknown>;
	if (typeof envelope.title !== "string") throw invalidResponse("expected title string");
	if (typeof envelope.content !== "string") throw invalidResponse("expected content string");
	return { title: envelope.title, content: envelope.content };
}

export function isOllamaAvailable(): boolean {
	return hasCredentialSource({ provider: "Ollama", configuredValue: loadConfig().ollamaApiKey, environmentValue: process.env.OLLAMA_API_KEY });
}

export async function searchWithOllama(query: string, options: OllamaSearchOptions = {}): Promise<SearchResponse> {
	if (options.recencyFilter) throw new SearchUnsupportedFilterError("Ollama web search does not support recencyFilter");
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults, { max: 10 });
	const filters = normalizeDomainFilters(options.domainFilter);
	const hasDomains = filters.include.length > 0 || filters.exclude.length > 0;
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetch(OLLAMA_SEARCH_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ query, max_results: hasDomains ? 10 : numResults }),
			signal: options.signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new SearchHttpError(response.status, `Ollama API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let rawData: unknown;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Ollama API returned invalid JSON: ${errorMessage(err)}`);
	}

	let data: OllamaSearchResponse;
	try {
		data = parseSearchResponse(rawData);
	} catch (err) {
		activityMonitor.logError(activityId, errorMessage(err));
		throw err;
	}
	activityMonitor.logComplete(activityId, response.status);
	const retained = data.results.filter(result => matchesDomainFilter(result.url, filters)).slice(0, numResults);
	const results = retained.map((result) => ({ title: result.title, url: result.url, snippet: result.content }));
	const mapped: SearchResponse = { answer: formatSearchResultsAsAnswer(results), results };
	if (options.includeContent) {
		const inlineContent: ExtractedContent[] = retained
			.filter(result => result.content.trim().length > 0)
			.map(result => ({ url: result.url, title: result.title, content: result.content, error: null }));
		if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
	}
	return mapped;
}

export function isOllamaFetchAvailable(): boolean {
	return isOllamaAvailable();
}

export async function extractWithOllama(url: string, signal?: AbortSignal, options: OllamaExtractOptions = {}): Promise<ExtractedContent | null> {
	const ssrf = options.ssrf ?? loadSsrfConfig();
	const domainPolicy = loadFetchContentDomainPolicy();
	await validateRemoteUrl(url, {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		domainPolicy,
		...(options.lookup ? { lookup: options.lookup } : {}),
	});
	const apiKey = await requireApiKey(signal);
	const activityId = activityMonitor.logStart({ type: "api", query: `ollama fetch: ${url}` });
	let response: Response;
	try {
		response = await fetchRemoteUrl(OLLAMA_FETCH_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ url }),
			signal: signal ? AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS),
		}, {
			fetch: options.fetch,
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			onRedirect: ({ from, to, init }) => to.origin === from.origin ? init : { ...init, headers: { "Content-Type": "application/json" } },
			...(options.lookup ? { lookup: options.lookup } : {}),
		});
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Ollama Web Fetch error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: unknown;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Ollama Web Fetch returned invalid JSON: ${errorMessage(err)}`);
	}
	let data: OllamaFetchResponse;
	try {
		data = parseFetchResponse(rawData);
	} catch (err) {
		activityMonitor.logError(activityId, errorMessage(err));
		throw err;
	}
	activityMonitor.logComplete(activityId, response.status);
	const content = data.content.trim();
	if (!content) return null;
	return { url, title: data.title, content, error: null };
}
