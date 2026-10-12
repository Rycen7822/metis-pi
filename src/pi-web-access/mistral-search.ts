import { getWebAccessConfigPath, loadWebAccessConfig, getWebSearchConfigPath } from "./utils.ts";
import { activityMonitor } from "./activity.ts";
import { normalizeDomainFilters, matchesDomainFilter } from "./domain-filter-normalization.ts";
import { SearchHttpError, type SearchOptions, type SearchResponse, type SearchResult } from "./search-types.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";

const MISTRAL_CONVERSATIONS_URL = "https://api.mistral.ai/v1/conversations";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const DEFAULT_SEARCH_MODEL = "mistral-small-latest";
const DEFAULT_SEARCH_TOOL = "web_search";

type MistralSearchTool = "web_search" | "web_search_premium";

interface WebSearchConfig {
	mistralApiKey?: unknown;
	mistralSearchModel?: unknown;
	mistralSearchTool?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	return cachedConfig ??= loadWebAccessConfig() as WebSearchConfig;
}

function resolveSearchModel(value: unknown): string {
	if (value === undefined) return DEFAULT_SEARCH_MODEL;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`mistralSearchModel in ${getWebAccessConfigPath()} must be a non-empty string`);
	}
	return value.trim();
}

function resolveSearchTool(value: unknown): MistralSearchTool {
	if (value === undefined) return DEFAULT_SEARCH_TOOL;
	if (value !== "web_search" && value !== "web_search_premium") {
		throw new Error(`mistralSearchTool in ${getWebAccessConfigPath()} must be either web_search or web_search_premium`);
	}
	return value;
}

function normalizeResultUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const url = value.trim();
	if (!url) return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	} catch {
		return null;
	}
	return url;
}

function buildSearchPrompt(query: string, options: SearchOptions, numResults: number): string {
	const lines: string[] = [];
	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		lines.push(`Prefer sources from the ${labels[options.recencyFilter] ?? options.recencyFilter}.`);
	}
	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
		lines.push(`Prefer up to ${numResults} distinct sources.`);
	}

	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters.include.length > 0) lines.push(`Only use sources from: ${filters.include.slice(0, 100).join(", ")}.`);
	if (filters.exclude.length > 0) lines.push(`Do not use sources from: ${filters.exclude.slice(0, 100).join(", ")}.`);
	return lines.length > 0 ? `${lines.join(" ")}\n\n${query}` : query;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`Mistral API returned invalid response: ${message}`);
}

function parseConversationResponse(value: unknown, options: SearchOptions, numResults: number): SearchResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw invalidResponse("expected an object envelope");
	}
	const outputs = (value as Record<string, unknown>).outputs;
	if (!Array.isArray(outputs)) throw invalidResponse("outputs must be an array");

	const answerParts: string[] = [];
	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();
	const domainFilters = normalizeDomainFilters(options.domainFilter);

	for (const output of outputs) {
		if (!output || typeof output !== "object" || Array.isArray(output)) continue;
		const entry = output as Record<string, unknown>;
		if (entry.type !== "message.output") continue;
		const content = entry.content;
		if (typeof content === "string") {
			if (content.trim()) answerParts.push(content.trim());
			continue;
		}
		if (!Array.isArray(content)) continue;

		for (const chunk of content) {
			if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) continue;
			const part = chunk as Record<string, unknown>;
			if (part.type === "text") {
				if (typeof part.text === "string" && part.text.trim()) answerParts.push(part.text.trim());
				continue;
			}
			if (part.type !== "tool_reference" || results.length >= numResults) continue;

			const url = normalizeResultUrl(part.url);
			if (!url || !matchesDomainFilter(url, domainFilters) || seenUrls.has(url)) continue;
			seenUrls.add(url);
			const title = typeof part.title === "string" && part.title.trim() ? part.title.trim() : url;
			const snippet = typeof part.description === "string" ? part.description : "";
			results.push({ title, url, snippet });
		}
	}

	const answer = answerParts.join("\n").trim();
	if (!answer && results.length === 0) throw invalidResponse("no answer or sources");
	return { answer, results };
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await resolveCredential({
		provider: "Mistral",
		configuredValue: loadConfig().mistralApiKey,
		environmentValue: process.env.MISTRAL_API_KEY,
		signal,
	});
	if (!apiKey) {
		throw new Error(
			"Mistral API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "mistralApiKey": "your-key" }\n` +
			"  2. Set MISTRAL_API_KEY environment variable\n" +
			"Get a key at https://console.mistral.ai/api-keys",
		);
	}
	return apiKey;
}

export function isMistralAvailable(): boolean {
	try {
		const config = loadConfig();
		resolveSearchModel(config.mistralSearchModel);
		resolveSearchTool(config.mistralSearchTool);
		return hasCredentialSource({
			provider: "Mistral",
			configuredValue: config.mistralApiKey,
			environmentValue: process.env.MISTRAL_API_KEY,
		});
	} catch {
		return false;
	}
}

export async function searchWithMistral(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const config = loadConfig();
	const model = resolveSearchModel(config.mistralSearchModel);
	const tool = resolveSearchTool(config.mistralSearchTool);
	const numResults = normalizeSearchResultCount(options.numResults);
	const apiKey = await getApiKey(options.signal);
	const requestSignal = options.signal
		? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
		: AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const response = await fetch(MISTRAL_CONVERSATIONS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				inputs: [{ role: "user", content: buildSearchPrompt(query, options, numResults) }],
				stream: false,
				model,
				tools: [{ type: tool }],
			}),
			signal: requestSignal,
		});

		if (!response.ok) {
			const errorText = redactCredential(await response.text(), apiKey);
			throw new SearchHttpError(response.status, `Mistral API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch (err) {
			throw new Error(`Mistral API returned invalid JSON: ${errorMessage(err)}`);
		}
		const result = parseConversationResponse(parsed, options, numResults);
		activityMonitor.logComplete(activityId, response.status);
		return result;
	} catch (err) {
		const message = errorMessage(err);
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
}
