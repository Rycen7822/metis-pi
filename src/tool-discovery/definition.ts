import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { safeText } from "../presentation/terminal-text.ts";
import {
  DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_NAME, describeToolText, isCallable, isLoadable, isVisible,
  rankTools, scriptName,
} from "./search.ts";

export interface ToolMatch {
  name: string;
  description: string;
  active: boolean;
  callable: boolean;
  namespace?: string;
  scriptName?: string;
  parameters?: ToolInfo["parameters"];
  promptGuidelines?: string[];
}

export interface ToolSearchResult {
  action: "search" | "describe";
  matches: ToolMatch[];
  activated: string[];
  query?: string;
  name?: string;
  message?: string;
}

const MAX_LIMIT = 25;

const parameters = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("search"), Type.Literal("describe")], {
    description: "search (default) ranks visible tools and loads new matches; describe reads one tool's current parameters.",
  })),
  query: Type.Optional(Type.String({ description: "Search text over tool names, namespaces and descriptions." })),
  name: Type.Optional(Type.String({ description: "Exact tool name for action=describe. No fuzzy substitution." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT,
    description: `Maximum matches to return (default ${DEFAULT_TOOL_SEARCH_LIMIT}).` })),
  namespace: Type.Optional(Type.String({ description: "Only tools of this namespace name or alias." })),
}, { additionalProperties: false });

const outputSchema = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("describe")]),
  matches: Type.Array(Type.Object({
    name: Type.String(),
    description: Type.String(),
    active: Type.Boolean(),
    callable: Type.Boolean(),
    namespace: Type.Optional(Type.String()),
    scriptName: Type.Optional(Type.String()),
    parameters: Type.Optional(Type.Unknown()),
    promptGuidelines: Type.Optional(Type.Array(Type.String())),
  })),
  activated: Type.Array(Type.String()),
  query: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
});

export type SessionTools = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;

function match(tool: ToolInfo, active: ReadonlySet<string>, detailed: boolean): ToolMatch {
  const identifier = scriptName(tool.name);
  return {
    name: tool.name,
    description: detailed ? tool.description : describeToolText(tool.description),
    active: active.has(tool.name),
    callable: isCallable(tool, active),
    ...(tool.namespace ? { namespace: tool.namespace.name } : {}),
    ...(identifier ? { scriptName: identifier } : {}),
    ...(detailed ? { parameters: tool.parameters } : {}),
    ...(detailed && tool.promptGuidelines?.length ? { promptGuidelines: [...tool.promptGuidelines] } : {}),
  };
}

function search(tools: SessionTools, query: string, limit: number, namespace?: string): ToolSearchResult {
  const activeNow = new Set(tools.getActiveTools());
  const matches = rankTools(tools.getAllTools(), activeNow, { query, limit, namespace });
  // Only new, script-reachable targets are loaded; active or model-only tools never change the set.
  const loaded = matches.filter(tool => isLoadable(tool) && !activeNow.has(tool.name));
  if (loaded.length > 0) tools.setActiveTools([...activeNow, ...loaded.map(tool => tool.name)]);
  const active = new Set(tools.getActiveTools());
  const result = {
    action: "search" as const,
    matches: matches.map(tool => match(tool, active, false)),
    activated: loaded.filter(tool => active.has(tool.name)).map(tool => tool.name),
    query,
  };
  return matches.length > 0 ? result : { ...result,
    message: "No matching tools. Try another wording, or call action=describe with an exact name; loaded tools stay searchable." };
}

function describe(tools: SessionTools, name: string): ToolSearchResult {
  const wanted = name.trim();
  const active = new Set(tools.getActiveTools());
  const exact = tools.getAllTools().find(tool => tool.name === wanted && isVisible(tool, active));
  if (!exact) {
    return {
      action: "describe", name: wanted, matches: [], activated: [],
      message: `No visible tool named "${wanted}". Use the exact raw name returned by search.`,
    };
  }
  return { action: "describe", name: exact.name, matches: [match(exact, active, true)], activated: [] };
}

