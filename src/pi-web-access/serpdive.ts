import { redactSearchFailure } from "./search-error-redaction.ts";
import { SearchHttpError } from "./search-types.ts";
import { webFetch as fetch } from "./proxy-transport.ts";
import { normalizeDomainFilters, matchesDomainFilter, type DomainFilters } from "./domain-filter-normalization.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./content.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";

const SERPDIVE_API_URL = "https://api.serpdive.com/v1/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

// Retrieval depth. The default is deliberately the free tier: this provider
// ships inside someone else's framework, and installing it must never start
// spending on a user's behalf without them choosing it.
//   krill — free, fair use, no synthesized answer (see buildAnswer below)
//   mako  — the fact-carrying sentences of each page, 1 credit
//   moby  — the full readable content of every page, 1.5 credits
// Pricing: https://serpdive.com/pricing
const MODELS = ["krill", "mako", "moby"] as const;
type SerpdiveModel = (typeof MODELS)[number];
const DEFAULT_MODEL: SerpdiveModel = "krill";

interface WebSearchConfig {
	serpdiveApiKey?: unknown;
	serpdiveModel?: unknown;
}

interface SerpdiveResult {
	url?: string;
	title?: string | null;
	date?: string;
	content?: string;
}

interface SerpdiveResponse {
	query?: string;
	model?: string;
	answer?: string | null;
	results?: SerpdiveResult[];
}

interface SerpdiveSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "SERPdive",
		configuredValue: loadConfig().serpdiveApiKey,
		environmentValue: process.env.SERPDIVE_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"SERPdive API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "serpdiveApiKey": "your-key" }\n` +
			"  2. Set SERPDIVE_API_KEY environment variable\n" +
			"Get a key at https://serpdive.com/dashboard/keys",
		);
	}
	return apiKey;
}

// An unknown value falls back to the free default rather than failing: a typo
// in a config file must not cost the user money, and must not break search.
function resolveModel(): SerpdiveModel {
	const raw = process.env.SERPDIVE_MODEL ?? loadConfig().serpdiveModel;
	if (typeof raw !== "string") return DEFAULT_MODEL;
	const value = raw.trim().toLowerCase();
	return (MODELS as readonly string[]).includes(value) ? value as SerpdiveModel : DEFAULT_MODEL;
}

// SERPdive has NO time-range parameter. Recency is expressed inside the question
// and read by the engine, which biases ranking toward recent pages — it is a
// hint, never a guaranteed freshness filter, and results outside the window can
// still come back.
function applyRecencyHint(query: string, recencyFilter: SearchOptions["recencyFilter"]): string {
	if (!recencyFilter) return query;
	const hints: Record<string, string> = {
		day: "past 24 hours",
		week: "past week",
		month: "past month",
		year: "past year",
	};
	const hint = hints[recencyFilter];
	return hint ? `${query} ${hint}` : query;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// SERPdive has no domain parameter; local filtering can only narrow the results.
function mapResults(
	results: SerpdiveResult[] | undefined,
	numResults: number,
	filters: DomainFilters,
): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (const item of results) {
		if (!item?.url || !matchesDomainFilter(item.url, filters)) continue;
		mapped.push({
			title: item.title || `Source ${mapped.length + 1}`,
			url: item.url,
			snippet: typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim() : "",
		});
		if (mapped.length >= numResults) break;
	}
	return mapped;
}

function mapInlineContent(results: SerpdiveResult[] | undefined, filters: DomainFilters): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		if (!item?.url || !matchesDomainFilter(item.url, filters)) return [];
		if (typeof item.content !== "string" || item.content.trim().length === 0) return [];
		return [{
			url: item.url,
			title: item.title || "",
			content: item.content,
			error: null,
		}];
	});
}

// The free krill tier returns extracted content but no synthesized answer, so
// one is assembled from the sources — the same shape brave.ts and searxng.ts
// produce for providers that do not synthesize. mako and moby ask the API for a
// real answer and use it when it comes back.
function buildAnswer(apiAnswer: string | null | undefined, results: SearchResponse["results"]): string {
	if (typeof apiAnswer === "string" && apiAnswer.trim().length > 0) return apiAnswer;
	return formatSearchResultsAsAnswer(results);
}

export function isSerpdiveAvailable(): boolean {
	return hasCredentialSource({
		provider: "SERPdive",
		configuredValue: loadConfig().serpdiveApiKey,
		environmentValue: process.env.SERPDIVE_API_KEY,
	});
}

export async function searchWithSerpdive(query: string, options: SerpdiveSearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults, { max: 10 });
	const filters = normalizeDomainFilters(options.domainFilter);
	const model = resolveModel();
	const body: Record<string, unknown> = {
		query: applyRecencyHint(query, options.recencyFilter),
		model,
		// max_results is a CAP, never a minimum: the engine returns what it
		// judges relevant, up to this many. Asking for more does not produce more.
		max_results: numResults,
		// krill has no answer synthesis — asking for one there is silently ignored
		// by the API, so it is not asked for at all.
		...(model === "krill" ? {} : { answer: true }),
	};

	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetch(SERPDIVE_API_URL, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(options.signal),
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
		throw new SearchHttpError(response.status, `SERPdive API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let data: SerpdiveResponse;
	try {
		data = await response.json() as SerpdiveResponse;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
		throw new Error("SERPdive API returned invalid JSON");
	}

	activityMonitor.logComplete(activityId, response.status);
	const results = mapResults(data.results, numResults, filters);
	const result: SearchResponse = {
		answer: buildAnswer(data.answer, results),
		results,
	};
	if (options.includeContent) {
		const inlineContent = mapInlineContent(data.results, filters);
		if (inlineContent.length > 0) result.inlineContent = inlineContent;
	}
	return result;
}
