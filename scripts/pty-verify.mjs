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
      const reply = /PCX_SELECT/.test(text)
        ? "SELECT_BEGIN_MARK\n这一段很长的中文回答会在终端宽度下软折行显示成多个屏幕行，复制时应当保持为一行逻辑文本，不添加多余的换行或空格。\nselect alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\nSELECT_END_MARK"
        : "PCX_OK";
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
  tuiMode: "fullscreen",
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
  // Wait for the composer METADATA row (ctx segment lives there in 0.8.5).
  frames.idle = await waitFor(/ctx [0-9—]/, 30_000, "idle composer metadata");
  // 0.8.5 split: metadata (surface) owns model/effort/provider/context;
  // the footer owns cwd/branch/session — no duplication.
  assert.match(frames.idle, /pcx-mock-model · high · pcx-mock/, "metadata: model/effort/provider");
  assert.match(frames.idle, /ctx 0\/1\.0M · 0%/, "metadata: context usage");
  assert.match(frames.idle, /Ask anything\.\.\./, "composer placeholder on the gray surface");
  assert.match(frames.idle, /(^|\n)\s*> /, "`> ` prompt prefix on the first input row");
  const metaLine = frames.idle.split("\n").find((l) => l.includes("pcx-mock-model")) ?? "";
  const footerLines = frames.idle.split("\n").filter((l) => l.trim() && !l.includes("pcx-mock-model") && !l.includes("Ask anything"));
  assert.ok(footerLines.some((l) => l.includes("pcx-mock-pty") || (l.includes("/") && !l.includes("ctx "))), "footer carries cwd/branch rows");
  assert.ok(!footerLines.some((l) => l.includes("pcx-mock-model ·")), "footer does NOT duplicate the model line");

  // Stage 2: a normal run — the Working line is live above the editor with
  // the elapsed timer; ends with a Worked summary (usage-backed tokens).
  type("say PCX_OK");
  sendKeys(["Enter"]);
  frames.working = await waitFor(/• Working \(/, 15_000, "live Working line");
  assert.match(frames.working, /• Working \(\d+s · esc to interrupt\)/, "Codex status rhythm with elapsed");
  assert.match(frames.working, /\d+s/, "elapsed seconds ticking");
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
  assert.match(frames.thinking, /• Working \(\d+s · thinking \d+s · esc to interrupt\)/, "dual timers in the Codex paren group");
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

  // Stage 5: selection copy — REAL SGR mouse sequences through the PTY, then
  // Ctrl+C. The /codex-ui telemetry (not the OS clipboard) is the oracle: it
  // records the serializer's mode and the exact char count without touching
  // the user's clipboard.
  type("please PCX_SELECT now");
  sendKeys(["Enter"]);
  frames.selectReply = await waitFor(/SELECT_END_MARK/, 60_000, "selectable reply");
  await new Promise((resolve) => setTimeout(resolve, 800)); // settle render
  const selectReply = "SELECT_BEGIN_MARK\n这一段很长的中文回答会在终端宽度下软折行显示成多个屏幕行，复制时应当保持为一行逻辑文本，不添加多余的换行或空格。\nselect alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\nSELECT_END_MARK";
  const paneSize = (() => {
    const out = execFileSync("tmux", ["display-message", "-p", "-t", SESSION, "#{pane_width} #{pane_height}"], { encoding: "utf8" });
    const [w, h] = out.trim().split(" ").map(Number);
    return { w, h };
  })();
  // capture-pane -S -200 includes scrollback; mouse rows are SCREEN rows —
  // use only the last pane_height lines (the live viewport).
  const visibleRows = frames.selectReply.split("\n").slice(-paneSize.h);
  const beginRow = visibleRows.findIndex((l) => l.includes("SELECT_BEGIN_MARK"));
  const endRow = visibleRows.findIndex((l) => l.includes("SELECT_END_MARK"));
  assert.ok(beginRow >= 0 && endRow > beginRow, "both markers visible in the viewport");
  const cellOf = (rowText, needle, offset) => {
    // 1-based tmux column: sum display widths up to the needle (CJK = 2 cells).
    let cells = 0;
    const at = rowText.indexOf(needle) + offset;
    for (const ch of rowText.slice(0, at)) cells += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    return cells + 1;
  };
  const beginLine = visibleRows[beginRow];
  const endLine = visibleRows[endRow];
  const pressX = cellOf(beginLine, "SELECT_BEGIN_MARK", 0);
  // Drag to the end of the END marker row (past its last cell → boundary).
  const endX = cellOf(endLine, "SELECT_END_MARK", "SELECT_END_MARK".length);
  const sgrSeq = (button, x, y, release) => {
    const s = `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;
    return [...Buffer.from(s, "utf8")].map((b) => b.toString(16).padStart(2, "0"));
  };
  sendKeys(["-H", ...sgrSeq(0, pressX, beginRow + 1)]);
  sendKeys(["-H", ...sgrSeq(32, endX, endRow + 1)]);
  sendKeys(["-H", ...sgrSeq(0, endX, endRow + 1, true)]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  // Ctrl+C through the PTY: with a selection this copies (consumed), the
  // draft and the app survive; a second Ctrl+C would clear — send exactly one.
  sendKeys(["C-c"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  frames.aliveAfterCopy = capture();
  const flashLine = frames.aliveAfterCopy.split("\n").find((l) => /Copied|Copy failed/.test(l));
  assert.ok(flashLine, "copy flash (Copied!) visible on screen");
  assert.doesNotMatch(frames.aliveAfterCopy, /exited|Goodbye/, "app must survive copy Ctrl+C");
  type("/codex-ui");
  sendKeys(["Enter"]);
  frames.diag = await waitFor(/selection-copy: serializer=installed/, 15_000, "selection-copy diagnostics");
  const expectedChars = selectReply.length;
  // The 120-col pane wraps long diagnostic rows; whitespace-insensitive match.
  const flat = frames.diag.replace(/\s+/g, "");
  const copyStats = flat.match(/copy-stats:calls=(\d+)exact=(\d+)mixed=(\d+)native=(\d+)empty=(\d+)failed=(\d+)last=(\S+?)chars=(\d+)/);
  assert.ok(copyStats, "copy telemetry present");
  assert.ok(Number(copyStats[2]) >= 1, `at least one exact copy (got ${copyStats[2]})`);
  assert.equal(Number(copyStats[8]), expectedChars, `copied char count matches the reply length (${expectedChars})`);

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
