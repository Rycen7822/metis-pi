import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadRuntime } from "./adapters.ts";
import { commandExists, commandPathValue } from "./command.ts";
import { resolveRoot } from "./files.ts";
import { selectDiagnosticRoutes, selectFixRoute } from "./routes.ts";
import { clearStatus, DEFAULT_FILE_LIMIT, runDiagnostics, runFix, textResult } from "./runner.ts";
import { LspSessionScope } from "./session-lifecycle.ts";

const STATUS_KEY = "lsp";
const lspTool = defineTool({
  name: "lsp",
  label: "LSP",
  description: "Use configured LSP servers: diagnostics checks files; fix applies source fixes or organizes imports (preview unless write=true).",
  promptSnippet: "Get LSP diagnostics or preview/apply source actions",
  promptGuidelines: [
    "Use lsp action=diagnostics for configured-server diagnostics, or action=fix for supported source actions; set kind for actions such as source.organizeImports.",
    "Set server only for a user-requested server or ambiguous routing. Diagnostics accepts multiple servers; fix accepts one.",
    "If a configured command is missing, report it and suggest installing it or updating metis-pi.toml [lsp].",
  ],
  parameters: Type.Object({
    action: StringEnum(["diagnostics", "fix"] as const),
    paths: Type.Optional(Type.Array(Type.String(), { description: "Diagnostics: files/directories; defaults to root." })),
    root: Type.Optional(Type.String({ description: "Workspace root; defaults to cwd." })),
    limit: Type.Optional(Type.Number({ description: "Diagnostics: maximum files per server." })),
    server: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "Configured server(s); fix accepts one. Defaults to extension routing.",
    })),
    path: Type.Optional(Type.String({ description: "Fix: required file path." })),
    write: Type.Optional(Type.Boolean({ description: "Fix: write changes; default false (preview)." })),
    kind: Type.Optional(Type.String({ description: "Fix: source action; default source.fixAll." })),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    if (params.action !== "diagnostics" && params.action !== "fix") {
      throw new Error("lsp action must be diagnostics or fix");
    }
    if (params.action === "fix") {
      if (typeof params.path !== "string") throw new Error("lsp action=fix requires path");
      if (params.server !== undefined && typeof params.server !== "string") {
        throw new Error("lsp action=fix accepts one server name, not an array");
      }
    }
    const requestedRoot = resolveRoot(params.root ?? ctx.cwd);
    const { adapters, timeoutMs } = loadRuntime();
    if (params.action === "fix") {
      const { root, adapter } = selectFixRoute(adapters, { root: requestedRoot, path: params.path!, server: params.server as string | undefined });
      return runFix(adapter, { root, path: params.path!, kind: params.kind, write: params.write }, timeoutMs, signal, ctx, STATUS_KEY);
    }
    const { root, routes, skipped } = selectDiagnosticRoutes(adapters, { ...params, root: requestedRoot }, DEFAULT_FILE_LIMIT);
    const results = [];
    for (const route of routes) {
      signal?.throwIfAborted();
      const result = await runDiagnostics(route.adapter, { root, paths: params.paths, limit: params.limit, files: route.files }, timeoutMs, signal, ctx, STATUS_KEY);
      signal?.throwIfAborted();
      results.push({ route, result });
    }
    const sections = results.map(({ route, result }) => `${route.reason}\n\n${textFromResult(result)}`);
    if (skipped.length) sections.push(`Skipped unavailable default LSP server(s): ${skipped.map(route => route.adapter.name).join(", ")}.`);
    return textResult(sections.join("\n\n---\n\n"), {
      root,
      skipped: skipped.map(route => ({ server: route.adapter.name, reason: route.reason, files: route.files })),
      routes: results.map(({ route, result }) => ({ server: route.adapter.name, backend: route.adapter.name, reason: route.reason, files: route.files, details: result.details })),
    });
  },
});

export default function lsp(pi: ExtensionAPI) {
  const sessions = new WeakMap<object, { scope: LspSessionScope; generation: number }>();
  const sessionFor = (key: object) => {
    let session = sessions.get(key);
    if (!session) {
      session = { scope: new LspSessionScope(), generation: 0 };
      sessions.set(key, session);
    }
    return session;
  };

  pi.registerTool({
    ...lspTool,
    execute(id, params, signal, onUpdate, ctx) {
      const { scope } = sessionFor(ctx.sessionManager);
      return scope.run(signal, ownedSignal => lspTool.execute(id, params, ownedSignal, onUpdate, scope.context(ctx)));
    },
  });
  pi.registerCommand("lsp", {
    description: "Show LSP commands configured in metis-pi.toml [lsp]",
    handler: async (_args, ctx) => {
      try {
        const { adapters } = loadRuntime();
        ctx.ui.notify(buildStatusMessage(adapters, ctx.cwd), statusLevel(adapters, ctx.cwd));
      } catch (error) {
        ctx.ui.notify(`LSP config invalid: ${formatError(error)}`, "warning");
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    const session = sessionFor(ctx.sessionManager);
    const generation = ++session.generation;
    await session.scope.close();
    if (generation !== session.generation) return;
    session.scope = new LspSessionScope();
    clearStatus(ctx, STATUS_KEY);
    try { loadRuntime(); }
    catch (error) { ctx.ui.notify(`LSP config invalid: ${formatError(error)}`, "warning"); }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const session = sessionFor(ctx.sessionManager);
    session.generation++;
    const drained = session.scope.close();
    clearStatus(ctx, STATUS_KEY);
    await drained;
  });
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function textFromResult(result: { content?: Array<{ type?: string; text?: string }> }) {
  return result.content?.find(item => item.type === "text")?.text ?? "";
}
function buildStatusMessage(adapters: ReturnType<typeof loadRuntime>["adapters"], cwd: string) {
  return adapters.flatMap(adapter => {
    const command = adapter.defaultCommand;
    return [`${adapter.name} LSP command: ${command.command} ${command.args.join(" ")}`.trim(),
      `${adapter.name} status: ${commandExists(command.command, cwd, commandPathValue(adapter.env)) ? "ready" : "command missing"}`];
  }).join("\n");
}
function statusLevel(adapters: ReturnType<typeof loadRuntime>["adapters"], cwd: string) {
  return adapters.every(adapter => commandExists(adapter.defaultCommand.command, cwd, commandPathValue(adapter.env))) ? "info" : "warning";
}
