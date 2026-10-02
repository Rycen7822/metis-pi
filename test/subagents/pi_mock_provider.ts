/** Offline provider for real SDK/MCP tests. All network requests fail. */
import { existsSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";

const env = process.env;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const textOf = (content) => typeof content === "string" ? content
  : (content || []).filter(part => part.type === "text").map(part => part.text).join(" ");
const mark = (text: string) => process.stderr.write(text + "\n");

export default function (pi) {
  globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
  if (env.PI_MOCK_STDOUT) {
    console.log("MOCK_EXTENSION_LOG");
    pi.on("agent_end", () => process.stdout.write("\x1b]777;notify;pi;MOCK_NOTIFY\x07"));
  }
  if (env.PI_MOCK_STARTUP_COMMANDS) {
    let captured = false, nested = false;
    pi.registerCommand("mock-capture", { handler: async (args, ctx) => {
      await sleep(30);
      if (args !== "capture args" || !ctx.sessionManager.getSessionId() || typeof ctx.navigateTree !== "function")
        throw new Error("Invalid startup command context");
      captured = true;
      mark("MOCK_COMMAND_CAPTURED");
      pi.sendUserMessage("/mock-nested", { expandPromptTemplates: true });
    } });
    pi.registerCommand("mock-nested", { handler: async () => { nested = true; mark("MOCK_COMMAND_NESTED"); } });
    pi.on("session_start", () => {
      pi.sendUserMessage("/mock-capture capture args", { expandPromptTemplates: true });
      if (env.PI_MOCK_STARTUP_COMMANDS === "reject") {
        pi.sendUserMessage("UNOWNED_STARTUP_INPUT");
        pi.sendUserMessage("/unknown-command", { expandPromptTemplates: true });
        pi.sendUserMessage("/mock-nested", { expandPromptTemplates: false });
      }
    });
    pi.on("before_agent_start", () => {
      if (!captured || !nested) throw new Error("Startup commands were not drained before the task");
    });
  }
  if (env.PI_MOCK_FORCE_PROMPT) pi.on("before_agent_start", () => ({ systemPrompt: env.PI_MOCK_FORCE_PROMPT }));
  if (env.PI_MOCK_TOOL_MS) pi.registerTool({
    name: "mock_block", label: "Offline wait", description: "Silent test-only blocking tool",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, onUpdate, ctx) {
      mark("PI_MOCK_TOOL_START");
      if (env.PI_MOCK_QUEUE_FLOOD) {
        while (!existsSync(env.PI_MOCK_TOOL_RELEASE!)) await sleep(10);
        for (let i = 0; i < 300; i++) pi.sendUserMessage(`QUEUED_${i}`);
      }
      if (env.PI_MOCK_TOOL_RELEASE) {
        while (!existsSync(env.PI_MOCK_TOOL_RELEASE)) await sleep(10);
        const before = { rss: process.memoryUsage().rss, bytes: process.stdout.writableLength };
        for (let i = 0; i < 2048; i++) {
          const text = "x".repeat(16384);
          if (env.PI_MOCK_TOOL_CRITICAL) ctx.ui.notify(text, "info");
          else onUpdate({ content: [{ type: "text", text }], details: { i } });
          await sleep(1);
        }
        writeFileSync(env.PI_MOCK_TOOL_REPORT!, JSON.stringify({ before,
          after: { rss: process.memoryUsage().rss, bytes: process.stdout.writableLength } }));
        if (!env.PI_MOCK_TOOL_CRITICAL) await ctx.ui.confirm("After progress", "Continue?");
      }
      await sleep(Number(env.PI_MOCK_TOOL_MS));
      mark("PI_MOCK_TOOL_END");
      return { content: [{ type: "text", text: "finished" }], details: {} };
    },
  });
  let calls = 0;
  pi.registerProvider("pi-mock-offline", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline-test-only", api: "openai-responses",
    models: [{ id: "mock", name: "Offline Mock", reasoning: Boolean(env.PI_MOCK_THINKING),
      ...(env.PI_MOCK_THINKING ? { thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } } : {}), input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const call = ++calls;
      mark(`PI_MOCK_REPLY ${call}`);
      const texts = context.messages.map(entry => textOf(entry.content)).filter(Boolean);
      if (env.PI_MOCK_WIRE === "1") {
        mark(`PI_MOCK_WIRE ${call} ${JSON.stringify({ texts,
          forced: context.systemPrompt || getCurrentSystemPrompt(context.messages) })}`);
      }
      if (env.PI_MOCK_CONTEXT === "1") mark(`PI_MOCK_CONTEXT ${call} ${texts.join(" | ")}`);
      const message = { role: "assistant", content: [{ type: "text", text: `MOCK_REPLY_${call}` }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (env.PI_MOCK_ASK_PARENT && call === 1) {
        message.content = [{ type: "toolCall", id: "ask-parent-1", name: "ask_parent", arguments: { question: "Which branch should I use?" } }] as any;
        message.stopReason = "toolUse";
      }
      if (env.PI_MOCK_TOOL_MS && call === 1) {
        message.content = [{ type: "toolCall", id: "block-1", name: "mock_block", arguments: {} }] as any;
        message.stopReason = "toolUse";
      }
      if (env.PI_MOCK_FAIL) { message.stopReason = "error"; (message as any).errorMessage = "Mock provider failed"; }
      let ended = false, timer;
      const finish = () => {
        if (ended) return;
        ended = true; clearTimeout(timer);
        stream.push({ type: ["error", "aborted"].includes(message.stopReason) ? "error" : "done", reason: message.stopReason, message, error: message } as any);
        stream.end();
      };
      if (env.PI_MOCK_ABORT_SIGNAL) options?.signal?.addEventListener("abort", () => {
        message.stopReason = "aborted"; finish();
      }, { once: true });
      if (env.PI_MOCK_PROGRESS) void (async () => {
        const kind = env.PI_MOCK_PROGRESS;
        const partial = { ...message, content: [{ type: kind, [kind]: "" }] };
        stream.push({ type: "start", partial } as any);
        for (let elapsed = 0; elapsed < Number(env.PI_MOCK_STREAM_MS); elapsed += 100) {
          partial.content[0][kind] += "x";
          stream.push({ type: `${kind}_delta`, contentIndex: 0, delta: "x", partial } as any);
          await sleep(100);
        }
        finish();
      })();
      else timer = setTimeout(finish, Number(env.PI_MOCK_SLOW_FIRST && call > 1 ? 30 : env.PI_MOCK_STREAM_MS || 30));
      return stream;
    },
  });

  let continued = false;
  pi.on("agent_before_settle", async event => {
    mark("PI_MOCK_BEFORE_SETTLE");
    if (env.PI_MOCK_SETTLE_MS) await sleep(Number(env.PI_MOCK_SETTLE_MS));
    if (env.PI_MOCK_CONTINUE === "1" && !continued) {
      continued = true;
      return { entries: [...event.entries, { type: "custom_message", customType: "mock-continuation",
        content: "Continue once for the lifecycle test.", display: false }], continue: true };
    }
  });

  const [first, sibling, nested] = [env.PI_MOCK_SETTLED_SEND, env.PI_MOCK_SETTLED_SIBLING, env.PI_MOCK_SETTLED_NESTED];
  const sent = new Set<string>();
  const entered = new Set<string>();
  if (first) {
    pi.on("agent_settled", () => {
      for (const value of [first, sibling, entered.has(first) ? nested : undefined]) {
        if (value && !sent.has(value)) { sent.add(value); pi.sendUserMessage(value); }
      }
    });
    pi.on("input", async event => {
      if (![first, sibling, nested].includes(event.text)) return;
      entered.add(event.text);
      mark(`PI_MOCK_SETTLED_INPUT_TEXT ${event.text}`);
      if (env.PI_MOCK_SETTLED_INPUT_MS) await sleep(Number(env.PI_MOCK_SETTLED_INPUT_MS));
      mark(`PI_MOCK_SETTLED_INPUT_MODE ${env.PI_MOCK_SETTLED_INPUT || "continue"}`);
      return { action: env.PI_MOCK_SETTLED_INPUT === "handled" ? "handled" : "continue" };
    });
  }

  let blockIndex = 0;
  const tokens = (env.PI_MOCK_BLOCK_INPUT || "").split(",").filter(Boolean);
  pi.on("input", async (event, ctx) => {
    if (env.PI_MOCK_CONFIRM && event.text.includes("ASK")) {
      mark("PI_MOCK_CONFIRM_WAIT");
      const answer = await ctx.ui.confirm("Permission", "Proceed with mock work?",
        env.PI_MOCK_CONFIRM_TIMEOUT ? { timeout: Number(env.PI_MOCK_CONFIRM_TIMEOUT) } : undefined);
      mark(`PI_MOCK_CONFIRM_ANSWER ${answer}`);
      if (env.PI_MOCK_AFTER_CONFIRM_MS) await sleep(Number(env.PI_MOCK_AFTER_CONFIRM_MS));
      if (!answer) return { action: "handled" };
    }
    if (!tokens.some(token => event.text.includes(token))) return;
    const index = ++blockIndex;
    mark(`PI_MOCK_INPUT_BLOCKED_START ${index} ${event.text}`);
    const deadline = Date.now() + Number(env.PI_MOCK_BLOCK_MS || 0);
    while (Date.now() < deadline) {
      if (env.PI_MOCK_RELEASE_FILE && existsSync(env.PI_MOCK_RELEASE_FILE)) break;
      if (env.PI_MOCK_BLOCK_RELEASE_DIR && existsSync(`${env.PI_MOCK_BLOCK_RELEASE_DIR}/${index}`)) break;
      await sleep(20);
    }
    mark(`PI_MOCK_INPUT_BLOCKED_END ${index}`);
    return { action: env.PI_MOCK_BLOCK_RESULT === "handled" ? "handled" : "continue" };
  });

  let started = false;
  pi.on("agent_start", (_event, ctx) => {
    if (started) return;
    started = true;
    if (env.PI_MOCK_NEXTTURN && !existsSync(env.PI_MOCK_NEXTTURN_ONCE_FILE || "")) {
      if (env.PI_MOCK_NEXTTURN_ONCE_FILE) writeFileSync(env.PI_MOCK_NEXTTURN_ONCE_FILE, "queued");
      pi.sendMessage({ customType: "cancel-next", content: env.PI_MOCK_NEXTTURN, display: false }, { deliverAs: "nextTurn" });
      mark("PI_MOCK_NEXTTURN_QUEUED");
    }
    for (const text of (env.PI_MOCK_EXT_FOLLOWUP || "").split(",").filter(Boolean)) {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
    if (env.PI_MOCK_LATE_RELEASE) void (async () => {
      while (!existsSync(env.PI_MOCK_LATE_RELEASE)) await sleep(20);
      pi.sendUserMessage("STALE_TIMER_INPUT");
      mark("PI_MOCK_LATE_ATTEMPTED");
    })();
    if (env.PI_MOCK_LATE_UI_RELEASE) void (async () => {
      while (!existsSync(env.PI_MOCK_LATE_UI_RELEASE)) await sleep(20);
      pi.sendMessage({ customType: "stale", content: "STALE_CUSTOM", display: false }, { triggerTurn: false });
      await ctx.ui.confirm("STALE_OLD_TASK", "Proceed?");
      mark("PI_MOCK_LATE_UI_FINISHED");
    })();
  });
}
