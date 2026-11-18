import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { renderToolSignature, resolveSchemaRef } from "@earendil-works/pi-codemode";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { safeText, toolOutputGutter } from "../presentation/terminal-text.ts";
import {
  DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_NAME, describeToolText, isCallable, isLoadable, isVisible,
  rankTools, scriptName,
} from "./search.ts";

const MAX_LIMIT = 25;

const parameters = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("search"), Type.Literal("describe")], {
    description: "search (default) lists candidates without activating them; describe returns parameters and activates one exact match.",
  })),
  query: Type.Optional(Type.String({ description: "Search text over tool names, namespaces and descriptions." })),
  name: Type.Optional(Type.String({ description: "Exact tool name for action=describe. No fuzzy substitution." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT,
    description: `Maximum matches to return (default ${DEFAULT_TOOL_SEARCH_LIMIT}).` })),
  namespace: Type.Optional(Type.String({ description: "Namespace name or alias. Omit query to list that namespace." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Continue a search with nextOffset from the previous result." })),
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
    signature: Type.Optional(Type.String({ description: "Codemode signature including the result type." })),
    parameters: Type.Optional(Type.Unknown()),
    promptGuidelines: Type.Optional(Type.Array(Type.String())),
  })),
  activated: Type.Array(Type.String()),
  namespaces: Type.Optional(Type.Array(Type.Object({ name: Type.String(), description: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()) }))),
  nextOffset: Type.Optional(Type.Integer()),
  query: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
});

type ToolSearchResult = Static<typeof outputSchema>;
type ToolMatch = ToolSearchResult["matches"][number];
type NamespaceInfo = NonNullable<ToolSearchResult["namespaces"]>[number];
type SessionTools = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;

function match(tool: ToolInfo, active: ReadonlySet<string>, description: string): ToolMatch {
  const identifier = scriptName(tool.name);
  return {
    name: tool.name, description, active: active.has(tool.name), callable: isCallable(tool, active),
    ...(tool.namespace ? { namespace: tool.namespace.name } : {}),
    ...(identifier ? { scriptName: identifier } : {}),
  };
}

function discoveryResult(tools: SessionTools, input: Static<typeof parameters>, onDescribe?: (tool: ToolInfo) => void): ToolSearchResult {
  const action = input.action ?? "search";
  if (action !== "search" && action !== "describe")
    throw new Error("action must be \"search\" or \"describe\"");
  const catalog = tools.getAllTools();
  let active = new Set(tools.getActiveTools());
  if (action === "describe") {
    if (typeof input.name !== "string" || !input.name.trim()) throw new Error("action=describe requires a non-empty exact name");
    const term = input.name.trim();
    const tool = catalog.find(tool => tool.name === term && isVisible(tool, active));
    if (!tool) return { action, name: term, matches: [], activated: [],
      message: `No visible tool named "${term}". Use the exact raw name returned by search.` };
    const activated: string[] = [];
    if (isLoadable(tool) && !active.has(tool.name)) {
      tools.setActiveTools([...active, tool.name]);
      active = new Set(tools.getActiveTools());
      if (active.has(tool.name)) activated.push(tool.name);
    }
    onDescribe?.(tool);
    const entry = match(tool, active, tool.description);
    entry.parameters = tool.parameters;
    if (entry.callable) entry.signature = renderToolSignature({ name: tool.name,
      inputSchema: resolveSchemaRef("#", tool.parameters),
      outputSchema: resolveSchemaRef("#", tool.outputSchema) ?? { type: "string" } });
    if (tool.promptGuidelines?.length) entry.promptGuidelines = [...tool.promptGuidelines];
    return { action, name: term, matches: [entry], activated };
  }
  if (input.query !== undefined && (typeof input.query !== "string" || !input.query.trim()))
    throw new Error("query must be a non-empty string when provided");
  if (input.namespace !== undefined && (typeof input.namespace !== "string" || !input.namespace.trim()))
    throw new Error("namespace must be a non-empty string when provided");
  const query = input.query?.trim(), namespace = input.namespace?.trim();
  if (!query && !namespace) throw new Error("action=search requires a query or namespace");
  const limit = input.limit ?? DEFAULT_TOOL_SEARCH_LIMIT, offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
  const ranked = rankTools(catalog, active, { query, namespace });
  const page = ranked.slice(offset, offset + limit);
  const namespaces = new Map<string, NamespaceInfo>();
  if (namespace) for (const tool of page) {
    const group = tool.namespace;
    if (group && !namespaces.has(group.name)) namespaces.set(group.name, {
      name: group.name, description: group.description, instructions: group.instructions,
    });
  }
  return { action, ...(query ? { query } : {}), matches: page.map(tool => match(tool, active, describeToolText(tool.description))), activated: [],
    ...(namespaces.size ? { namespaces: [...namespaces.values()] } : {}),
    ...(offset + limit < ranked.length ? { nextOffset: offset + limit } : {}),
    ...(page.length ? {} : { message: "No matches on this page. Try another query, namespace, or offset." }),
  };
}

