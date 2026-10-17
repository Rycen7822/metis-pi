import { stringify } from "smol-toml";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixtures install their own credentials and endpoints after this preload.
const providerPrefixes = [
  "ANYSEARCH", "BAIZHI", "BOCHA", "BRAVE", "BRIGHTDATA", "CERAMIC", "CLOUDFLARE",
  "CRAWL4AI", "DATALAB", "DEGOOG", "EXA", "FIRECRAWL", "GEMINI", "GOOGLE_GEMINI",
  "JINA", "KAGI", "KEENABLE", "MISTRAL", "OLLAMA", "OPENAI", "PARALLEL", "PERPLEXITY",
  "QUERIT", "SEARCH1API", "SEARCHINFINITY", "SEARXNG", "SERPAPI", "SERPBASE", "SERPDIVE",
  "SERPER", "SERPLY", "TAVILY", "TINYFISH", "VALYU", "XAI", "XCRAWL", "YDC", "ZAI",
];
for (const name of Object.keys(process.env)) {
  if (providerPrefixes.some(prefix => name.startsWith(`${prefix}_`))) delete process.env[name];
}
for (const name of [
  "PI_WEB_ACCESS_CACHE_ROOT", "GOOGLE_APPLICATION_CREDENTIALS",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "PI_ALLOW_BROWSER_COOKIES",
]) delete process.env[name];

const root = mkdtempSync(join(tmpdir(), "pi-web-access-test-"));
const home = join(root, "home");
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = join(home, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(home, "AppData", "Local");
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "metis-pi.toml"), stringify({ webAccess: { toolActivation: "eager" } }));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
