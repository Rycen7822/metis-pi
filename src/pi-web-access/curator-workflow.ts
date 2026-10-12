// Shared Curator decisions. Tool execution and commands own their delivery and
// cancellation; this module selects results, builds approved summaries and
// resolves the browser's provider defaults.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AttributedSearchResponse } from "./search-router.ts";
import type { CuratorSearchEntry, IndexedCuratorSearchEntry } from "./curator-server.ts";
import type { ExtractedContent } from "./content.ts";
import type { QueryResultData } from "./search-types.ts";
import { ALL_SEARCH_PROVIDERS, RESOLVED_SEARCH_PROVIDERS, type ProviderAvailability, type ResolvedSearchProvider, type SearchProvider, type SearchProviderSelection } from "./search-providers.ts";
import { getAllowedSearchProviders, getConfiguredSearchRouting, getProviderAvailability, normalizeSearchProviderSelection } from "./search-router.ts";
import { isCurrentModelHostedSearchEligible, isOpenAISubscriptionModelSelected } from "./openai-search.ts";
import { loadWebAccessConfig, saveWebAccessConfig } from "./utils.ts";
import { resolveCuratorNetworkConfig } from "./curator-network.ts";
import { buildDeterministicSummary, generateSummaryDraft, SUMMARY_GENERATION_DEADLINE_MS, type SummaryGenerationContext, type SummaryMeta } from "./summary-review.ts";

type SearchPreferences = { numResults?: number; recencyFilter?: "day" | "week" | "month" | "year" };

export function saveDefaultSearchProvider(provider: SearchProvider): void {
	// Readers support the legacy provider key but give searchProvider priority.
	// Keep both in agreement, including the legacy alias's allowlist validation.
	saveWebAccessConfig({ searchProvider: provider, provider });
}

export function resolveCuratorSearchProvider(requested: unknown, current: SearchProviderSelection): SearchProviderSelection {
	const normalized = requested === undefined ? undefined : normalizeSearchProviderSelection(requested);
	if (!normalized || normalized === "auto") return current;
	return normalized === "all" && Array.isArray(current) ? current : normalized;
}

export function getSummaryGenerationDeadlineMs(): number {
	const value = loadWebAccessConfig().summaryGenerationDeadlineMs;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return SUMMARY_GENERATION_DEADLINE_MS;
	return Math.min(value, 600_000);
}

export function getSummaryInstructions(): string | undefined {
	const value = loadWebAccessConfig().summaryInstructions;
	if (typeof value !== "string") return undefined;
	return value.trim() || undefined;
}

export function getCuratorTimeoutSeconds(): number {
	const value = loadWebAccessConfig().curatorTimeoutSeconds;
	if (typeof value === "number" && Number.isFinite(value) && Math.floor(value) >= 1) return Math.min(Math.floor(value), 600);
	return resolveCuratorNetworkConfig().enabled ? 60 : 20;
}

function firstAvailableProvider(available: ProviderAvailability, preferOpenAI: boolean, fallback: ResolvedSearchProvider): ResolvedSearchProvider | "auto" {
	if (available.searxng) return "searxng";
	if (preferOpenAI && available.openai) return "openai";
	if (available.exa) return "exa";
	for (const provider of ALL_SEARCH_PROVIDERS) {
		if (provider === "ollama" && available.bocha) return "bocha";
		if (available[provider]) return provider;
	}
	return getAllowedSearchProviders().includes(fallback) ? fallback : "auto";
}

export function resolveCuratorDefaultProvider(
	provider: SearchProviderSelection,
	available: ProviderAvailability,
	ctx?: Parameters<typeof isOpenAISubscriptionModelSelected>[0],
	options?: SearchPreferences,
): SearchProvider {
	if (Array.isArray(provider)) return "all";
	const supportsDefaultOptions = !options?.recencyFilter && !(typeof options?.numResults === "number" && Number.isFinite(options.numResults) && Math.floor(options.numResults) !== 5);
	const preferOpenAI = supportsDefaultOptions && isOpenAISubscriptionModelSelected(ctx);
	if (provider === "auto") {
		const routing = getConfiguredSearchRouting();
		if (routing) {
			const eligible = (candidate: ResolvedSearchProvider) => candidate !== "openai" || routing.useCurrentModel !== true || isCurrentModelHostedSearchEligible(ctx);
			return routing.providers.find(candidate => eligible(candidate) && available[candidate])
				?? routing.providers.find(eligible) ?? routing.providers[0];
		}
		return firstAvailableProvider(available, preferOpenAI, "exa");
	}
	if (provider === "all") return available.all ? "all" : firstAvailableProvider(available, preferOpenAI, "exa");
	if (ALL_SEARCH_PROVIDERS.includes(provider) && !available[provider]) return firstAvailableProvider(available, provider === "openai" ? false : preferOpenAI, provider);
	return provider;
}

export interface CuratorBootstrap { availableProviders: ProviderAvailability; defaultProvider: SearchProvider; timeoutSeconds: number }

