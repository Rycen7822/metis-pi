// Configuration validation follows Pi 1.0.0 (MIT, Mario Zechner). See NOTICE.
import { existsSync, readFileSync } from "node:fs";
import { defaultMetisConfig, metisConfigPath, readMetisConfig } from "../metis-config.ts";
import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getShellConfig, type McpExposure, type McpServerConfig, type McpServerEntry, type RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
const MCP_EXPOSURES: readonly string[] = ["codemode", "deferred", "direct", "hidden"];
const MCP_EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
type McpHttpServerConfig = Extract<McpServerConfig, { url: string }>;
type McpStdioServerConfig = Extract<McpServerConfig, { command: string }>;
export interface McpPolicy { enabled: boolean; idleTimeoutSeconds: number; keepAliveServers: string[] }
export interface McpConfiguration { servers: McpServerEntry[]; errors: string[]; autoEnableCodemode: boolean; policy: McpPolicy }
function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  return value;
}
export function mcpEnabled(agentDir: string): boolean {
  const section = readMetisConfig(agentDir).config.mcp;
  return isRecord(section) && section.enabled === true;
}
export function readMcpConfiguration(agentDir: string, cwd: string, trusted: boolean, registered: RegisteredMcpServer[] = []): McpConfiguration {
  const result: McpConfiguration = { servers: [], errors: [], autoEnableCodemode: true,
    policy: defaultMetisConfig().mcp as McpPolicy };
  const servers = new Map<string, McpServerEntry>();
  const scopes: ("global" | "project")[] = trusted ? ["global", "project"] : ["global"];
  try {
    const section = readMetisConfig(agentDir).config.mcp;
    if (!isRecord(section)) throw new Error("mcp settings must be a table");
    if (typeof section.enabled !== "boolean") throw new Error("mcp.enabled must be a boolean");
    if (typeof section.idleTimeoutSeconds !== "number" || !Number.isFinite(section.idleTimeoutSeconds) || section.idleTimeoutSeconds <= 0)
      throw new Error("mcp.idleTimeoutSeconds must be positive seconds");
    if (!Array.isArray(section.keepAliveServers) || section.keepAliveServers.some(name => typeof name !== "string"))
      throw new Error("mcp.keepAliveServers must be an array of server names");
    result.policy = section as unknown as McpPolicy;
  } catch (error) { result.errors.push(`${metisConfigPath(agentDir)}: ${(error as Error).message}`); }
  for (const scope of scopes) {
    const dir = scope === "global" ? agentDir : join(cwd, CONFIG_DIR_NAME);
    const path = join(dir, "mcp.json");
    try {
      const raw = readObject(path);
      if (raw.autoEnableCodemode !== undefined) {
        if (typeof raw.autoEnableCodemode !== "boolean") result.errors.push(`${path}: autoEnableCodemode must be a boolean`);
        else result.autoEnableCodemode = raw.autoEnableCodemode;
      }
      if (raw.mcpServers !== undefined && !isRecord(raw.mcpServers)) throw new Error("mcpServers must be an object");
      for (const [name, value] of Object.entries(raw.mcpServers ?? {})) {
        const config = validateMcpServerConfig(name, value);
        if (typeof config === "string") { result.errors.push(`${path}: ${config}`); continue; }
        if (scope === "project" && "url" in config && config.auth) {
          result.errors.push(`${path}: server "${name}": auth is only allowed in global mcp.json`); continue;
        }
        const clash = [...servers.keys()].find(other => other !== name && mcpNamespace(other) === mcpNamespace(name));
        if (clash) { result.errors.push(`${path}: server "${name}" conflicts with "${clash}"`); continue; }
        servers.set(name, { name, config, source: path, scope });
      }
    } catch (error) { result.errors.push(`${path}: ${(error as Error).message}`); }
  }
  for (const entry of registered) {
    if ([...servers.keys()].some(name => mcpNamespace(name) === mcpNamespace(entry.name))) continue;
    servers.set(entry.name, { name: entry.name, config: entry.config, source: entry.extensionPath, scope: "extension" });
  }
  result.servers = [...servers.values()];
  return result;
}