/** JSON is the single wire representation for direct calls and native codemode structured results. */
function toolResult(result: ToolSearchResult) {
  const text = JSON.stringify(result);
  return { content: [{ type: "text" as const, text }], details: result, structuredContent: JSON.parse(text) };
}

function renderSummary(result: ToolSearchResult): string {
  if (result.action === "describe") {
    const tool = result.matches[0];
    if (!tool) return result.message ?? "Not found";
    const loaded = result.activated.length ? `, activated ${result.activated.length}` : "";
    return `${tool.name}: description and current parameters${loaded}`;
  }
  return `tool_search ${result.query ? `"${result.query}" ` : ""}${result.matches.length} match(es)`;
}

export function createToolSearchDefinition(
  tools: SessionTools, onDescribe?: (tool: ToolInfo) => void,
): ToolDefinition<typeof parameters, ToolSearchResult> {
  return {
    name: TOOL_SEARCH_NAME,
    label: TOOL_SEARCH_NAME,
    description: "Search visible tools by query or list a namespace without activating anything. Use action=describe with an exact " +
      "raw name for its parameters, Codemode signature, and activation if eligible. Loaded tools stay searchable.",
    promptSnippet: "Search and describe tools, including already loaded ones",
    promptGuidelines: [
      "For direct calls, use tool_search action=describe on the chosen exact name, then call the activated tool.",
      "Inside codemode use tools.tool_search(args) with the same arguments and results. " +
        "Use the reported scriptName when it differs from the raw name.",
    ],
    parameters,
    outputSchema,
    exposure: "codemode",
    reachesTools: () => "all",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, input) {
      return toolResult(discoveryResult(tools, input, onDescribe));
    },
    renderCall(input, theme, context) {
      const label = input.action === "describe" ? `describe ${input.name ?? ""}` : `search ${input.query ?? ""}`;
      const scope = input.namespace ? ` namespace=${input.namespace}` : "";
      const limit = input.limit === undefined ? "" : ` limit=${input.limit}`;
      const offset = input.offset === undefined ? "" : ` offset=${input.offset}`;
      const content = safeText(`${label}${scope}${limit}${offset}`.trim());
      const bullet = theme.fg(context.isError ? "error" : context.isPartial === false ? "success" : "dim", "•");
      return new Text(`${bullet} ${theme.fg("toolTitle", TOOL_SEARCH_NAME)} ${theme.fg("text", content)}`, 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details;
      if (!details || !Array.isArray(details.matches) || !Array.isArray(details.activated)) {
        const message = safeText(result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n"));
        return new Text(message ? toolOutputGutter(message.split("\n"), theme) : "", 0, 0);
      }
      const lines = [renderSummary(details)];
      if (options.expanded && details.matches.length > 0)
        lines.push(...details.matches.map(item => `${item.name} — ${item.description}` +
          `${item.namespace ? ` [${item.namespace}]` : ""}${item.active ? " (active)" : ""}${item.callable ? "" : " (not callable)"}`));
      if (options.expanded && details.action === "describe") {
        const tool = details.matches[0];
        if (tool?.signature) lines.push(tool.signature);
        if (tool?.parameters) lines.push(JSON.stringify(tool.parameters, null, 2));
      }
      const color = options.expanded || details.matches.length === 0 ? "toolOutput" : "muted";
      return new Text(toolOutputGutter(safeText(lines.join("\n")).split("\n"), theme, color), 0, 0);
    },
  };
}
