// pty-verify.mjs — REAL TUI verification (spec 11.6). Drives the actual `pi`
// binary inside a real tmux PTY against a local mock OpenAI-compatible
// provider: zero paid requests, real screen frames via `tmux capture-pane`.
// Frames asserted per stage: idle footer details, live Working line with dual
// timers, tool run + Worked summary, provider error + Failed summary.
// Requires: pi on PATH (or PI_BIN), tmux. Skips (exit 0) when tmux is absent.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const PI_BIN = process.env.PI_BIN ?? (() => {
  try { return execFileSync("which", ["pi"], { encoding: "utf8" }).trim(); } catch { return undefined; }
})();
const hasTmux = (() => {
  try { execFileSync("tmux", ["-V"], { encoding: "utf8" }); return true; } catch { return false; }
})();

if (!PI_BIN || !hasTmux) {
  console.log(`SKIP: pty-verify needs pi (${PI_BIN ?? "not found"}) and tmux (${hasTmux})`);
  process.exit(0);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-pty-"));
const HOME_DIR = path.join(ROOT, "home");
// pi reads models.json/settings.json from $HOME/.pi/agent (PI_AGENT_DIR does
// NOT relocate them — verified against pi 0.85.1).
const AGENT_DIR = path.join(HOME_DIR, ".pi", "agent");
const WORKSPACE = path.join(ROOT, "workspace");
fs.mkdirSync(AGENT_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
// HOME isolation: the real ~/.pi/agent user extensions (including the
// published copy of THIS extension) must not shadow the code under test.
const ISOLATED_ENV = { ...process.env, HOME: HOME_DIR };

// ---------- mock provider ----------
const requests = [];
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      requests.push(parsed);
      const last = [...(parsed.messages ?? [])].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
      if (/PCX_FAIL/.test(text)) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "PCX forced provider failure" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const usage = {
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        prompt_tokens_details: { cached_tokens: 1000 },
      };
      const base = { id: "chatcmpl-pcx", object: "chat.completion.chunk", created: 1, model: "pcx-mock-model" };
      if (/PCX_TOOL/.test(text)) {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_pcx1", type: "function", function: { name: "bash", arguments: "{\"command\":\"echo PCX_TOOL_MARK\"}" } }] }, finish_reason: null }] });
        setTimeout(() => {
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          send({ ...base, choices: [], usage });
          res.write("data: [DONE]\n\n");
          res.end();
        }, 400);
        return;
      }
      if (/PCX_THINK/.test(text)) {
        // Reasoning phase first (deepseek-style reasoning_content), slow
        // enough for the tick loop to show the growing thinking timer.
        let r = 0;
        const rtimer = setInterval(() => {
          send({ ...base, choices: [{ index: 0, delta: { reasoning_content: "pondering ".slice(r, r + 2) }, finish_reason: null }] });
          r += 2;
          if (r >= 10) {
            clearInterval(rtimer);
            setTimeout(() => finishText("PCX_THINK_DONE"), 300);
          }
        }, 300);
        const finishText = (reply) => {
          let i = 0;
          const timer = setInterval(() => {
            send({ ...base, choices: [{ index: 0, delta: { content: reply.slice(i, i + 2) }, finish_reason: null }] });
            i += 2;
            if (i >= reply.length) {
              clearInterval(timer);
              setTimeout(() => {
                send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                send({ ...base, choices: [], usage });
                res.write("data: [DONE]\n\n");
                res.end();
              }, 200);
            }
          }, 250);
        };
        return;
      }
      const reply = "PCX_OK";
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      let i = 0;
      const timer = setInterval(() => {
        send({ ...base, choices: [{ index: 0, delta: { content: reply.slice(i, i + 2) }, finish_reason: null }] });
        i += 2;
        if (i >= reply.length) {
          clearInterval(timer);
          setTimeout(() => {
            send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            send({ ...base, choices: [], usage });
            res.write("data: [DONE]\n\n");
            res.end();
          }, 200);
        }
      }, 250);
    });
    return;
  }
  if (req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "pcx-mock-model", object: "model" }] }));
    return;
  }
  res.writeHead(404).end("{}");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;

// ---------- isolated agent config ----------
fs.writeFileSync(path.join(AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    "pcx-mock": {
      name: "PCX Mock",
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      api: "openai-completions",
      apiKey: "pcx-dummy-key",
      models: [{
        id: "pcx-mock-model",
        name: "PCX Mock Model",
        // reasoning: true — pi forces thinkingLevel "off" for non-reasoning
        // models regardless of defaultThinkingLevel.
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "deepseek" },
      }],
    },
  },
}));
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({
  defaultProvider: "pcx-mock",
  defaultModel: "pcx-mock-model",
  defaultThinkingLevel: "high",
  quietStartup: true,
  packages: [],
}));
// Install THIS repo (the code under test), not the published one.
execFileSync(PI_BIN, ["install", path.resolve(new URL("..", import.meta.url).pathname)], {
  env: ISOLATED_ENV,
  stdio: "pipe",
});

