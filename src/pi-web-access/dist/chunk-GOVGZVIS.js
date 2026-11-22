import {
  loadWebAccessConfig
} from "./chunk-U3C4JCC5.js";

// src/pi-web-access/summary-model-scope.ts
var THINKING_LEVELS = /* @__PURE__ */ new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
var AmbiguousModelError = class extends Error {
  name = "AmbiguousModelError";
};
function findModelWithProviderRouting(registry, provider, id, scopedModels = []) {
  const available = registry.getAvailable().filter((model) => isModelInScope(model, scopedModels));
  const direct = available.find((model) => model.provider === provider && model.id === id);
  if (direct) return direct;
  const routedId = `${provider}/${id}`;
  const routed = available.filter((model) => model.id === routedId);
  if (routed.length > 1) {
    const choices = routed.map((model) => `${model.provider}/${model.id}`).sort();
    throw new AmbiguousModelError(`Ambiguous model ${routedId}. Specify an explicit provider/model: ${choices.join(", ")}.`);
  }
  return routed[0] ?? registry.find(provider, id);
}
function isModelInScope(model, scopedModels) {
  return scopedModels.length === 0 || scopedModels.some((scoped) => scoped.model.provider === model.provider && scoped.model.id === model.id);
}
function splitThinkingSuffix(value) {
  const index = value.lastIndexOf(":");
  if (index < 0) return { value };
  const suffix = value.slice(index + 1);
  return THINKING_LEVELS.has(suffix) ? { value: value.slice(0, index), thinkingLevel: suffix } : { value };
}

// src/pi-web-access/search-providers.ts
var RESOLVED_SEARCH_PROVIDERS = [
  "openai",
  "brave",
  "parallel",
  "parallel-mcp",
  "tinyfish",
  "search1api",
  "searchinfinity",
  "querit",
  "tavily",
  "you",
  "firecrawl",
  "jina",
  "searxng",
  "degoog",
  "duckduckgo",
  "perplexity",
  "gemini",
  "kimi",
  "exa",
  "serpdive",
  "kagi",
  "ollama",
  "anysearch",
  "xai",
  "mistral",
  "brightdata",
  "serpbase",
  "serpapi",
  "serper",
  "serply",
  "valyu",
  "bocha",
  "xcrawl",
  "baizhi",
  "zai",
  "keenable",
  "ceramic",
  "deepseek"
];
var SEARCH_PROVIDERS = ["auto", "all", ...RESOLVED_SEARCH_PROVIDERS];
var ALL_SEARCH_PROVIDERS = ["searxng", "openai", "exa", "brave", "parallel", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "firecrawl", "jina", "serpdive", "kagi", "ollama", "perplexity", "gemini", "bocha"];
var SEARCH_PROVIDER_LABELS = {
  auto: "Auto",
  all: "All",
  openai: "OpenAI",
  brave: "Brave",
  parallel: "Parallel",
  "parallel-mcp": "Parallel MCP",
  tinyfish: "TinyFish",
  search1api: "Search1API",
  searchinfinity: "Searchinfinity",
  querit: "Querit",
  tavily: "Tavily",
  you: "You.com",
  firecrawl: "Firecrawl",
  jina: "Jina",
  searxng: "SearXNG",
  degoog: "degoog",
  duckduckgo: "DuckDuckGo",
  perplexity: "Perplexity",
  gemini: "Gemini",
  kimi: "Kimi",
  exa: "Exa",
  serpdive: "SERPdive",
  kagi: "Kagi",
  ollama: "Ollama",
  anysearch: "Anysearch",
  xai: "xAI",
  mistral: "Mistral",
  brightdata: "Bright Data",
  serpbase: "SerpBase",
  serpapi: "SerpApi",
  serper: "Serper",
  serply: "Serply",
  valyu: "Valyu",
  bocha: "Bocha",
  xcrawl: "XCrawl",
  baizhi: "Baizhi",
  zai: "Z.ai",
  keenable: "Keenable",
  ceramic: "Ceramic",
  deepseek: "DeepSeek"
};
function providerLabel(provider) {
  return SEARCH_PROVIDER_LABELS[provider];
}

// src/pi-web-access/curator-network.ts
import { hostname } from "node:os";
var LOCAL_CURATOR_NETWORK_DEFAULTS = { enabled: false, host: "localhost", bind: "127.0.0.1" };
function trimmedString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function resolveCuratorNetworkConfig() {
  const curatorRemote = loadWebAccessConfig().curatorRemote;
  if (curatorRemote === true) return { enabled: true, host: hostname(), bind: "0.0.0.0" };
  if (curatorRemote && typeof curatorRemote === "object" && !Array.isArray(curatorRemote)) {
    const obj = curatorRemote;
    return {
      enabled: true,
      host: trimmedString(obj.host) ?? hostname(),
      bind: trimmedString(obj.bind) ?? "0.0.0.0"
    };
  }
  return LOCAL_CURATOR_NETWORK_DEFAULTS;
}

export {
  AmbiguousModelError,
  findModelWithProviderRouting,
  isModelInScope,
  splitThinkingSuffix,
  RESOLVED_SEARCH_PROVIDERS,
  SEARCH_PROVIDERS,
  ALL_SEARCH_PROVIDERS,
  SEARCH_PROVIDER_LABELS,
  providerLabel,
  resolveCuratorNetworkConfig
};
