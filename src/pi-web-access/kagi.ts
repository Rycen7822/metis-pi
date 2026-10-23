import { errorMessage } from "./search-error-redaction.ts";
import { SearchHttpError } from "./search-types.ts";
import { webFetch as fetch } from "./proxy-transport.ts";
import { loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent, ExtractOptions } from "./content.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { normalizeDomainFilters, matchesDomainFilter } from "./domain-filter-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential, requireProviderCredential } from "./credential-source.ts";
import { fetchRemoteUrl, loadFetchContentDomainPolicy, loadSsrfConfig, validateRemoteUrl, type SsrfConfig } from "./ssrf-protection.ts";

const KAGI_SEARCH_URL = "https://kagi.com/api/v1/search";
const KAGI_EXTRACT_URL = "https://kagi.com/api/v1/extract";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

interface WebSearchConfig {
	kagiApiKey?: unknown;
}

interface KagiSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

export interface KagiExtractOptions extends Pick<ExtractOptions, "timeoutMs" | "lookup" | "fetch"> {
	ssrf?: SsrfConfig;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Kagi",
		configuredValue: loadConfig().kagiApiKey,
		environmentValue: process.env.KAGI_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	return requireProviderCredential(await getApiKey(signal), {
		provider: "Kagi", configPath: CONFIG_PATH,
		configKey: "kagiApiKey", envVar: "KAGI_API_KEY",
		keyInstructions: "Create a key at https://kagi.com/settings?p=api",
	});
}

function invalidResponse(message: string): Error {
	return new Error(`Kagi API returned invalid response: ${message}`);
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function appendSearchItems(value: unknown, results: SearchResponse["results"], inlineContent?: ExtractedContent[]): void {
	if (Array.isArray(value)) {
		for (const item of value) appendSearchItems(item, results, inlineContent);
		return;
	}
	if (!value || typeof value !== "object") return;
	const item = value as Record<string, unknown>;
	const url = firstString(item.url, item.href, item.link);
	if (!url) return;
	const title = firstString(item.title, item.name) ?? url;
	const snippet = firstString(item.snippet, item.description, item.summary, item.content, item.markdown, item.text) ?? "";
	results.push({ title, url, snippet });
	if (inlineContent) {
		const content = firstString(item.markdown, item.content, item.text);
		if (content) inlineContent.push({ url, title, content, error: null });
	}
}

function parseErrors(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const envelope = value as Record<string, unknown>;
	const rawErrors = envelope.errors ?? envelope.error;
	if (!Array.isArray(rawErrors)) return null;
	const messages = rawErrors.map((entry) => {
		if (!entry || typeof entry !== "object") return String(entry);
		const raw = entry as Record<string, unknown>;
		return firstString(raw.message, raw.msg, raw.code) ?? JSON.stringify(raw);
	});
	return messages.length > 0 ? messages.join("; ") : null;
}

function parseSearchResponse(
	value: unknown,
	includeContent?: boolean,
): { results: SearchResponse["results"]; inlineContent: ExtractedContent[] } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const message = parseErrors(value);
	if (message) throw invalidResponse(message);
	const envelope = value as Record<string, unknown>;
	const results: SearchResponse["results"] = [];
	const inlineContent: ExtractedContent[] = [];
	const data = envelope.data;
	const items = (typeof data === "object" && data !== null && !Array.isArray(data))
		? (data as Record<string, unknown>).search
		: data;
	appendSearchItems(items, results, includeContent ? inlineContent : undefined);
	return { results, inlineContent };
}

function parseExtractResponse(value: unknown, requestedUrl: string): ExtractedContent | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected extract object envelope");
	const message = parseErrors(value);
	if (message) throw invalidResponse(message);
	const envelope = value as Record<string, unknown>;
	const candidates = Array.isArray(envelope.data) ? envelope.data : [envelope.data ?? envelope];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const item = candidate as Record<string, unknown>;
		const content = firstString(item.markdown, item.content, item.text);
		if (!content) continue;
		return {
			url: firstString(item.url, item.href, item.link) ?? requestedUrl,
			title: firstString(item.title, item.name) ?? requestedUrl,
			content,
			error: null,
		};
	}
	return null;
}

export function isKagiAvailable(): boolean {
	return hasCredentialSource({ provider: "Kagi", configuredValue: loadConfig().kagiApiKey, environmentValue: process.env.KAGI_API_KEY });
}

