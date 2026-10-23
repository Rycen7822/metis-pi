export const PROVIDER_ENV_PREFIXES = [
  "ANYSEARCH", "BAIZHI", "BOCHA", "BRAVE", "BRIGHTDATA", "CERAMIC", "CLOUDFLARE",
  "CRAWL4AI", "DATALAB", "DEGOOG", "EXA", "FIRECRAWL", "GEMINI", "GOOGLE_GEMINI",
  "JINA", "KAGI", "KEENABLE", "MISTRAL", "OLLAMA", "OPENAI", "PARALLEL", "PERPLEXITY",
  "QUERIT", "SEARCH1API", "SEARCHINFINITY", "SEARXNG", "SERPAPI", "SERPBASE", "SERPDIVE",
  "SERPER", "SERPLY", "TAVILY", "TINYFISH", "VALYU", "XAI", "XCRAWL", "YDC", "ZAI",
];
export const ISOLATED_ENV_KEYS = [
  "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "PI_WEB_ACCESS_CACHE_ROOT",
  "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION", "GCLOUD_PROJECT", "PI_ALLOW_BROWSER_COOKIES",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];

export function clearProviderEnvironment(environment) {
  for (const name of Object.keys(environment)) {
    if (ISOLATED_ENV_KEYS.includes(name) || PROVIDER_ENV_PREFIXES.some(prefix => name.startsWith(`${prefix}_`))) delete environment[name];
  }
}
