/**
 * Managed-child built-in tool surface for a daemon-booted Pi worker.
 *
 * A managed child loads Pi's OWN configuration (global/project extensions,
 * packages, skills, prompts, settings) exactly like a normal `pi` session, so
 * the daemon never passes `--tools` (a strict allowlist over built-in, extension
 * and custom tools) and never passes `--exclude-tools` (the same registry
 * filtered BY NAME): either flag would also remove a tool an extension
 * registered under a built-in's name. The profile's built-in surface is applied
 * here instead, where Pi reports the real source of every tool:
 * `sourceInfo.path === "builtin:NAME"` for Pi's own tools, the extension file
 * for everything else. Only real built-ins follow the profile; every
 * extension/custom tool — including one that shadows a built-in name — keeps
 * exactly the state Pi gave it.
 *
 * Input: PI_AGENTS_CHILD_BUILTINS = comma-separated built-in names the profile
 * allows (empty string means "no built-in tools at all"). Unset means "no plan":
 * the surface is left as Pi computed it. The variable is deleted before any
 * child of this process can see it.
 *
 * Evidence: one `subagent-pi-surface applied ok=... allowed=... builtins=...
 * expected=... unidentified=...` line on stderr, where `builtins` and `ok` are
 * read back from Pi's live registry after the change. The daemon requires that
 * line for every profile that restricts the built-in surface and fails the
 * launch when it is missing or not ok, so a built-in restriction is never
 * claimed without evidence.
 *
 * No runtime dependency beyond Pi's own extension API. No files, no network.
 */
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

/** Pi's marker for a tool it implements itself (dist/core/tools). */
const BUILTIN_SOURCE_PREFIX = "builtin:";

function sourcePath(tool: ToolInfo): string | undefined {
  const path = (tool.sourceInfo as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : undefined;
}

/** Built-in identity is Pi's, never the tool NAME: an extension may shadow a
 * built-in name, and such a tool is Pi's own business, not the profile's. */
function isBuiltin(tool: ToolInfo): boolean {
  const path = sourcePath(tool);
  return path === `${BUILTIN_SOURCE_PREFIX}${tool.name}`;
}

export default async function (pi: ExtensionAPI) {
  const native = process.env.PI_AGENTS_HOST === "pi";
  const access = process.env.PI_AGENTS_CHILD_ACCESS;
  delete process.env.PI_AGENTS_CHILD_ACCESS;
  const raw = process.env.PI_AGENTS_CHILD_BUILTINS;
  delete process.env.PI_AGENTS_CHILD_BUILTINS;
  if (raw === undefined) {
    process.stderr.write("subagent-pi-surface no-plan (surface left to Pi)\n");
    return;
  }
  const allowed = [...new Set(raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0))].sort();
  const allowedSet = new Set(allowed);
  const ordinaryBuiltins = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
  const managedBuiltin = (tool: ToolInfo) => isBuiltin(tool) && (!native || ordinaryBuiltins.has(tool.name));
  if (native) pi.on("tool_call", (event) => {
    const tool = pi.getAllTools().find(tool => tool.name === event.toolName);
    const path = tool && sourcePath(tool);
    const recursive = ["pi_spawn_agent", "pi_followup_task", "pi_send_message"].some(name => event.toolName === name || event.toolName.endsWith(`__${name}`)) ||
      ["Agent", "SubagentWorkflow", "subagent", "spawn_agent", "followup_task"].includes(event.toolName) ||
      Boolean(path?.split(/[\\/]/).includes("pi-subagents"));
    if (recursive) return { block: true, reason: "Managed children cannot create or control subagents" };
    if (access !== "read") return;
    const safeBuiltin = tool && isBuiltin(tool) && ["read", "grep", "find", "ls", "codemode", "tool_search"].includes(tool.name);
    const fffSearch = path && /[\\/]@ff-labs[\\/]pi-fff[\\/]src[\\/]index\.(?:ts|js)$/.test(path) &&
      ["ffgrep", "fffind", "fff-multi-grep", "grep", "find", "multi_grep"].includes(event.toolName);
    const managedQuestion = event.toolName === "ask_parent" && path === "<inline:subagent-pi>";
    const metisImage = event.toolName === "view_image" && Boolean(path?.includes("metis-pi") && path.endsWith("/extensions/execution.ts"));
    const readonlyMcp = tool?.namespace?.name.startsWith("mcp_") && tool.annotations?.readOnlyHint === true;
    if (!safeBuiltin && !fffSearch && !managedQuestion && !metisImage && !readonlyMcp) return { block: true,
      reason: event.toolName === "mcp" ? "Read-only subagent: generic MCP gateway can invoke writes; use an individual MCP tool marked read-only" :
        "Read-only subagent: tool has no approved read capability" };
  });

  const apply = () => {
    const tools = pi.getAllTools();
    const builtinNames = new Set(tools.filter(managedBuiltin).map((tool) => tool.name));
    const unidentified = tools.filter((tool) => sourcePath(tool) === undefined).map((tool) => tool.name).sort();
    const expected = [...builtinNames].filter((name) => allowedSet.has(name)).sort();
    // Extension/custom tools keep Pi's decision — this includes tools that
    // shadow a built-in name, which are NOT built-ins here.
    const kept = pi.getActiveTools().filter((name) => !builtinNames.has(name));
    const target = [...kept, ...expected].filter((name, index, all) => all.indexOf(name) === index);
    let failure = "";
    try {
      pi.setActiveTools(target);
    } catch (exc) {
      failure = String(exc).slice(0, 120);
    }
    const applied = failure ? [] : pi.getActiveTools().filter((name) => builtinNames.has(name)).sort();
    const ok = failure === "" && applied.join(",") === expected.join(",");
    process.stderr.write(
      `subagent-pi-surface applied ok=${ok ? "true" : "false"} allowed=${allowed.join(",")}` +
      ` builtins=${applied.join(",")} expected=${expected.join(",")} unidentified=${unidentified.join(",")}` +
      (failure ? ` error=${failure.replace(/\s+/g, " ")}` : "") + "\n");
  };

  // session_start fires once Pi resolved extensions/skills for this session and
  // also on reload, where the plan is simply re-applied (synchronously: Pi does
  // not run extension timers in every mode).
  pi.on("session_start", apply);
}
