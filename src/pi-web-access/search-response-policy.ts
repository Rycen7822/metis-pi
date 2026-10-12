import type { SearchResponse } from "./search-types.ts";
import { normalizeDomainFilters, matchesDomainFilter } from "./domain-filter-normalization.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";

export function filterSearchResponseByDomain(response: SearchResponse, domainFilter?: readonly string[]): SearchResponse {
	const filters = normalizeDomainFilters(domainFilter);
	if (filters.include.length === 0 && filters.exclude.length === 0) return response;
	const results = response.results.filter(result => matchesDomainFilter(result.url, filters));
	const urls = new Set(results.map(result => result.url));
	const inlineContent = response.inlineContent?.filter(content => urls.has(content.url));
	// Provider prose may cite sources outside its returned URL list. A filtered
	// response uses only the retained source snippets, rather than that unbound prose.
	return {
		answer: formatSearchResultsAsAnswer(results),
		results,
		inlineContent: inlineContent?.length ? inlineContent : undefined,
	};
}
