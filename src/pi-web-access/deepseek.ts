import { activityMonitor } from "./activity.ts";
import { loadWebAccessConfig, webCredentialsPath } from "./config.ts";
import { hasCredentialSource, requireProviderCredential, resolveCredential } from "./credential-source.ts";
import { matchesDomainFilter, normalizeDomainFilters, type DomainFilters } from "./domain-filter-normalization.ts";
import { webFetch } from "./proxy-transport.ts";
import { formatSearchResultAsAnswer, normalizeSearchText } from "./search-answer-formatting.ts";
import { redactSearchFailure } from "./search-error-redaction.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { SearchHttpError, type SearchOptions, type SearchResponse } from "./search-types.ts";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const TIMEOUT_SECONDS = 60;
const RECENCY_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const;
type DeepSeekSearchOptions = SearchOptions & { includeContent?: boolean };

function credentialOptions() {
	const { deepseekApiKey } = loadWebAccessConfig();
	return { provider: "DeepSeek", configuredValue: deepseekApiKey, environmentValue: process.env.DEEPSEEK_API_KEY };
}

export function isDeepSeekAvailable(): boolean {
	return hasCredentialSource(credentialOptions());
}

function buildQuery(query: string, filters: DomainFilters, recency: SearchOptions["recencyFilter"]): string {
	const terms = query.trim();
	if (!terms) throw new Error("DeepSeek invalid request: query must not be blank");
	const parts = [terms];
	if (filters.include.length) parts.push(filters.include.map(domain => `site:${domain}`).join(" OR "));
	for (const domain of filters.exclude) parts.push(`-site:${domain}`);
	if (recency) {
		const cutoff = new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);
		parts.push(`after:${cutoff}`);
	}
	const filteredQuery = parts.join(" ");
	if ([...filteredQuery].length > 128) throw new Error("DeepSeek invalid request: query including filters exceeds 128 Unicode characters");
	return filteredQuery;
}

function mapResponse(data: unknown, filters: DomainFilters, count: number, includeContent: boolean): SearchResponse {
	const entries = (data as { results?: unknown } | null)?.results;
	if (!Array.isArray(entries)) throw new Error("DeepSeek returned invalid response: expected results array");
	const results: SearchResponse["results"] = [];
	const answer: string[] = [];
	const inlineContent: NonNullable<SearchResponse["inlineContent"]> = [];
	const seen = new Set<string>();
	for (const entry of entries as unknown[]) {
		if (!entry || typeof entry !== "object" || !("url" in entry) || typeof entry.url !== "string") continue;
		const row = entry as Record<string, unknown>;
		const url = URL.parse(entry.url);
		if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) continue;
		if (seen.has(url.href) || !matchesDomainFilter(url, filters)) continue;
		seen.add(url.href);
		const title = normalizeSearchText(row.title) || url.href;
		const summary = normalizeSearchText(row.summary);
		const result = { url: url.href, title, snippet: normalizeSearchText(row.snippet) || summary };
		results.push(result);
		answer.push(formatSearchResultAsAnswer(result, summary || result.snippet));
		if (includeContent && typeof row.content === "string" && row.content.trim()) {
			inlineContent.push({ url: url.href, title, content: row.content, error: null });
		}
		if (results.length === count) break;
	}
	return { answer: answer.join("\n\n"), results, ...(inlineContent.length ? { inlineContent } : {}) };
}

export async function searchWithDeepSeek(query: string, options: DeepSeekSearchOptions = {}): Promise<SearchResponse> {
	if (options.signal?.aborted) throw new Error("Aborted");
	const filters = normalizeDomainFilters(options.domainFilter);
	const wireQuery = buildQuery(query, filters, options.recencyFilter);
	const count = normalizeSearchResultCount(options.numResults);
	const includeContent = options.includeContent === true;
	const apiKey = requireProviderCredential(await resolveCredential({ ...credentialOptions(), signal: options.signal }), {
		provider: "DeepSeek", configPath: webCredentialsPath(), configKey: "deepseekApiKey", envVar: "DEEPSEEK_API_KEY",
		keyInstructions: "Get a key at https://platform.deepseek.com/api_keys",
	});
	const timeout = AbortSignal.timeout(TIMEOUT_SECONDS * 1000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const activity = activityMonitor.logStart({ type: "api", query });
	try {
		const response = await webFetch(SEARCH_URL, {
			method: "POST", redirect: "error", signal,
			headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ query: wireQuery, count, need_content: includeContent }),
		}, options.fetch);
		if (!response.ok) {
			// Provider diagnostics can echo request data. Route on the status, not the response body.
			await response.body?.cancel().catch(() => {});
			throw new SearchHttpError(response.status, `DeepSeek Search API error ${response.status}`);
		}
		const result = mapResponse(await response.json(), filters, count, includeContent);
		signal.throwIfAborted();
		activityMonitor.logComplete(activity, response.status);
		return result;
	} catch (error) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activity, 0);
			throw new Error("Aborted");
		}
		const cause = timeout.aborted ? new Error(`DeepSeek search timed out after ${TIMEOUT_SECONDS}s`)
			: error instanceof SyntaxError ? new Error("DeepSeek returned invalid JSON") : error;
		const failure = redactSearchFailure(cause, apiKey);
		activityMonitor.logError(activity, failure.message);
		throw failure.error;
	}
}
