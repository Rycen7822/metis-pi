import { randomBytes, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { toLlmContent, type CallToolResult, type ContentBlock } from "@earendil-works/pi-mcp";
import type { ImageContent, TextContent, JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { getMcpToolExposure, isRecord, mcpNamespace } from "./config.ts";
import type { McpServerSession } from "./session.ts";

export function isUiResource(item: { uri?: string; uriTemplate?: string; mimeType?: string }): boolean {
  return (item.uri ?? item.uriTemplate ?? "").startsWith("ui://") || /;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType ?? "");
}
function visible(block: ContentBlock): boolean {
  return block.type === "resource" ? !isUiResource(block.resource) : block.type !== "resource_link" || !isUiResource(block);
}
async function save(data: string | Uint8Array, extension: string) {
  const path = join(tmpdir(), `metis-mcp-${randomBytes(8).toString("hex")}${extension}`);
  await writeFile(path, data, { mode: 0o600 }); return path;
}
export async function convertResult(server: string, tool: string, result: CallToolResult) {
  const blocks = result.content.filter(visible);
  const content: (TextContent | ImageContent)[] = [];
  for (const block of blocks) {
    if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
      const resource = block.resource,
        data = Buffer.from(resource.blob, "base64"),
        mime = resource.mimeType?.split(";")[0] ?? "";
      if (/^text\/|^application\/json$|\+json$|\+xml$/.test(mime))
        content.push({ type: "text", text: data.toString("utf8") });
      else {
        const extension = /\.[A-Za-z0-9]{1,8}$/.exec(resource.uri)?.[0] ?? ".bin";
        try {
          content.push({
            type: "text",
            text: `Binary resource ${resource.uri} saved to ${await save(data, extension)}`,
          });
        } catch {
          content.push({ type: "text", text: `Binary resource ${resource.uri} could not be saved` });
        }
      }
    } else if (block.type === "resource_link") {
      content.push({
        type: "text",
        text: `Resource ${block.uri} (${block.title ?? block.name}). Read with read_mcp_resource (server "${server}").`,
      });
    } else content.push(...toLlmContent({ content: [block] }));
  }
  if (!blocks.length && result.structuredContent !== undefined)
    content.push(...toLlmContent({ content: [], structuredContent: result.structuredContent }));
  if (result.isError && !content.some((block) => block.type === "text" && block.text))
    content.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const bytes = Buffer.from(text),
    truncated = bytes.length > 20 * 1024;
  let preview = text;
  if (truncated) {
    let tail = bytes.length - 10 * 1024;
    while ((bytes[tail] & 0xc0) === 0x80) tail++;
    preview =
      new StringDecoder("utf8").write(bytes.subarray(0, 10 * 1024)) + "\n...\n" + bytes.subarray(tail).toString("utf8");
  }
  let fullOutputPath: string | undefined;
  if (truncated)
    try {
      fullOutputPath = await save(text, ".txt");
    } catch {}
  const { _meta: _ignored, ...raw } = result;
  return {
    content: truncated
      ? [
          {
            type: "text" as const,
            text: `${preview}\n${fullOutputPath ? `Full output: ${fullOutputPath}` : "Full output could not be saved"}`,
          },
          ...content.filter((block) => block.type !== "text"),
        ]
      : content,
    structuredContent: { ...raw, content: blocks } as unknown as JsonValue,
    details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
    ...(result.isError ? { isError: true } : {}),
  };
}
const resultSchema = (schema?: Record<string, unknown>): TSchema => ({ type: "object", properties: {
  content: { type: "array", items: { type: "object", additionalProperties: true } },
  ...(schema ? { structuredContent: schema } : {}), isError: { type: "boolean" },
}, required: ["content"], additionalProperties: true } as TSchema);
const shortenedName = (server: string, tool: string, conflict: boolean) => {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= 64 && !conflict) return name;
  return `${name.slice(0, 55)}_${createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8)}`;
};
export function syncTools(pi: ExtensionAPI, servers: Iterable<McpServerSession>, owned: Map<string, ToolDefinition>) {
  const owners = [...servers].filter((server) => !server.closed);
  const definitions = new Map<string, ToolDefinition>();
  const candidates = owners.flatMap((server) =>
    server.catalog.tools.map((tool) => ({ server, tool, plain: shortenedName(server.entry.name, tool.name, false) })),
  );
  const counts = new Map<string, number>();
  const others = new Set(
    pi
      .getAllTools()
      .filter((tool) => !owned.has(tool.name))
      .map((tool) => tool.name),
  );
  for (const candidate of candidates) counts.set(candidate.plain, (counts.get(candidate.plain) ?? 0) + 1);
  for (const { server, tool, plain } of candidates) {
    const name = shortenedName(server.entry.name, tool.name, (counts.get(plain) ?? 0) > 1 || others.has(plain));
    if (others.has(name) || definitions.has(name)) throw new Error(`MCP tool name collision: ${name}`);
    const exposure = getMcpToolExposure(server.entry.config, tool.name),
      scope = server.scope;
    const parameters = {
      ...tool.inputSchema,
      type: tool.inputSchema.type ?? "object",
      properties: tool.inputSchema.properties ?? {},
    } as TSchema;
    definitions.set(name, {
      name,
      label: `${server.entry.name}/${tool.name}`,
      description: tool.description?.trim() || tool.title || `MCP tool ${tool.name}`,
      parameters,
      outputSchema: resultSchema(tool.outputSchema),
      exposure: exposure === "codemode" ? "deferred" : exposure,
      namespace: {
        name: mcpNamespace(server.entry.name),
        description: server.entry.config.description,
        instructions: server.catalog.instructions,
      },
      annotations: server.cached ? undefined : tool.annotations,
      async execute(_id, args, signal, update) {
        const result = await server.callTool(tool, scope, args as Record<string, unknown>, {
          signal,
          onProgress: (progress) =>
            update?.({
              content: [{ type: "text", text: progress.message ?? `Progress ${progress.progress}` }],
              details: {},
            }),
        });
        return convertResult(server.entry.name, tool.name, result);
      },
    });
  }
  const readable = owners.filter((server) => server.catalog.hasResources && server.entry.config.exposure !== "hidden");
  if (readable.length)
    for (const definition of resourceTools(
      () => owners,
      readable.some((server) => server.entry.config.exposure === "direct") ? "direct" : "deferred",
    )) {
      if (others.has(definition.name)) throw new Error(`MCP resource tool already registered: ${definition.name}`);
      definitions.set(definition.name, definition);
    }
  for (const [name, old] of owned)
    if (!definitions.has(name))
      pi.registerTool({
        ...old,
        exposure: "hidden",
        async execute() {
          throw new Error("This MCP tool is no longer available");
        },
      });
  for (const [name, definition] of definitions)
    pi.registerTool({
      ...definition,
      defaultActive: !owned.has(name) || owned.get(name)?.exposure !== definition.exposure,
    });
  const inactive = new Set(
    [...owned.keys()].filter((name) => !definitions.has(name) || definitions.get(name)?.exposure === "hidden"),
  );
  if (inactive.size) pi.setActiveTools(pi.getActiveTools().filter((name) => !inactive.has(name)));
  for (const [name, old] of owned) if (!definitions.has(name)) owned.set(name, { ...old, exposure: "hidden" });
  for (const pair of definitions) owned.set(...pair);
}
function resourceTools(servers: () => McpServerSession[], exposure: "direct" | "deferred"): ToolDefinition[] {
  const string = { type: "string" },
    base = { server: string, cursor: string };
  return (["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] as const).map((name, index) => ({
    name,
    label: name,
    description:
      index === 2
        ? "Read an ordinary MCP resource by server and URI."
        : "List ordinary MCP resources. Follow nextCursor for more; optionally select a server.",
    exposure,
    parameters: {
      type: "object",
      properties: index === 2 ? { server: string, uri: string } : base,
      ...(index === 2 ? { required: ["server", "uri"] } : {}),
      additionalProperties: false,
    } as TSchema,
    outputSchema: { type: "object", additionalProperties: true } as TSchema,
    async execute(_id, args, signal) {
      const input = args as { server?: string; cursor?: string; uri?: string };
      const eligible = servers().filter(
        (server) => !server.closed && server.catalog.hasResources && server.entry.config.exposure !== "hidden",
      );
      const names = eligible
        .filter((server) => !input.server || server.entry.name === input.server)
        .map((server) => server.entry.name);
      let cursor: { names: string[]; cursor?: string } = { names };
      if (input.cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
          if (
            !isRecord(decoded) ||
            !Array.isArray(decoded.names) ||
            decoded.names.some((name) => typeof name !== "string") ||
            (decoded.cursor !== undefined && typeof decoded.cursor !== "string")
          )
            throw new Error("Invalid cursor");
          cursor = decoded as { names: string[]; cursor?: string };
        } catch {
          throw new Error("Invalid MCP resource cursor");
        }
        if (!Array.isArray(cursor.names) || cursor.names.some((name) => !names.includes(name)))
          throw new Error("MCP resource cursor is no longer valid");
      }
      const server = eligible.find((server) => server.entry.name === cursor.names[0]);
      if (input.server && !server) throw new Error("MCP resource server is not available");
      if (
        index === 2 &&
        (isUiResource({ uri: input.uri }) ||
          server?.catalog.resources.some((resource) => resource.uri === input.uri && isUiResource(resource)))
      )
        throw new Error("MCP App UI resources are not available");
      const method = index === 2 ? "resources/read" : index === 1 ? "resources/templates/list" : "resources/list";
      const raw = server
        ? ((await server.resource(method, { cursor: cursor.cursor, uri: input.uri }, signal)) as Record<
            string,
            unknown
          >)
        : {};
      const field = index === 2 ? "contents" : index === 1 ? "resourceTemplates" : "resources";
      const items = (
        (raw[field] ?? []) as { uri?: string; mimeType?: string; _meta?: unknown; icons?: unknown }[]
      ).filter((item) => !isUiResource(item));
      const next = raw.nextCursor ? { names: cursor.names, cursor: raw.nextCursor } : { names: cursor.names.slice(1) };
      const value = {
        [field]: items.map(({ _meta, icons: _icons, ...item }) =>
          index === 2 ? item : { ...item, server: server!.entry.name },
        ),
        ...(index !== 2 && next.names.length
          ? { nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url") }
          : {}),
      };
      const result = await convertResult(
        server?.entry.name ?? "",
        name,
        index === 2
          ? { content: items.map((resource) => ({ type: "resource", resource }) as ContentBlock) }
          : { content: [{ type: "text", text: JSON.stringify(value) }] },
      );
      return { ...result, structuredContent: value as JsonValue };
    },
  }));
}
