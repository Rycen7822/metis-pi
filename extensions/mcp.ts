import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mcpEnabled, mcpNamespace, readMcpConfiguration, type McpConfiguration } from "../src/mcp/config.ts";
import type { McpServerSession } from "../src/mcp/session.ts";

export default function mcp(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  try {
    if (!mcpEnabled(agentDir)) return;
  } catch {
    pi.on("session_start", (_event, ctx) =>
      ctx.ui.notify("Metis MCP disabled: invalid global metis configuration", "warning"),
    );
    return;
  }
  const owned = new Map<string, ToolDefinition>();
  let servers = new Map<string, McpServerSession>();
  let ready = new Map<string, Promise<void>>();
  let current: ExtensionContext;
  let generation = 0,
    trusted = false;
  let config: McpConfiguration | undefined;
  const warnings = new Set<string>();
  let runtime: Awaited<ReturnType<typeof load>>;
  async function load() {
    const [session, catalog, tools] = await Promise.all([
      import("../src/mcp/session.ts"),
      import("../src/mcp/catalog.ts"),
      import("../src/mcp/tools.ts"),
    ]);
    return { ...session, ...catalog, ...tools };
  }
  function sync() {
    if (!runtime) return;
    runtime.syncTools(pi, servers.values(), owned);
    const exposures = config?.policy.enabled
      ? config.servers
          .filter((entry) => entry.config.enabled !== false)
          .flatMap((entry) => [entry.config.exposure ?? "codemode", ...Object.values(entry.config.toolExposure ?? {})])
      : [];
    const all = pi.getAllTools(),
      active = pi.getActiveTools();
    const activate = (name: string) => {
      if (active.includes(name)) return;
      if (all.some((tool) => tool.name === name && tool.reachesTools)) active.push(name);
      else if (!warnings.has(name)) {
        warnings.add(name);
        current.ui.notify(
          `Metis MCP needs ${name}. Enable its built-in extension with pi config, then reload.`,
          "warning",
        );
      }
    };
    if (config?.autoEnableCodemode && exposures.includes("codemode")) activate("codemode");
    if (exposures.includes("deferred")) activate("tool_search");
    pi.setActiveTools(active);
  }
  async function reset(ctx: ExtensionContext) {
    const epoch = ++generation;
    current = ctx;
    trusted = ctx.isProjectTrusted();
    warnings.clear();
    const old = [...servers.values()];
    servers = new Map();
    ready = new Map();
    sync();
    await Promise.allSettled(old.map((server) => server.shutdown()));
    runtime ??= await load();
    if (epoch !== generation) return;
    config = readMcpConfiguration(agentDir, ctx.cwd, trusted, pi.getMcpServers());
    if (config.errors.length) ctx.ui.notify(config.errors.join("\n"), "warning");
    if (!config.policy.enabled) {
      sync();
      return;
    }
    const cache = new runtime.CatalogCache(agentDir);
    for (const entry of config.servers) {
      if (
        entry.config.enabled === false ||
        (entry.config.exposure === "hidden" &&
          !Object.values(entry.config.toolExposure ?? {}).some((exposure) => exposure !== "hidden"))
      )
        continue;
      const server = new runtime.McpServerSession(
        entry,
        ctx.cwd,
        agentDir,
        config.policy,
        cache,
        () => current,
        () => {
          if (generation === epoch && servers.get(entry.name) === server) sync();
        },
      );
      servers.set(entry.name, server);
    }
    sync();
    const pending = [...servers.values()].map(server => {
      const { promise, resolve: done } = Promise.withResolvers<void>();
      ready.set(server.entry.name, promise);
      return { server, done };
    });
    const discover = (async () => {
      const missing: typeof pending = [];
      await Promise.all(pending.map(async task => {
        const restored = await task.server.restore().catch(() => false);
        if (restored || task.server.closed || epoch !== generation) task.done();
        else missing.push(task);
      }));
      let index = 0;
      await Promise.all([0, 1].map(async () => {
        while (index < missing.length && epoch === generation) {
          const task = missing[index++];
          if (!task.server.closed) await task.server.discover(true).catch(() => {});
          task.done();
        }
      }));
      // A reload/shutdown also releases callers waiting for queued servers that never opened.
      for (const task of missing) task.done();
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([discover, new Promise<void>(resolve => { timer = setTimeout(resolve, 3_000); timer.unref(); })]); }
    finally { clearTimeout(timer); }
  }
  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("mcp_servers_change", (_event, ctx) => reset(ctx));
  pi.on("tool_call", async (event, ctx) => {
    const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName);
    const reach = tool?.reachesTools?.(event.input);
    if (!runtime || reach === undefined) return;
    const names = [...servers.keys()];
    const targets = reach === "all" ? names : [...new Set(reach.flatMap(word => {
      const namespace = owned.get(word)?.namespace;
      if (namespace) return names.filter(name => namespace.name === mcpNamespace(name) || namespace.aliases?.includes(name));
      const exact = names.filter(name => word === name || word === mcpNamespace(name));
      if (exact.length) return exact;
      // An unregistered literal tool still names its namespace. Prefer the most specific
      // namespace when server names themselves contain the tool separator.
      return names.filter(name => word.startsWith(`${mcpNamespace(name)}__`))
        .sort((left, right) => mcpNamespace(right).length - mcpNamespace(left).length).slice(0, 1);
    }))];
    await runtime.waitFor(Promise.all(targets.map(name => ready.get(name))), ctx.signal);
    sync();
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    current = ctx;
    if (trusted !== ctx.isProjectTrusted()) await reset(ctx);
    else
      for (const server of servers.values()) {
        if (await server.authorizationChanged()) await server.discover(true).catch(() => {});
      }
  });
  pi.on("session_shutdown", async () => {
    generation++;
    await Promise.allSettled([...servers.values()].map((server) => server.shutdown()));
    servers.clear();
    ready.clear();
  });
  pi.registerCommand("mcp", {
    description: "Metis MCP status; reload config or refresh [server] directory",
    async handler(args, ctx) {
      current = ctx;
      const [action, name] = args.trim().split(/\s+/);
      if (action === "reload") await reset(ctx);
      else if (action === "refresh") {
        const selected = [...servers.values()].filter((server) => !name || server.entry.name === name);
        if (!selected.length) {
          ctx.ui.notify("No matching MCP server", "warning");
          return;
        }
        await Promise.all(selected.map((server) => server.refresh().catch(() => {})));
      } else if (action) {
        ctx.ui.notify("Usage: /mcp [reload | refresh [server]]. Add/login/logout: pi mcp ...", "info");
        return;
      }
      const lines = [...servers.values()].map(
        (server) =>
          `${server.entry.name}` +
          ": " +
          `${server.state}` +
          ", " +
          `${server.catalog.tools.length}` +
          " tools" +
          `${server.cached ? " (cached directory)" : ""}` +
          `${server.error ? `; ${server.error}` : ""}`,
      );
      ctx.ui.notify(
        [
          ...lines,
          ...(config?.errors ?? []),
          ...(!lines.length ? ["No enabled MCP servers. Configure mcp.json; login with pi mcp login <server>."] : []),
        ].join("\n"),
        "info",
      );
    },
  });
}