// ---------- tmux driving ----------
const SESSION = `pcx-pty-${process.pid}`;
const capture = () => {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", SESSION, "-S", "-200"], { encoding: "utf8" });
  } catch {
    return "";
  }
};
const sendKeys = (keys) => execFileSync("tmux", ["send-keys", "-t", SESSION, ...keys]);
const type = (text) => sendKeys(["-l", text]);
const waitFor = async (pattern, timeoutMs, label) => {
  const start = Date.now();
  for (;;) {
    const frame = capture();
    if (pattern.test(frame)) return frame;
    if (Date.now() - start > timeoutMs) {
      assert.fail(`timeout waiting for ${label}:\n${frame.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

execFileSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "120", "-y", "35", "-c", WORKSPACE]);
sendKeys(["-l", `env HOME=${HOME_DIR} ${PI_BIN}`]);
sendKeys(["Enter"]);

const frames = {};
try {
  // Stage 1: idle footer with REAL model/effort/provider/capacity visible.
  // Wait for the FOOTER (ctx segment is footer-only; the header also shows
  // the model id, so matching it too early would race the footer paint).
  frames.idle = await waitFor(/ctx [0-9—]/, 30_000, "idle footer detail lines");
  assert.match(frames.idle, /pcx-mock-model/, "model id in footer");
  assert.match(frames.idle, /high/, "thinking level in footer");
  assert.match(frames.idle, /pcx-mock/, "provider in footer");
  assert.match(frames.idle, /1\.0M/, "context capacity in footer");

  // Stage 2: a normal run — the Working line is live above the editor with
  // the elapsed timer; ends with a Worked summary (usage-backed tokens).
  type("say PCX_OK");
  sendKeys(["Enter"]);
  frames.working = await waitFor(/Working…/, 15_000, "live Working line");
  assert.match(frames.working, /Working…/, "Working… visible mid-run");
  assert.match(frames.working, /\d+s/, "elapsed seconds ticking");
  assert.match(frames.working, /↑\d/, "live tokens from the streaming usage");
  frames.worked = await waitFor(/PCX_OK/, 30_000, "assistant reply");
  frames.summary = await waitFor(/Worked for/, 30_000, "Worked summary");
  assert.match(frames.summary, /Worked for/);
  // Pi normalizes usage: input = uncached prompt tokens (1200 - 1000 cached
  // = 200), cacheRead = 1000. Arrows follow Pi's ↑=input ↓=output grammar.
  assert.match(frames.summary, /↑200/, "interaction input from the final usage");
  assert.match(frames.summary, /↓80/, "interaction output from the final usage");

  // Stage 2b: thinking run — both timers visible at once (elapsed + thinking).
  type("please PCX_THINK now");
  sendKeys(["Enter"]);
  frames.thinking = await waitFor(/thinking \d+s/, 30_000, "live thinking timer");
  assert.match(frames.thinking, /thinking \d+s/, "open thinking grows in real time");
  assert.match(frames.thinking, /Working…/, "message segment stays stable while thinking");
  await waitFor(/PCX_THINK_DONE/, 30_000, "post-thinking reply");
  frames.thinkSummary = await waitFor(/thought for \d+s/, 30_000, "closed thinking in summary");
  assert.match(frames.thinkSummary, /thought for \d+s/, "summary carries the accumulated thinking time");

  // Stage 3: tool run — real bash execution through the mock's tool call,
  // still Worked (proves the tool path doesn't brand Failed).
  type("please PCX_TOOL now");
  sendKeys(["Enter"]);
  frames.tool = await waitFor(/PCX_TOOL_MARK/, 60_000, "tool output");
  assert.match(frames.tool, /PCX_TOOL_MARK/, "bash tool executed for real");
  frames.toolSummary = await waitFor(/Worked for/, 60_000, "post-tool Worked summary");
  assert.match(frames.toolSummary, /Worked for/);

  // Stage 4: provider error — the run must end Failed (real terminal error).
  type("please PCX_FAIL now");
  sendKeys(["Enter"]);
  frames.failed = await waitFor(/Failed after/, 60_000, "Failed summary");
  assert.match(frames.failed, /Failed after/);

  console.log("PASS: real TUI frames verified —");
  console.log("  idle footer:  model/effort/provider/capacity visible");
  console.log("  live Working: Working… + elapsed + live tokens mid-stream");
  console.log("  thinking:     elapsed + thinking timers grow together; summary 'thought for'");
  console.log("  tool run:     real bash output, summary still Worked");
  console.log("  provider err: summary Failed after (real terminal evidence)");
} finally {
  try { execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "pipe" }); } catch { /* already gone */ }
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
}
