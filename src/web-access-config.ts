import { homedir } from "node:os";
import { join } from "node:path";

type Config = Record<string, unknown>;
type ReadFile = (path: string) => string | undefined;

export const WEB_CREDENTIALS_FILE = "web-search.json";

export function webAccessAgentDir(): string {
  const configured = process.env["PI_CODING_AGENT_DIR"];
  if (!configured) return join(homedir(), ".pi", "agent");
  return configured.replace(/^~(?=$|[\\/])/, () => homedir());
}

/** The agent-dir JSON is a credential channel, never a preference source. */
export function readWebAccessCredentials(agentDir: string, read: ReadFile): Config {
  const path = join(agentDir, WEB_CREDENTIALS_FILE), text = read(path);
  if (text === undefined) return {};
  let config: unknown;
  try { config = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (error) {
    // JSON parser messages may include credential payloads; report only position.
    const position = (error as Error).message.match(/at position \d+(?: \(line \d+ column \d+\))?/i);
    throw new Error(`Failed to parse ${path}: not valid JSON${position ? `, ${position[0]}` : ""}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid config in ${path}: expected a JSON object`);
  }
  return splitWebAccessConfig(config as Config).credentials;
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
