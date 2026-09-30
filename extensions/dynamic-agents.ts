import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DYNAMIC_AGENTS_STATE, globalPaths, loadGlobal, loadPolicy, projectInstructions, projectMessages, replaceGlobal,
  type AgentFile, type ModelIdentity, type Policy } from "../src/dynamic-agents.ts";

type Options = { contextFiles: AgentFile[]; forceSystemPrompt?: string };
type Snapshot = { model: string; policy: Policy; replacement?: AgentFile };
const identity = (model?: ModelIdentity) => model ? JSON.stringify([model.provider, model.id]) : "";

export default function dynamicAgents(pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), "dynamic-agents.json");
  let sources = new Set(globalPaths(getAgentDir()));
  let snapshot: Snapshot | undefined;
  let lastNoticeKey = "";
  let dirty = true;
  let preparing = false;
  let nativeGlobal: AgentFile | undefined;
  let globalError: string | undefined;
  let lastOptions: Options | undefined;
  let managed = existsSync(configPath);

  const prepare = (options: Options, ctx: ExtensionContext) => {
    if (!managed && !existsSync(configPath)) return;
    // Read globals once for this run; tool steps keep the same file snapshot.
    if (lastOptions !== options) {
      const global = loadGlobal(getAgentDir());
      nativeGlobal = global.file;
      globalError = global.error;
      lastOptions = options;
      dirty = true;
    }
    if (dirty || snapshot?.model !== identity(ctx.model)) {
      const policy = loadPolicy(configPath, ctx.model);
      if (policy.file && options.contextFiles.some(file => file.path === policy.file!.path && !sources.has(file.path))) {
        policy.error = "Policy file is already loaded as project instructions";
        delete policy.file; delete policy.group;
      }
      if (!policy.file && globalError) policy.error = [policy.error, globalError].filter(Boolean).join("; ");
      managed = existsSync(configPath) || sources.size > globalPaths(getAgentDir()).length;
      snapshot = { model: identity(ctx.model), policy, replacement: policy.file ?? nativeGlobal };
      if (policy.file) sources.add(policy.file.path);
      dirty = false;
    }
    options.contextFiles = replaceGlobal(options.contextFiles, sources, snapshot!.replacement);
    if (options.forceSystemPrompt) options.forceSystemPrompt = projectInstructions(options.forceSystemPrompt, sources, snapshot!.replacement);
    preparing = true;
  };

  const restore = (ctx: ExtensionContext) => {
    sources = new Set(globalPaths(getAgentDir()));
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== DYNAMIC_AGENTS_STATE) continue;
      const data = entry.data as { sources?: unknown };
      if (Array.isArray(data?.sources)) for (const path of data.sources) if (typeof path === "string") sources.add(path);
    }
    snapshot = undefined; lastOptions = undefined; dirty = true; preparing = false;
    managed = existsSync(configPath) || sources.size > globalPaths(getAgentDir()).length;
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("before_agent_start", (event, ctx) => { prepare(event.systemPromptOptions, ctx); });
  pi.on("agent_start", (_event, ctx) => {
    preparing = false;
    if (!snapshot || !managed) return;
    const { policy } = snapshot;
    const notice = policy.error ? `Dynamic agents: ${policy.error}; using native global instructions.`
      : `Dynamic agents: ${policy.group ?? "native global"}${policy.file ? ` (${policy.file.path})` : ""}`;
    const noticeKey = JSON.stringify([policy.group, policy.error, snapshot.replacement]);
    const paths = [...sources];
    const previous = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === DYNAMIC_AGENTS_STATE).at(-1);
    if (JSON.stringify(previous?.type === "custom" ? previous.data : undefined) !== JSON.stringify({ sources: paths })) pi.appendEntry(DYNAMIC_AGENTS_STATE, { sources: paths });
    if (noticeKey !== lastNoticeKey && (policy.error || policy.notify)) ctx.ui.notify(notice, policy.error ? "warning" : "info");
    lastNoticeKey = noticeKey;
  });
  pi.on("context_with_system", event => snapshot
    ? { messages: projectMessages(event.messages, sources, snapshot.replacement) } : undefined);

  pi.registerCommand("dynamic-agents", {
    description: "Show active global policy; reload schedules a refresh for the next agent run",
    handler: async (args, ctx) => {
      if (args.trim() === "reload") { dirty = true; ctx.ui.notify("Dynamic agents: reload scheduled for the next agent run.", "info"); return; }
      const policy = snapshot?.policy;
      ctx.ui.notify(`Dynamic agents: ${policy?.group ?? "native global"}\nSelected model: ${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}\nActive model: ${snapshot?.model ?? "none"}\nConfig: ${configPath}\nFile: ${policy?.file?.path ?? nativeGlobal?.path ?? "none"}${policy?.error ? `\nFallback: ${policy.error}` : ""}\n${preparing || dirty || snapshot?.model !== identity(ctx.model) ? "Pending next agent run" : "Active"}`, "info");
    },
  });
}