/** JSON is the single wire representation for direct calls and native codemode structured results. */
function toolResult(result: ToolSearchResult) {
  const text = JSON.stringify(result);
  return { content: [{ type: "text" as const, text }], details: result, structuredContent: JSON.parse(text) };
}

function renderSummary(result: ToolSearchResult): string {
  if (result.action === "describe")
    return result.matches[0] ? `${result.matches[0].name}: description and current parameters` : result.message ?? "Not found";
  const loaded = result.activated.length > 0 ? `, activated ${result.activated.length}` : "";
  return `tool_search ${result.query ? `"${result.query}" ` : ""}${result.matches.length} match(es)${loaded}`;
}

export function createToolSearchDefinition(tools: SessionTools): ToolDefinition<typeof parameters, ToolSearchResult> {
  return {
    name: TOOL_SEARCH_NAME,
    label: TOOL_SEARCH_NAME,
    description: "# Tool discovery\n\nSearches visible tool metadata and loads newly matched codemode/deferred tools for the next model call. " +
      "Loaded tools stay searchable: search again for their current listing, or use action=describe for the exact top-level parameters. " +
      "Direct model calls keep the raw tool name; scripts use the reported scriptName when it differs.",
    promptSnippet: "Search and describe tools, including already loaded ones",
    promptGuidelines: [
      "tool_search ranks currently visible tools, including already loaded tools, and activates new codemode/deferred matches. " +
        "Repeat a search to find a loaded tool again; use action=describe with the exact name for its current parameters before calling it.",
      "tool_search results are the current catalog for this session. A missing name does not prove a tool is unavailable: search again, " +
        "and prefer the reported scriptName for codemode calls when it differs from the raw name.",
    ],
    parameters,
    outputSchema,
    exposure: "codemode",
    reachesTools: () => "all",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, input) {
      const action = input.action ?? "search";
      if (action !== "search" && action !== "describe")
        throw new Error("action must be \"search\" or \"describe\"");
      if (action === "describe") {
        if (typeof input.name !== "string" || input.name.trim() === "")
          throw new Error("action=describe requires a non-empty exact name");
        const result = describe(tools, input.name);
        return toolResult(result);
      }
      if (typeof input.query !== "string" || input.query.trim() === "")
        throw new Error("action=search requires a non-empty query");
      if (input.namespace !== undefined && typeof input.namespace !== "string")
        throw new Error("namespace must be a string");
      const limit = input.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
      const result = search(tools, input.query.trim(), limit, input.namespace?.trim() || undefined);
      return toolResult(result);
    },
    renderCall(input, theme) {
      const label = input.action === "describe" ? `describe ${input.name ?? ""}` : `search ${input.query ?? ""}`;
      const scope = input.namespace ? ` namespace=${input.namespace}` : "";
      const limit = input.limit === undefined ? "" : ` limit=${input.limit}`;
      return new Text(theme.fg("toolTitle", safeText(`${TOOL_SEARCH_NAME} ${label}${scope}${limit}`.trim())), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details;
      if (!details || !Array.isArray(details.matches) || !Array.isArray(details.activated)) {
        const message = result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
        return new Text(theme.fg("toolOutput", safeText(message)), 0, 0);
      }
      const lines = [renderSummary(details)];
      if (options.expanded && details.matches.length > 0)
        lines.push(...details.matches.map(item => `${item.name} — ${item.description}` +
          `${item.namespace ? ` [${item.namespace}]` : ""}${item.active ? " (active)" : ""}${item.callable ? "" : " (not callable)"}`));
      if (options.expanded && details.action === "describe" && details.matches[0]?.parameters)
        lines.push(JSON.stringify(details.matches[0].parameters, null, 2));
      return new Text(theme.fg(options.expanded || details.matches.length === 0 ? "toolOutput" : "muted",
        safeText(lines.join("\n"))), 0, 0);
    },
  };
}