export async function searchWithKagi(query: string, options: KagiSearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const domains = normalizeDomainFilters(options.domainFilter);
	const hasDomains = domains.include.length > 0 || domains.exclude.length > 0;
	const days = options.recencyFilter ? { day: 1, week: 7, month: 30, year: 365 }[options.recencyFilter] : undefined;
	const after = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : undefined;
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	try {
		const response = await fetch(KAGI_SEARCH_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				query, limit: hasDomains ? 20 : numResults,
				...(after ? { filters: { after } } : {}),
				...(hasDomains ? { lens: {
					...(domains.include.length ? { sites_included: domains.include } : {}),
					...(domains.exclude.length ? { sites_excluded: domains.exclude } : {}),
				} } : {}),
			}),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		});
		if (!response.ok) {
			const errorText = redactCredential(await response.text(), apiKey);
			throw new SearchHttpError(response.status, `Kagi API error ${response.status}: ${errorText.slice(0, 300)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (options.signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) throw err;
			throw new Error("Kagi API returned invalid JSON");
		}
		const parsed = parseSearchResponse(rawData, options.includeContent);
		const results = parsed.results.filter(result => matchesDomainFilter(result.url, domains)).slice(0, numResults);
		const mapped: SearchResponse = { answer: formatSearchResultsAsAnswer(results), results };
		if (options.includeContent) {
			const urls = new Set(results.map(result => result.url));
			const inlineContent = parsed.inlineContent.filter(content => urls.has(content.url));
			if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
		}
		activityMonitor.logComplete(activityId, response.status);
		return mapped;
	} catch (err) {
		if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError" && !timeoutSignal.aborted)) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		const safeMessage = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError")
			? "Kagi request timed out after 60s" : redactCredential(message, apiKey);
		const outgoing = safeMessage === message && err instanceof Error ? err
			: err instanceof SearchHttpError ? new SearchHttpError(err.status, safeMessage)
			: err instanceof TypeError ? new TypeError(safeMessage) : new Error(safeMessage);
		if (outgoing instanceof SearchHttpError) activityMonitor.logComplete(activityId, outgoing.status);
		else activityMonitor.logError(activityId, safeMessage);
		throw outgoing;
	}
}

export function isKagiExtractAvailable(): boolean {
	return isKagiAvailable();
}

export async function extractWithKagi(url: string, signal?: AbortSignal, options: KagiExtractOptions = {}): Promise<ExtractedContent | null> {
	const ssrf = options.ssrf ?? loadSsrfConfig();
	const domainPolicy = loadFetchContentDomainPolicy();
	await validateRemoteUrl(url, {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		domainPolicy,
		...(options.lookup ? { lookup: options.lookup } : {}),
	});
	const apiKey = await requireApiKey(signal);
	const activityId = activityMonitor.logStart({ type: "api", query: `kagi extract: ${url}` });
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS);
	try {
		const response = await fetchRemoteUrl(KAGI_EXTRACT_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ pages: [{ url }] }),
			signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
		}, {
			fetch: options.fetch,
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			onRedirect: ({ from, to, init }) => to.origin === from.origin ? init : { ...init, headers: { "Content-Type": "application/json", Accept: "application/json" } },
			...(options.lookup ? { lookup: options.lookup } : {}),
		});
		if (!response.ok) {
			const errorText = redactCredential(await response.text(), apiKey);
			throw new SearchHttpError(response.status, `Kagi Extract API error ${response.status}: ${errorText.slice(0, 300)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) throw err;
			throw new Error("Kagi Extract API returned invalid JSON");
		}
		const parsed = parseExtractResponse(rawData, url);
		activityMonitor.logComplete(activityId, response.status);
		return parsed;
	} catch (err) {
		if (signal?.aborted || (err instanceof Error && err.name === "AbortError" && !timeoutSignal.aborted)) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		const safeMessage = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError")
			? "Kagi extract request timed out" : redactCredential(message, apiKey);
		const outgoing = safeMessage === message && err instanceof Error ? err
			: err instanceof SearchHttpError ? new SearchHttpError(err.status, safeMessage)
			: err instanceof TypeError ? new TypeError(safeMessage) : new Error(safeMessage);
		if (outgoing instanceof SearchHttpError) activityMonitor.logComplete(activityId, outgoing.status);
		else activityMonitor.logError(activityId, safeMessage);
		throw outgoing;
	}
}
