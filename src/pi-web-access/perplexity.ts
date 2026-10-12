import { loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import { SearchHttpError, type SearchResult, type SearchResponse, type SearchOptions } from "./search-types.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { normalizeDomainFilters } from "./domain-filter-normalization.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";

const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const CONFIG_PATH = getWebSearchConfigPath();

const RATE_LIMIT = {
	maxRequests: 10,
	windowMs: 60 * 1000,
};

const requestTimestamps: number[] = [];

interface WebSearchConfig {
	perplexityApiKey?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	const key = await resolveCredential({
		provider: "Perplexity",
		configuredValue: loadConfig().perplexityApiKey,
		environmentValue: process.env.PERPLEXITY_API_KEY,
		signal,
	});
	if (!key) {
		throw new Error(
			"Perplexity API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "perplexityApiKey": "your-key" }\n` +
			"  2. Set PERPLEXITY_API_KEY environment variable\n" +
			"Get a key at https://perplexity.ai/settings/api"
		);
	}
	return key;
}

function checkRateLimit(): void {
	const now = Date.now();
	const windowStart = now - RATE_LIMIT.windowMs;

	while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
		requestTimestamps.shift();
	}

	if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
		const waitMs = requestTimestamps[0] + RATE_LIMIT.windowMs - now;
		throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s`);
	}

	requestTimestamps.push(now);
}

export function isPerplexityAvailable(): boolean {
	return hasCredentialSource({
		provider: "Perplexity",
		configuredValue: loadConfig().perplexityApiKey,
		environmentValue: process.env.PERPLEXITY_API_KEY,
	});
}

interface PerplexityRequestOptions {
	activityQuery: string;
	signal?: AbortSignal;
}

async function postPerplexity(
	url: string,
	body: Record<string, unknown>,
	options: PerplexityRequestOptions,
): Promise<Record<string, unknown>> {
	checkRateLimit();

	const apiKey = await getApiKey(options.signal);
	const activityId = activityMonitor.logStart({ type: "api", query: options.activityQuery });

	activityMonitor.updateRateLimit({
		used: requestTimestamps.length,
		max: RATE_LIMIT.maxRequests,
		oldestTimestamp: requestTimestamps[0] ?? null,
		windowMs: RATE_LIMIT.windowMs,
	});

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}

	activityMonitor.logComplete(activityId, response.status);

	if (!response.ok) {
		const errorText = redactCredential(await response.text(), apiKey);
		throw new SearchHttpError(response.status, `Perplexity API error ${response.status}: ${errorText}`);
	}

	try {
		return await response.json();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Perplexity API returned invalid JSON: ${message}`);
	}
}

export async function searchWithPerplexity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const numResults = normalizeSearchResultCount(options.numResults);

	const requestBody: Record<string, unknown> = {
		query,
		max_results: numResults,
		search_type: "fast",
		search_context_size: "medium",
	};

	if (options.recencyFilter) {
		requestBody.search_recency_filter = options.recencyFilter;
	}

	if (options.domainFilter && options.domainFilter.length > 0) {
		const filters = normalizeDomainFilters(options.domainFilter);
		const validated = [...filters.include, ...filters.exclude.map(domain => `-${domain}`)];
		if (validated.length > 0) {
			requestBody.search_domain_filter = validated;
		}
	}

	const data = await postPerplexity(PERPLEXITY_SEARCH_URL, requestBody, { activityQuery: query, signal: options.signal });

	const results: SearchResult[] = [];
	for (const entry of Array.isArray(data.results) ? data.results : []) {
		if (!entry || typeof entry !== "object" || typeof entry.url !== "string" || !entry.url) continue;
		results.push({
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Source ${results.length + 1}`,
			url: entry.url,
			snippet: typeof entry.snippet === "string" ? entry.snippet.trim() : "",
		});
		if (results.length >= numResults) break;
	}

	return { answer: formatSearchResultsAsAnswer(results), results };
}

/** Asks Sonar for a prose answer. The Search API returns only ranked pages, so prompts that need prose use this. */
export async function askPerplexity(prompt: string, options: { signal?: AbortSignal } = {}): Promise<string> {
	const data = await postPerplexity(PERPLEXITY_CHAT_URL, {
		model: "sonar",
		messages: [{ role: "user", content: prompt }],
		max_tokens: 1024,
		return_related_questions: false,
	}, { activityQuery: prompt, signal: options.signal });

	const content = (data.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content;
	return typeof content === "string" ? content : "";
}
