export const RESOLVED_SEARCH_PROVIDERS = ["openai", "brave", "parallel", "parallel-mcp", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "you", "firecrawl", "jina", "searxng", "degoog", "duckduckgo", "perplexity", "gemini", "kimi", "exa", "serpdive", "kagi", "ollama", "anysearch", "xai", "mistral", "brightdata", "serpbase", "serpapi", "serper", "serply", "valyu", "bocha", "xcrawl", "baizhi", "zai", "keenable", "ceramic"] as const;
export const SEARCH_PROVIDERS = ["auto", "all", ...RESOLVED_SEARCH_PROVIDERS] as const;

export type ResolvedSearchProvider = typeof RESOLVED_SEARCH_PROVIDERS[number];
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
export type SearchProviderSelection = SearchProvider | ResolvedSearchProvider[];
export type ProviderAvailability = { all: boolean } & Record<ResolvedSearchProvider, boolean>;
// Explicit-only providers (Parallel MCP, degoog, DuckDuckGo, Kimi, AnySearch, XCrawl, xAI, Mistral, Bright Data, SerpBase, SerpApi, Serper, Serply, You.com, Valyu, Baizhi, Z.ai, Keenable, Ceramic) are deliberately absent:
// `all` must never fan out to an opt-in or paid provider without the user asking for it.
export const ALL_SEARCH_PROVIDERS: ResolvedSearchProvider[] = ["searxng", "openai", "exa", "brave", "parallel", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "firecrawl", "jina", "serpdive", "kagi", "ollama", "perplexity", "gemini", "bocha"];

export const SEARCH_PROVIDER_LABELS: Record<SearchProvider, string> = {
	auto: "Auto", all: "All", openai: "OpenAI", brave: "Brave", parallel: "Parallel", "parallel-mcp": "Parallel MCP",
	tinyfish: "TinyFish", search1api: "Search1API", searchinfinity: "Searchinfinity", querit: "Querit", tavily: "Tavily",
	you: "You.com", firecrawl: "Firecrawl", jina: "Jina", searxng: "SearXNG", degoog: "degoog", duckduckgo: "DuckDuckGo",
	perplexity: "Perplexity", gemini: "Gemini", kimi: "Kimi", exa: "Exa", serpdive: "SERPdive", kagi: "Kagi", ollama: "Ollama",
	anysearch: "Anysearch", xai: "xAI", mistral: "Mistral", brightdata: "Bright Data", serpbase: "SerpBase", serpapi: "SerpApi",
	serper: "Serper", serply: "Serply", valyu: "Valyu", bocha: "Bocha", xcrawl: "XCrawl", baizhi: "Baizhi", zai: "Z.ai",
	keenable: "Keenable", ceramic: "Ceramic",
};

export function providerLabel(provider: SearchProvider): string {
	return SEARCH_PROVIDER_LABELS[provider];
}