const commandValues = new Map<string, string>();
export function resolveValue(value: string, field: string, commands = true): string {
  if (value.startsWith("!")) {
    if (!commands) throw new Error("Dynamic credentials require discovery");
    let result = commandValues.get(value);
    if (result === undefined) {
      try {
        if (process.platform === "win32") {
          const shell = getShellConfig(), stdin = shell.commandTransport === "stdin";
          const child = spawnSync(shell.shell, stdin ? shell.args : [...shell.args, value.slice(1)], {
            input: stdin ? value.slice(1) : undefined, encoding: "utf8", timeout: 10_000,
            stdio: [stdin ? "pipe" : "ignore", "pipe", "ignore"], windowsHide: true,
          });
          if (child.error || child.status !== 0) throw new Error("command failed");
          result = child.stdout.trim();
        } else result = execSync(value.slice(1), { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch { throw new Error(`Cannot resolve ${field}; credential command failed`); }
      if (!result) throw new Error(`Cannot resolve ${field}; credential command returned no value`);
      commandValues.set(value, result);
    }
    return result;
  }
  return value.replace(/\$(\$|!|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (_, token: string) => {
    if (token === "$" || token === "!") return token;
    const name = token.startsWith("{") ? token.slice(1, -1) : token;
    const resolved = process.env[name];
    if (!resolved) throw new Error(`Cannot resolve ${field}; environment variable ${name} is missing`);
    return resolved;
  });
}
export const expandHome = (value: string): string => value === "~" ? homedir() : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value;
export const serverCwd = (entry: McpServerEntry, cwd: string): string => "command" in entry.config ? resolve(cwd, expandHome(entry.config.cwd ?? ".")) : cwd;
export const resolveValues = (values: Record<string, string> = {}, commands = true): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, resolveValue(value, name, commands)]));
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
		return "oauth.clientSecret must be a string";
	}
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		return "oauth.callbackPort must be a port number";
	}
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) {
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
		const urlPort = new URL(value.callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port) {
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
		}
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) {
		return "oauth.clientName must be a non-empty string";
	}
	const metadataUrl = value.authServerMetadataUrl;
	if (metadataUrl !== undefined) {
		const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
		}
	}
	return undefined;
}

function isExposure(value: unknown): value is McpExposure {
	return typeof value === "string" && MCP_EXPOSURES.includes(value);
}

function resolveExposureAlias(value: unknown): unknown {
	return typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

function resolveExposureAliases(value: Record<string, unknown>): Record<string, unknown> {
	const { exposure, toolExposure } = value;
	const resolved: Record<string, unknown> = { ...value };
	if (exposure !== undefined) resolved.exposure = resolveExposureAlias(exposure);
	if (isRecord(toolExposure)) {
		resolved.toolExposure = Object.fromEntries(
			Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveExposureAlias(entry)]),
		);
	}
	return resolved;
}

function toolPatternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	const overrides = config.toolExposure ?? {};
	const exact = overrides[toolName];
	if (exact !== undefined) return exact;
	for (const [pattern, exposure] of Object.entries(overrides)) {
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	}
	return config.exposure ?? "codemode";
}

export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const value = resolveExposureAliases(raw);
	const { type, exposure, enabled, timeout, toolExposure, description } = value;
	const exposures = MCP_EXPOSURES.map((value) => `"${value}"`).join(", ");
	if (exposure !== undefined && !isExposure(exposure)) {
		return `server "${name}": exposure must be one of ${exposures}`;
	}
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, value] of Object.entries(toolExposure)) {
			if (!isExposure(value)) return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
		}
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (description !== undefined && typeof description !== "string") {
		return `server "${name}": description must be a string`;
	}
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
		return `server "${name}": timeout must be a positive number of seconds`;
	}
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;

	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
			return `server "${name}": url must be an http or https URL`;
		}
		if (value.headers !== undefined && !isStringRecord(value.headers)) {
			return `server "${name}": headers must map names to strings`;
		}
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		if (value.auth !== undefined) {
			if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider) {
				return `server "${name}": auth.provider must be a provider name`;
			}
			const url = new URL(value.url);
			if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
				return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
			}
		}
		return value as unknown as McpHttpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (
			value.args !== undefined &&
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		) {
			return `server "${name}": args must be an array of strings`;
		}
		if (value.env !== undefined && !isStringRecord(value.env))
			return `server "${name}": env must map names to strings`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		return value as unknown as McpStdioServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}
