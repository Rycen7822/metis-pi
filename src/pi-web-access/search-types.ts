import type { ExtractedContent } from "./content.ts";
import type { Lookup } from "./ssrf-protection.ts";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
	/** Optional request implementation for guarded provider endpoints; never a tool/config parameter. */
	fetch?: typeof globalThis.fetch;
	lookup?: Lookup;
}

export interface QueryResultData {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
	providers?: string[];
}

/** An adapter cannot honor this filter; callers must choose a supported provider. */
export class SearchUnsupportedFilterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SearchUnsupportedFilterError";
	}
}

/** An HTTP failure fact, independent of provider diagnostic wording. */
export class SearchHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "SearchHttpError";
		this.status = status;
	}
}
