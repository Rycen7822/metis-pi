import { SearchHttpError } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter, type DomainFilters } from "./domain-filter-normalization.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { loadWebAccessConfig, fetchWithCredentialRedirects, getWebSearchConfigPath, resolveApiBaseUrl } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import { BraveRateLimitCoordinator } from "./brave-rate-limit.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import type { SearchOptions, SearchResult, SearchResponse } from "./search-types.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";

const BRAVE_API_BASE_URL = "https://api.search.brave.com/res/v1";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const braveRateLimit = new BraveRateLimitCoordinator();

interface WebSearchConfig {
	braveApiKey?: unknown;
	braveBaseUrl?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Brave",
		configuredValue: loadConfig().braveApiKey,
		environmentValue: process.env.BRAVE_API_KEY,
		signal,
	});
}

function getApiUrl(): string {
	return `${resolveApiBaseUrl({
		configKey: "braveBaseUrl",
		configuredValue: loadConfig().braveBaseUrl,
		defaultValue: BRAVE_API_BASE_URL,
		environmentKey: "BRAVE_BASE_URL",
		environmentValue: process.env.BRAVE_BASE_URL,
	})}/web/search`;
}

function buildBraveQuery(query: string, filters: DomainFilters): string {
	const parts = [query];

	if (filters.include.length === 1) {
		parts.push(`site:${filters.include[0]}`);
	} else if (filters.include.length > 1) {
		parts.push(filters.include.map(domain => `site:${domain}`).join(" OR "));
	}

	for (const domain of filters.exclude) {
		parts.push(`NOT site:${domain}`);
	}

	return parts.join(" ");
}

export function isBraveAvailable(): boolean {
	return hasCredentialSource({
		provider: "Brave",
		configuredValue: loadConfig().braveApiKey,
		environmentValue: process.env.BRAVE_API_KEY,
	});
}

export async function searchWithBrave(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const apiUrl = getApiUrl();
	const apiKey = await getApiKey(options.signal);
	if (!apiKey) {
		throw new Error(
			"Brave Search API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "braveApiKey": "your-key" }\n` +
			"  2. Set BRAVE_API_KEY environment variable\n" +
			"Get a key at https://brave.com/search/api/",
		);
	}

	const numResults = normalizeSearchResultCount(options.numResults);
	const domainFilters = normalizeDomainFilters(options.domainFilter);
	const searchQuery = buildBraveQuery(query, domainFilters);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });
	const params = new URLSearchParams({
		q: searchQuery,
		count: String(options.domainFilter?.length ? 20 : numResults),
	});

	if (options.recencyFilter) {
		const freshnessMap: Record<string, string> = {
			day: "pd",
			week: "pw",
			month: "pm",
			year: "py",
		};
		const freshness = freshnessMap[options.recencyFilter];
		if (freshness) params.set("freshness", freshness);
	}

	try {
		const searchDeadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
		const searchSignal = options.signal
			? AbortSignal.any([searchDeadline, options.signal])
			: searchDeadline;
		const response = await braveRateLimit.run(async () => {
			for (let attempt = 0; attempt < 2; attempt++) {
				const current = await fetchWithCredentialRedirects(`${apiUrl}?${params.toString()}`, {
					method: "GET",
					headers: {
						"X-Subscription-Token": apiKey,
						"Accept": "application/json",
						"Accept-Encoding": "gzip",
					},
					signal: searchSignal,
				}, ["X-Subscription-Token"]);

				braveRateLimit.observe(current.headers);
				if (current.status !== 429 || attempt === 1) return current;
				const retryDelay = braveRateLimit.retryDelay(current.headers);
				if (retryDelay === null) return current;
				braveRateLimit.recordRetryDelay(retryDelay);
				await current.body?.cancel().catch(() => undefined);
				await braveRateLimit.waitForRecordedCooldown(searchSignal);
			}
			throw new Error("Brave Search retry loop exited unexpectedly");
		}, searchSignal);

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = redactCredential(await response.text(), apiKey);
			throw new SearchHttpError(response.status, `Brave Search API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
			throw new Error("Brave Search API returned invalid JSON");
		}
		const data = rawData as {
			web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
		};
		activityMonitor.logComplete(activityId, response.status);

		const results: SearchResult[] = [];
		for (const item of data.web?.results ?? []) {
			if (!item.url || !matchesDomainFilter(item.url, domainFilters)) continue;
			results.push({
				title: item.title || item.url,
				url: item.url,
				snippet: item.description || "",
			});
			if (results.length >= numResults) break;
		}

		const answer = formatSearchResultsAsAnswer(results);

		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		const redactedError = err instanceof SearchHttpError
			? new SearchHttpError(err.status, redactedMessage)
			: new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}
