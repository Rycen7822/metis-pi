import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { stringify } from "smol-toml";
import registerCondense from "../../extensions/condense.ts";
import { encodePruneConfig } from "../../src/condense/config.ts";

export const usage = {
  input: 12,
  output: 8,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export async function fixture(
  t,
  {
    reply = "[[1:bash]] Finished; evidence retained.",
    summaryUsage = usage,
    stopReason = "stop",
    defer = false,
    occ = false,
    capacity = false,
    pruneOn = "agent-message",
    showPruneStatusLine = false,
    mode = "print",
    chainCompression = { enabled: false },
    sessionFile,
    ...configOverrides
  } = {},
) {
  const workDir = fileURLToPath(new URL("../../.work/", import.meta.url));
  mkdirSync(workDir, { recursive: true });
  const dir = mkdtempSync(join(workDir, "condense-pipeline-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: capacity, reserveTokens: 500 } }));
  writeFileSync(join(dir, "metis-pi.toml"), stringify({ contextPrune: encodePruneConfig({
    enabled: true, opportunisticCompaction: occ, showPruneStatusLine, minBatchChars: 5000, pruneOn, batchingMode: "agent-message",
    autoBudgetThreshold: 0.7, budgetTurnDelta: 0.2, frontierGapThresholdTokens: 1, summarizerModel: "local/cheap-summary",
    // Persistence/render tests opt out of scheduling thresholds; default-policy cases pass DEFAULT_CONFIG explicitly.
    chainCompression: { minWorkTurns: 0, minRecentTokens: 0, minGainTokens: 1, minGainFraction: 0, ...chainCompression },
    purgeErrors: { enabled: false }, ...configOverrides,
  }) }));
  // Spill files use the session directory; inMemory() leaves it empty.
  const sm = sessionFile ? SessionManager.open(sessionFile, dir) : SessionManager.create(dir, dir);
  const hooks = new Map(), tools = new Map(), calls = [], commands = new Map(), requests = [], events = createEventBus();
  const pendingFinishes = new Set();
  const api = "condense-local-proof";
  const model = { id: "summary", name: "summary", api, provider: "local", baseUrl: "http://invalid", reasoning: false,
    input: ["text"], contextWindow: 100000, maxTokens: 10000, cost: { input: 1, output: 0, cacheRead: 1, cacheWrite: 0 } };
  const summaryModel = { ...model, id: "cheap-summary", cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0 } };
  const releases = [], summaryStarted = new EventTarget();
  const stream = (_model, context, options) => {
    calls.push(context);
    requests.push(options);
    const callNumber = calls.length;
    const output = createAssistantMessageEventStream();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const reason = options.signal?.aborted
        ? "aborted"
        : typeof stopReason === "function"
          ? stopReason(callNumber, context)
          : stopReason;
      const message = {
        role: "assistant",
        api,
        provider: _model.provider,
        model: _model.id,
        content: [{ type: "text", text: typeof reply === "function" ? reply(callNumber) : reply }],
        stopReason: reason,
        errorMessage: reason === "error" ? "Offline summary provider failed" : undefined,
        timestamp: 1,
        usage: summaryUsage,
      };
      output.push({ type: reason === "error" ? "error" : "done", reason, message, error: message });
      output.end(message);
    };
    options.signal?.addEventListener("abort", finish, { once: true });
    releases.push(finish);
    if (!defer) queueMicrotask(finish);
    summaryStarted.dispatchEvent(new Event("request"));
    return output;
  };
  const pi = {
    events,
    getSettings: () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")),
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.keys()],
    on(name, fn) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerMessageRenderer() {},
    appendEntry(type, data) {
      sm.appendCustomEntry(type, data);
    },
    sendMessage(message) {
      sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  };
  const notices = [],
    statuses = new Map(),
    widgets = [];
  const ctx = {
    sessionManager: sm,
    model,
    cwd: dir,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    isIdle: () => true,
    hasPendingMessages: () => false,
    getSystemPrompt: () => "Condense test system prompt",
    getContextUsage: () => ({ tokens: capacity ? 96000 : 90000, contextWindow: 100000 }),
    modelRegistry: {
      find: () => summaryModel,
      getAvailable: () => [model, summaryModel],
      getAll: () => [model, summaryModel],
      streamSimple: stream,
    },
    ui: {
      setStatus: (id, value) => statuses.set(id, value),
      setWidget: (id, value) => widgets.push([id, value]),
      notify: (message, type) => notices.push([message, type]),
    },
  };
  const emit = async (name, event = {}) => {
    let result;
    for (const fn of hooks.get(name) ?? []) result = (await fn(event, ctx)) ?? result;
    return result;
  };
  registerCondense(pi);
  await emit("session_start");
  let clock = sessionFile
    ? Math.max(10, ...sm.buildSessionProjection().messages.map(message => message.timestamp || 0)) + 1 : 10;
  function add(body, command = "npm run build", id = `call-${clock}`, thinking) {
    const assistant = {
      role: "assistant", api, provider: model.provider, model: model.id,
      content: [
        ...(thinking ? [{ type: "thinking", thinking }] : []),
        { type: "toolCall", id, name: "bash", arguments: { command } },
      ],
      timestamp: clock++,
      stopReason: "toolUse",
    };
    const result = {
      role: "toolResult",
      toolCallId: id,
      toolName: "bash",
      content: [{ type: "text", text: body }],
      isError: false,
      timestamp: clock++,
    };
    sm.appendMessage(assistant);
    sm.appendMessage(result);
    return { assistant, result, id };
  }
  async function waitMaintenance() {
    for (;;) {
      const status = {};
      events.emit("metis:condense-maintenance", status);
      if (!status.pending) return;
      await status.pending;
    }
  }
  function finish(settle = true, responseUsage) {
    const pending = (async () => {
      const message = { role: "assistant", api, provider: model.provider, model: model.id, usage: responseUsage,
        content: [{ type: "text", text: "Final reply" }], stopReason: "stop", timestamp: clock++ };
      await emit("message_end", { message }); sm.appendMessage(message);
      if (settle) { await emit("turn_end", { message, toolResults: [], turnIndex: 0 }); await waitMaintenance(); }
      return message;
    })();
    pendingFinishes.add(pending);
    pending.then(() => pendingFinishes.delete(pending), () => pendingFinishes.delete(pending));
    return pending;
  }
  t.after(async () => {
    await emit("session_shutdown");
    await Promise.allSettled(pendingFinishes);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  if (!sessionFile) sm.appendMessage({ role: "user", content: "Build", timestamp: 1 });
  return { dir, sm, tools, calls, commands, requests, events, ctx, pi, emit, add, finish, notices, statuses, widgets, summaryStarted,
    waitMaintenance, nextTimestamp: () => clock++,
    release: (index = releases.length - 1) => releases[index]?.(), releaseAll: () => releases.forEach(finish => finish()) };
}
