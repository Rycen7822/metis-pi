import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Config = Record<string, unknown>;
type ReadFile = (path: string) => string | undefined;

export const WEB_CREDENTIALS_FILE = "web-search.json";

export function webAccessAgentDir(): string {
  const configured = process.env["PI_CODING_AGENT_DIR"];
  if (!configured) return join(homedir(), ".pi", "agent");
  return configured.replace(/^~(?=$|[\\/])/, () => homedir());
}

function legacyPaths(agentDir: string): string[] {
  const paths = [join(agentDir, WEB_CREDENTIALS_FILE)];
  if (process.env["PI_CODING_AGENT_DIR"] || resolve(agentDir) !== resolve(webAccessAgentDir())) return paths;
  if (process.env["XDG_CONFIG_HOME"]) paths.push(join(process.env["XDG_CONFIG_HOME"], "pi", WEB_CREDENTIALS_FILE));
  paths.push(join(homedir(), ".pi", WEB_CREDENTIALS_FILE));
  return paths;
}

export function readLegacyWebAccess(
  agentDir: string, read: ReadFile,
): { path: string; config: Config; preferences: Config } | undefined {
  for (const path of legacyPaths(agentDir)) {
    const text = read(path);
    if (text === undefined) continue;
    let config: unknown;
    try { config = JSON.parse(text.replace(/^\uFEFF/, "")); }
    catch (error) {
      const position = (error as Error).message.match(/at position \d+(?: \(line \d+ column \d+\))?/i);
      throw new Error(`Failed to parse ${path}: not valid JSON${position ? `, ${position[0]}` : ""}`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`Invalid config in ${path}: expected a JSON object`);
    }
    const preferences = splitWebAccessConfig(config as Config).preferences;
    if (path !== join(agentDir, WEB_CREDENTIALS_FILE) && !Object.hasOwn(preferences, "cacheRoot")) {
      preferences["cacheRoot"] = dirname(path);
    }
    return { path, config: config as Config, preferences };
  }
  return undefined;
}

export function splitWebAccessConfig(config: Config): { preferences: Config; credentials: Config } {
  const preferences: Config = {}, credentials: Config = {};
  for (const [key, value] of Object.entries(config)) {
    let sensitive = /(?:apiKey|token|password|secret)$/i.test(key) || key === "searxngHeaders" || key === "degoogHeaders";
    if (key === "proxy" && typeof value === "string") {
      try {
        const url = new URL(value);
        sensitive ||= !!(url.username || url.password);
      } catch { /* Invalid proxy values remain preferences for the existing validator. */ }
    }
    Object.defineProperty(sensitive ? credentials : preferences, key, {
      value, enumerable: true, configurable: true, writable: true,
    });
  }
  return { preferences, credentials };
}
