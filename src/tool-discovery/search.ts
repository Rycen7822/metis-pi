import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode";

export const TOOL_SEARCH_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
const DESCRIPTION_LIMIT = 500;

export interface RankRequest {
  query: string;
  limit: number;
  namespace?: string;
}

/** Registered metadata only: hidden tools are unreachable, inactive direct/model-only tools are not model-visible. */
export function isVisible(tool: ToolInfo, active: ReadonlySet<string>): boolean {
  if (tool.exposure === "hidden") return false;
  if (tool.exposure === "codemode" || tool.exposure === "deferred") return true;
  return active.has(tool.name);
}

/** Direct tools are callable only while active; model-only tools are never callable. */
export function isCallable(tool: ToolInfo, active: ReadonlySet<string>): boolean {
  if (tool.exposure === "codemode" || tool.exposure === "deferred") return true;
  return tool.exposure === "direct" && active.has(tool.name);
}

export function isLoadable(tool: ToolInfo): boolean {
  return tool.exposure === "codemode" || tool.exposure === "deferred";
}

/** The script identifier pi actually binds, when the raw name is not one. */
export function scriptName(name: string): string | undefined {
  const identifier = toCodemodeIdentifier(name);
  return identifier === name ? undefined : identifier;
}

export function describeToolText(description: string): string {
  const text = description.trim();
  return text.length <= DESCRIPTION_LIMIT ? text : `${text.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

function normalize(text: string): string {
  return text.normalize("NFC").trim().toLowerCase();
}

function tokens(text: string): string[] {
  return text
    .normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function namespaceMatches(tool: ToolInfo, query: string): boolean {
  const namespace = tool.namespace;
  if (!namespace) return false;
  const key = normalize(query);
  const identifier = toCodemodeIdentifier(query);
  return [namespace.name, ...(namespace.aliases ?? [])].some(name =>
    name === query || normalize(name) === key || toCodemodeIdentifier(name) === identifier);
}

/** Exact raw name, then the local name after `__`, then the script identifier search callers may type. */
function exactTier(tool: ToolInfo, query: string): number {
  const key = normalize(query);
  const name = normalize(tool.name);
  const local = normalize(tool.name.split("__").pop() ?? tool.name);
  if (name === key) return 2;
  if (local === key || toCodemodeIdentifier(tool.name) === toCodemodeIdentifier(query)) return 1;
  return 0;
}

/** Deterministic lexical rank over name, namespace and description; no index or persistence. */
export function rankTools(tools: readonly ToolInfo[], active: ReadonlySet<string>, request: RankRequest): ToolInfo[] {
  const queryTokens = [...new Set(tokens(request.query))];
  if (queryTokens.length === 0) return [];
  const ranked = tools
    .filter(tool => isVisible(tool, active))
    .filter(tool => request.namespace === undefined || namespaceMatches(tool, request.namespace))
    .flatMap(tool => {
      const nameTokens = new Set(tokens(tool.name));
      const namespaceTokens = new Set(tokens(tool.namespace?.name ?? ""));
      const descriptionTokens = new Set(tokens(tool.description));
      let nameHits = 0;
      let namespaceHits = 0;
      let descriptionHits = 0;
      let coverage = 0;
      for (const token of queryTokens) {
        const inName = nameTokens.has(token);
        const inNamespace = namespaceTokens.has(token);
        const inDescription = descriptionTokens.has(token);
        if (inName) nameHits += 1;
        if (inNamespace) namespaceHits += 1;
        if (inDescription) descriptionHits += 1;
        if (inName || inNamespace || inDescription) coverage += 1;
      }
      const exact = exactTier(tool, request.query);
      const score = nameHits * 5 + namespaceHits * 2 + descriptionHits;
      return score > 0 || exact > 0 ? [{ tool, exact, coverage, score }] : [];
    });
  ranked.sort((a, b) => b.exact - a.exact || b.coverage - a.coverage || b.score - a.score
    || a.tool.name.localeCompare(b.tool.name));
  return ranked.slice(0, request.limit).map(match => match.tool);
}