export async function loadCuratorBootstrap(provider: SearchProviderSelection, ctx: ExtensionContext, options?: SearchPreferences): Promise<CuratorBootstrap> {
	const availableProviders = await getProviderAvailability(ctx);
	if (Array.isArray(provider)) availableProviders.all = true;
	return { availableProviders, defaultProvider: resolveCuratorDefaultProvider(provider, availableProviders, ctx, options), timeoutSeconds: getCuratorTimeoutSeconds() };
}

export function orderedCuratorResults(results: Map<number, QueryResultData>): QueryResultData[] {
	return [...results.entries()].sort(([left], [right]) => left - right).map(([, result]) => result);
}

export function selectCuratorResults(indices: number[], results: Map<number, QueryResultData>) {
	const selected = indices.flatMap(index => results.get(index) ?? []);
	return { results: selected, urls: [...new Set(selected.flatMap(result => result.results.map(source => source.url)))] };
}

export async function generateCuratorSummary(indices: number[], results: Map<number, QueryResultData>, context: SummaryGenerationContext, signal?: AbortSignal, model?: string, feedback?: string) {
	const selected = selectCuratorResults(indices, results).results;
	if (selected.length === 0) throw new Error("No selected results available for summary generation");
	return generateSummaryDraft(selected, context, signal, model, feedback, undefined, getSummaryGenerationDeadlineMs(), getSummaryInstructions());
}

export type CuratorSubmission = { selectedQueryIndices: number[]; summary?: string; summaryMeta?: SummaryMeta; rawResults?: boolean };

function approvedSummary(payload: CuratorSubmission, results: QueryResultData[]) {
	const text = typeof payload.summary === "string" ? payload.summary.trim() : "";
	if (!text) {
		const deterministic = buildDeterministicSummary(results);
		return { approvedSummary: deterministic.summary, summaryMeta: deterministic.meta };
	}
	const meta = payload.summaryMeta;
	return { approvedSummary: text, summaryMeta: {
		model: meta?.model ?? null,
		durationMs: meta && Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? meta.durationMs : 0,
		tokenEstimate: meta && Number.isFinite(meta.tokenEstimate) && meta.tokenEstimate >= 0 ? meta.tokenEstimate : Math.max(1, Math.ceil(text.length / 4)),
		fallbackUsed: meta?.fallbackUsed === true,
		fallbackReason: meta?.fallbackReason,
		phase: meta?.phase,
		edited: meta?.edited === true,
	} satisfies SummaryMeta };
}

export function buildCuratedSearchOptions(resultsByIndex: Map<number, QueryResultData>, payload: CuratorSubmission, inlineContent: ExtractedContent[] = []) {
	const all = orderedCuratorResults(resultsByIndex);
	const selected = payload.selectedQueryIndices.length > 0
		? selectCuratorResults(payload.selectedQueryIndices, resultsByIndex)
		: { results: all, urls: [...new Set(all.flatMap(result => result.results.map(source => source.url)))] };
	const selectedContent = inlineContent.filter(content => selected.urls.includes(content.url));
	const base = {
		...selected, queryList: selected.results.map(result => result.query),
		inlineContent: selectedContent.length > 0 ? selectedContent : undefined,
		curated: true as const, curatedFrom: resultsByIndex.size,
	};
	return payload.rawResults ? base : { ...base, workflow: "summary-review" as const, ...approvedSummary(payload, selected.results.length > 0 ? selected.results : all) };
}

// Keep primary query slots stable; additional providers interleave by identity
// rather than search completion order.
export function curatorResultIndex(queryIndex: number, entryIndex: number, queryCount: number): number {
	return entryIndex * queryCount + queryIndex;
}

export function curatorResultIndexCapacity(queryCount: number): number {
	return queryCount * RESOLVED_SEARCH_PROVIDERS.length;
}

export function extractDomain(url: string): string {
	try { return new URL(url).hostname; }
	catch { return url; }
}

export function toCuratorSearchEntries(response: AttributedSearchResponse): CuratorSearchEntry[] {
	const providerResponses = response.provider === "all" && response.providerResponses?.length
		? response.providerResponses
		: [response];
	const entries: CuratorSearchEntry[] = providerResponses.map(result => ({
		answer: result.answer,
		results: result.results.map(source => ({ ...source, domain: extractDomain(source.url) })),
		provider: result.provider,
	}));
	for (const failure of response.providerErrors ?? []) {
		entries.push({
			answer: "",
			results: [],
			provider: failure.provider,
			error: failure.error,
		});
	}
	return entries;
}

export function indexedCuratorEntryToQueryResult(entry: IndexedCuratorSearchEntry): QueryResultData {
	return {
		query: entry.query,
		answer: entry.answer,
		results: entry.results.map(source => ({
			title: source.title,
			url: source.url,
			snippet: source.snippet ?? "",
		})),
		error: entry.error ?? null,
		provider: entry.provider,
	};
}
