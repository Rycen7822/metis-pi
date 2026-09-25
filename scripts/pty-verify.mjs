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
// Stale codex-todo state from a previous harness run would break the
// "Todos 0/1 done" stage assertion — start each run with a clean store.
try { fs.rmSync(path.join(WORKSPACE, ".pi", "codex-todos"), { recursive: true, force: true }); } catch { /* best effort */ }
// skill-mux fixtures: two skills in the default agent skills dir. The 0.17.6
// stage types `/skill:a /skill:b tail` into the real composer; the mock model
// reports which blocks it received.
for (const probe of ["pcx-pty-mux-a", "pcx-pty-mux-b"]) {
  const dir = path.join(AGENT_DIR, "skills", probe);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${probe}\ndescription: pty probe\n---\n${probe} probe body.\n`);
}
// A real git work tree, so the footer's working-tree change counts are asserted
// from real frames (the 0.11.0 +A −D segment). Skipped with a note without git.
const hasGit = (() => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
if (hasGit) {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: WORKSPACE, stdio: "ignore" });
  fs.writeFileSync(path.join(WORKSPACE, "tracked.txt"), "one\ntwo\nthree\n");
  execFileSync("git", ["add", "-A"], { cwd: WORKSPACE, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: WORKSPACE, stdio: "ignore" });
  // Work that PRE-DATES the session: the footer's baseline, never counted.
  fs.writeFileSync(path.join(WORKSPACE, "preexisting.txt"), "old\nwork\nhere\nfour\n");
}
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
      // Streaming text reply. Declared before the marker branches: a branch that
      // calls it synchronously would otherwise hit the temporal dead zone.
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
      if (/PCX_GLYPH/.test(text)) {
        const cmd = "printf '\u2714 done\\n\u2716 fail\\n'";
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_pcx2", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: cmd }) } }] }, finish_reason: null }] });
        setTimeout(() => {
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          send({ ...base, choices: [], usage });
          res.write("data: [DONE]\n\n");
          res.end();
        }, 400);
        return;
      }
      if (/PCX_TODO_DONE/.test(text)) {
        // One assistant message carrying five `todo complete` calls. After the
        // tool results, pi asks the model again with the same user text, so the
        // guard answers with plain text instead of re-issuing the calls. It keys
        // on THIS call id: earlier stages already put tool results in the
        // transcript, so a plain `role === "tool"` test would match immediately.
        const issued = (parsed.messages ?? []).some((m) =>
          m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.id === "call_pcxd1"),
        );
        if (issued) {
          finishText("PCX_TODO_DONE_ACK");
          return;
        }
        const calls = [1, 2, 3, 4, 5].map((id, i) => ({
          index: i, id: `call_pcxd${id}`, type: "function",
          function: { name: "todo", arguments: JSON.stringify({ action: "complete", id, evidence: `pty completion ${id}` }) },
        }));
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls }, finish_reason: null }] });
        setTimeout(() => {
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          send({ ...base, choices: [], usage });
          res.write("data: [DONE]\n\n");
          res.end();
        }, 400);
        return;
      }
      if (/PCX_TODO_AGAIN/.test(text)) {
        const issuedAgain = (parsed.messages ?? []).some((m) =>
          m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.id === "call_pcx5"),
        );
        if (issuedAgain) {
          finishText("PCX_TODO_AGAIN_ACK");
          return;
        }
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_pcx5", type: "function", function: { name: "todo", arguments: JSON.stringify({ action: "add", tasks: [{ title: "pty fresh task" }] }) } }] }, finish_reason: null }] });
        setTimeout(() => {
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          send({ ...base, choices: [], usage });
          res.write("data: [DONE]\n\n");
          res.end();
        }, 400);
        return;
      }
      if (/PCX_TODO_MANY/.test(text)) {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_pcx4", type: "function", function: { name: "todo", arguments: JSON.stringify({ action: "add", tasks: [{ title: "pty task 2" }, { title: "pty task 3" }, { title: "pty task 4" }, { title: "pty task 5" }] }) } }] }, finish_reason: null }] });
        setTimeout(() => {
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          send({ ...base, choices: [], usage });
          res.write("data: [DONE]\n\n");
          res.end();
        }, 400);
        return;
      }
      if (/PCX_TODO/.test(text)) {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_pcx3", type: "function", function: { name: "todo", arguments: JSON.stringify({ action: "add", tasks: [{ title: "pty task" }] }) } }] }, finish_reason: null }] });
        setTimeout(() => {
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          send({ ...base, choices: [], usage });
          res.write("data: [DONE]\n\n");
          res.end();
        }, 400);
        return;
      }
      if (/PCX_THINK/.test(text)) {
        // Reasoning phase first (deepseek-style reasoning_content), slow enough
        // for the tick loop to show the growing thinking timer and LONG enough
        // to overflow the 6-row peek window. The head/tail markers let the test
        // tell the clipped window from the fully expanded body.
        const reasoning = `PCX_THINK_HEAD ${"the transcript window keeps the newest rows ".repeat(20)}PCX_THINK_TAIL`;
        let r = 0;
        const rtimer = setInterval(() => {
          send({ ...base, choices: [{ index: 0, delta: { reasoning_content: reasoning.slice(r, r + 80) }, finish_reason: null }] });
          r += 80;
          if (r >= reasoning.length) {
            clearInterval(rtimer);
            setTimeout(() => finishText("PCX_THINK_DONE"), 300);
          }
        }, 300);
        return;
      }
      const reply = /PCX_SELECT/.test(text)
        ? "SELECT_BEGIN_MARK\n这一段很长的中文回答会在终端宽度下软折行显示成多个屏幕行，复制时应当保持为一行逻辑文本，不添加多余的换行或空格。\nselect alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\nSELECT_END_MARK"
        : /MUX_TAIL_MARKER/.test(text)
          // 0.17.6 skill-mux E2E: the model must receive BOTH skill blocks
          // (JSON-escaped quote form — raw `/skill:` tokens never produce it)
          // and the trailing text, with no leftover raw `/skill:` token.
          ? `MUX_REPLY A=${text.includes('<skill name=\\"pcx-pty-mux-a')} B=${text.includes('<skill name=\\"pcx-pty-mux-b')} TAIL=${text.includes("MUX_TAIL_MARKER")} RAW=${text.includes("/skill:pcx-pty-mux") || text.includes("￥pcx-pty-mux")}`
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
// The vendored codex-conversion defaults its background-shell shortcut to alt+q, which is
// also a pi built-in (app.message.dequeue); pi then prints an "Extension issues" banner that
// shifts every row and breaks the coordinate-based mouse stages below. Real installs set this
// in pi-codex-conversion.json (the dev machine uses alt+u), so seed the isolated HOME the
// same way instead of diverging from the upstream default.
fs.writeFileSync(path.join(AGENT_DIR, "pi-codex-conversion.json"), JSON.stringify({
  ui: { backgroundShellPrevShortcut: "alt+u" },
}));
// The vendored codex-conversion renders its CHANGELOG "what's new" block into the transcript
// on first sight of a version (state file: howaboua-pi-stuff-changelog.json in the agent dir).
// That block shifts the whole layout and leaves the transcript scrolled past the reasoning
// window, which breaks the coordinate-based stages below; the harness is not testing that notice.
fs.writeFileSync(path.join(AGENT_DIR, "howaboua-pi-stuff-changelog.json"), JSON.stringify({ suppress: true }));
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
/** Capture with ANSI escapes for properties plain screen text cannot show (selection video). */
const captureStyled = () => {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-e", "-t", SESSION, "-S", "-200"], { encoding: "utf8" });
  } catch {
    return "";
  }
};
// PCX_PTY_SKIP_WHEEL=1 runs every stage except the two wheel-driven scroll assertions (tmux's
// synthesized wheel bytes scroll nothing in this environment on Pi 0.86.1 and 0.87.0; see
// VALIDATION.md). Skipped checks are reported as skipped and never as passed.
const SKIP_WHEEL = process.env.PCX_PTY_SKIP_WHEEL === "1";
const skippedChecks = [];
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

// Shared viewport/mouse helpers: capture-pane includes scrollback, so mouse
// rows are SCREEN rows — always index through the last pane_height lines.
const paneSize = () => {
  const out = execFileSync("tmux", ["display-message", "-p", "-t", SESSION, "#{pane_width} #{pane_height}"], { encoding: "utf8" });
  const [w, h] = out.trim().split(" ").map(Number);
  return { w, h };
};
const visibleRows = (frame) => frame.split("\n").slice(-paneSize().h);
/** Wait until `pattern` is no longer on screen (inverse of waitFor). */
const waitGone = async (pattern, timeoutMs, label) => {
  const start = Date.now();
  for (;;) {
    // Pane-scoped view: `visibleText` only exists inside main(), the helpers at
    // module scope have to build it from the capture themselves.
    if (!pattern.test(visibleRows(capture()).join("\n"))) return;
    if (Date.now() - start > timeoutMs) {
      assert.fail(`timeout waiting for ${label} to disappear:\n${capture().slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
/** Wait until two consecutive captures are identical (streaming output settled). */
const waitStableFrame = async (timeoutMs = 15_000) => {
  const start = Date.now();
  let previous = capture();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const current = capture();
    if (current === previous) return;
    previous = current;
    if (Date.now() - start > timeoutMs) return;
  }
};
/**
 * Click the row that matches `rowPattern` until `done()` holds. The transcript
 * re-flows while output streams, so the row must be re-found per attempt (the
 * panel stages use the same discipline).
 */
const clickRowUntilState = async (rowPattern, hover, done, timeoutMs, label) => {
  const start = Date.now();
  for (;;) {
    if (done()) return;
    const rows = visibleRows(capture());
    const index = rows.findIndex((line) => rowPattern.test(line));
    if (index >= 0) {
      clickRow(index, cellOf(rows[index], hover));
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (done()) return;
    }
    if (Date.now() - start > timeoutMs) {
      assert.fail(`timeout: ${label}\n${capture().slice(-1500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};
/** 0-based screen row of the first visible line matching `pattern` (-1 when absent). */
const rowOf = (pattern) => visibleRows(capture()).findIndex((line) => pattern.test(line));
const cellOf = (rowText, needle, offset = 0) => {
  // 1-based tmux column: sum display widths up to the needle (CJK = 2 cells).
  let cells = 0;
  const at = rowText.indexOf(needle) + offset;
  for (const ch of rowText.slice(0, at)) cells += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return cells + 1;
};
const sgrSeq = (button, x, y, release) => {
  const s = `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;
  return [...Buffer.from(s, "utf8")].map((b) => b.toString(16).padStart(2, "0"));
};
/** Left click on a viewport row (0-based within the live screen). */
const clickRow = (rowIndex0, col) => {
  sendKeys(["-H", ...sgrSeq(0, col, rowIndex0 + 1)]);
  sendKeys(["-H", ...sgrSeq(0, col, rowIndex0 + 1, true)]);
};
/** Wheel over a viewport row (64 = up / older, 65 = down / newer). */
const wheelRow = (rowIndex0, col, up = true) => {
  sendKeys(["-H", ...sgrSeq(up ? 64 : 65, col, rowIndex0 + 1)]);
};
/** Two left clicks inside the double-click window: ONE gesture for the plugin. */
const doubleClickRow = async (rowIndex0, col) => {
  clickRow(rowIndex0, col);
  await new Promise((resolve) => setTimeout(resolve, 80));
  clickRow(rowIndex0, col);
};

/** (Re)start the TUI in the same tmux session — the restart stage uses this. */
const bootPi = () => {
  try { execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "pipe" }); } catch { /* not running */ }
  execFileSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "120", "-y", "35", "-c", WORKSPACE]);
  // PI_SKIP_VERSION_CHECK: the "Update Available" banner lands in the transcript
  // asynchronously and shifts rows under the mouse stages (flaky), and it has
  // nothing to do with what we verify here.
  sendKeys(["-l", `env HOME=${HOME_DIR} PI_SKIP_VERSION_CHECK=1 ${PI_BIN}`]);
  sendKeys(["Enter"]);
};
bootPi();

const frames = {};
try {
  // Stage 1: idle footer with REAL model/effort/provider/capacity visible.
  // Wait for the footer's context field below the editor.
  frames.idle = await waitFor(/ctx [0-9—]/, 30_000, "idle footer metadata");
  // The vendored codex-conversion entry is part of this package's manifest, so a broken
  // vendored build, a missing asset or a shortcut collision with a pi built-in shows up
  // here as an "[Extension issues]" block in the transcript.
  assert.ok(!frames.idle.includes("[Extension issues]"), "extensions load without issues (see the frame above)");
  assert.ok(!/Could not read the @howaboua\/pi-codex-conversion changelog/.test(frames.idle), "vendored CHANGELOG.md is present");
  assert.match(frames.idle, /pcx-mock-model · high · pcx-mock/, "footer: model/effort/provider");
  assert.match(frames.idle, /ctx 0\/1\.0M · 0%/, "footer: context usage");
  assert.match(frames.idle, /Ask anything\.\.\./, "composer placeholder on the gray surface");
  assert.match(frames.idle, /(^|\n)\s*> /, "`> ` prompt prefix on the first input row");
  const orderedFooter = frames.idle.slice(frames.idle.indexOf("pcx-mock-model"));
  assert.ok(orderedFooter.indexOf("(main)") > orderedFooter.indexOf("pcx-mock-model"), "path/branch follows model/provider below editor");
  assert.ok(orderedFooter.indexOf("ctx 0/1.0M") > orderedFooter.indexOf("(main)"), "context follows path");
  assert.ok(frames.idle.indexOf("Ask anything...") < frames.idle.lastIndexOf("pcx-mock-model"),
    `footer lives below the editor: ${JSON.stringify(frames.idle.slice(-550))}`);
  // 0.13.0: working-tree change counts ride with the branch, straight from git.
  if (hasGit) {
    // The counts are the work tree vs HEAD right now (staged + unstaged once,
    // plus untracked text files): the pre-existing untracked file above shows
    // immediately — there is no session baseline. The poll (2s) and the frames
    // are asynchronous, so assert on a settled frame.
    frames.gitChangesPreexisting = await waitFor(/\(main\) \+4 -0/, 15_000, "pre-existing untracked work shows in the footer");
    assert.match(frames.gitChangesPreexisting, /\(main\) \+4 -0/, "existing WIP is displayed, not hidden");

    // An edit from outside the agent (a script / another terminal) counts the
    // same way the agent's own tools do: the new 3-line untracked file joins
    // the pre-existing 4 → "+7 -0".
    fs.writeFileSync(path.join(WORKSPACE, "scripted.txt"), "alpha\nbeta\ngamma\n");
    frames.gitChanges = await waitFor(/\+7 -0/, 15_000, "footer working-tree change counts");
    assert.match(frames.gitChanges, /\(main\) \+7 -0/, "counts follow the branch");

    // A tracked rewrite with real deletions (5 added, 2 removed) joins the 7
    // untracked lines: the footer must show the absolute pair (+12 -2), never a
    // net "+5 -0" or a line-count delta.
    fs.writeFileSync(path.join(WORKSPACE, "tracked.txt"), "one\nfour\nfive\nsix\nseven\neight\n");
    frames.gitChangesEdit = await waitFor(/\+12 -2/, 15_000, "absolute counts: +7 untracked and +5 tracked, 2 deletions");
    assert.match(frames.gitChangesEdit, /\(main\) \+12 -2/, "additions and deletions are absolute, not a net");

    // A commit makes the sample empty: the tree is clean against the new HEAD,
    // so no counts by the branch.
    execFileSync("git", ["add", "-A"], { cwd: WORKSPACE, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "mid-session"], { cwd: WORKSPACE, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const committed = visibleRows(capture()).join("\n");
    assert.ok(!/\+\d+ -\d+/.test(committed), "a mid-session commit clears the counts");

    // …and work made after the commit counts fresh against the new HEAD:
    // 3 appended lines → "+3 -0".
    fs.appendFileSync(path.join(WORKSPACE, "scripted.txt"), "delta\nepsilon\nzeta\n");
    frames.gitChangesAfter = await waitFor(/\(main\) \+3 -0/, 15_000, "post-commit edits count against the new HEAD");

    // Rewriting the three lines that were just added replaces them in the
    // current diff: the 6 committed lines become 5, i.e. +2 −3. Nothing
    // accumulates — the old churn mode reported +5 −3 here.
    fs.writeFileSync(path.join(WORKSPACE, "scripted.txt"), "alpha\nbeta\ngamma\nTHE1\nTHE2\n");
    frames.gitChangesRewrite = await waitFor(/\(main\) \+2 -3/, 20_000, "the sample follows the rewrite exactly");
    assert.match(frames.gitChangesRewrite, /\(main\) \+2 -3/, "current diff, not accumulated churn");
  } else {
    console.log("  NOTE: git unavailable — session change counts not asserted");
  }

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
  // 0.9.11: the footer's measured output speed — the mock streams 2 chars per
  // 250ms and reports completion_tokens=80, so the value is a real rate over a
  // real ~500ms delta window (never an estimate from the reply length).
  const speedRow = frames.summary.split("\n").find((l) => l.includes("tok/s"));
  assert.ok(speedRow, `footer shows the measured output speed:\n${frames.summary.slice(-800)}`);
  assert.match(speedRow, /\d+(\.\d+)? tok\/s/, "rate carries its unit");
  assert.ok(frames.summary.includes("↑") && frames.summary.lastIndexOf("tok/s") > frames.summary.lastIndexOf("↑"),
    "rate follows input/output in the footer");

  // Stage 2b: thinking run — both timers visible at once (elapsed + thinking).
  type("please PCX_THINK now");
  sendKeys(["Enter"]);
  frames.thinking = await waitFor(/thinking \d+s/, 30_000, "live thinking timer");
  assert.match(frames.thinking, /• Working \(\d+s · thinking \d+s · esc to interrupt\)/, "dual timers in the Codex paren group");
  // 0.12.0: the LIVE reasoning renders as a peek window — newest rows plus one
  // dim hint row — instead of the whole (now long) body: the head of the stream
  // is clipped, and the wheel scrolls inside the window.
  // The transcript keeps 200 rows of scrollback in the capture, so the thinking
  // stages match only rows that are ON SCREEN: a hint left in history must not
  // pass for an open window.
  const visibleText = () => visibleRows(capture()).join("\n");
  const waitForVisible = async (pattern, timeoutMs, label) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (pattern.test(visibleText())) return capture();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.fail(`timeout waiting for ${label} (visible rows only):\n${capture().slice(-2200)}`);
  };
  frames.livePeek = await waitForVisible(/scroll · double-click for all/, 30_000, "live thinking peek window");
  assert.match(frames.livePeek, /… \d+ above of \d+ lines/, "hint counts the clipped rows");
  assert.ok(!visibleRows(frames.livePeek).some((l) => l.includes("PCX_THINK_HEAD")), "peek follows the newest rows (head clipped away)");
  // (The wheel is asserted below, on the settled block: while the stream is
  // running the block shifts a row or two between reading a row and sending the
  // event, so a wheel aimed at a captured row can land beside the window.)
  await waitFor(/PCX_THINK_DONE/, 30_000, "post-thinking reply");
  frames.thinkSummary = await waitFor(/thought for \d+s/, 30_000, "closed thinking in summary");
  assert.match(frames.thinkSummary, /thought for \d+s/, "summary carries the accumulated thinking time");

  // 0.12.0: the completed run auto-collapses (label with its duration), a
  // SINGLE click opens the 6-row peek window (not the whole body), a DOUBLE
  // click toggles between the peek window and the fully expanded body, and a
  // single click folds it again. The chat shifts as the Working widget retires
  // at settle AND the TUI's region hit rows sit ±1 against the capture rows, so
  // every attempt re-locates the row from a FRESH capture and sweeps small row
  // offsets until the expected frame appears (each miss is a no-op, so sweeping
  // never double-toggles).
  frames.collapsed = await waitFor(/Thought for \d+s/, 30_000, "auto-collapsed thinking label");
  assert.ok(!visibleRows(frames.collapsed).some((l) => l.includes("PCX_THINK_TAIL")), "reasoning body hidden while collapsed");

  // Everything below clicks the MIDDLE of the block, never its first row: the
  // TUI's region hit rows sit a row or two off the captured rows in this pane,
  // so a 7-row block is only reliably hit near its centre. Every helper re-reads
  // the screen and sweeps small offsets; a missed row is a no-op.
  const clickAt = async (rowIndex0, col) => {
    clickRow(rowIndex0, col);
    await new Promise((resolve) => setTimeout(resolve, 700));
  };
  const doubleClickAt = async (rowIndex0, col) => {
    await doubleClickRow(rowIndex0, col);
    await new Promise((resolve) => setTimeout(resolve, 700));
  };
  /** What the reasoning block currently shows: the host label, the 6-row peek
   * window, or the fully expanded body. */
  const screenState = () => {
    const text = visibleText();
    if (/scroll · double-click for all/.test(text)) return "peek";
    if (/PCX_THINK_HEAD/.test(text)) return "full";
    if (/Thought for \d+s/.test(text)) return "collapsed";
    return "unknown";
  };
  /** Drive the block to `target` with real gestures: a single click moves
   * collapsed ↔ peek, a double click moves peek ↔ full. Each step is verified
   * from a fresh screen, so a gesture the host reads differently is corrected on
   * the next pass instead of failing the stage. */
  const gotoState = async (target, timeoutMs) => {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      const state = screenState();
      if (state === target) return capture();
      const rows = visibleRows(capture());
      const offset = [0, 1, -1][attempt % 3];
      if (state === "collapsed") {
        const index = rows.findIndex((l) => l.includes("Thought for"));
        if (index >= 0) await clickAt(index + offset, 8);
      } else if (state === "peek" || state === "full") {
        const index = rows.findIndex((l) => l.includes("transcript window"));
        if (index >= 0) await doubleClickAt(index + offset, 8);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      attempt += 1;
    }
    assert.fail(`timeout reaching thinking state "${target}" (still "${screenState()}"):\n${capture().slice(-2200)}`);
  };

  frames.peeked = await gotoState("peek", 25_000);
  assert.ok(!visibleRows(frames.peeked).some((l) => l.includes("PCX_THINK_HEAD")), "peek window clips the head of the reasoning");
  assert.ok(visibleRows(frames.peeked).some((l) => l.includes("PCX_THINK_TAIL")), "peek window shows the newest rows");

  // The wheel scrolls INSIDE the window instead of the transcript — the block is
  // settled here, so the row read is the row hit.
  const wheelUntil = async (pattern, timeoutMs, label) => {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      const rows = visibleRows(capture());
      const index = rows.findIndex((l) => l.includes("above of") || l.includes("below of"));
      if (index >= 0) {
        wheelRow(index + [0, 1, -1][attempt % 3], 40, true);
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (pattern.test(visibleText())) return capture();
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail(`timeout waiting for ${label} (visible rows only):\n${capture().slice(-2200)}`);
  };
  const refollow = async (timeoutMs) => {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      if (/… \d+ above of \d+ lines/.test(visibleText())) return capture();
      const rows = visibleRows(capture());
      const index = rows.findIndex((l) => l.includes("above of") || l.includes("below of"));
      if (index >= 0) wheelRow(index + [0, 1, -1, 2][attempt % 4], 40, false);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    assert.fail(`timeout waiting for the peek window to follow its tail again:\n${capture().slice(-2200)}`);
  };
  if (SKIP_WHEEL) {
    skippedChecks.push("wheel scrolls the reasoning window and refollows its tail");
  } else {
    frames.scrolled = await wheelUntil(/below of \d+ lines/, 20_000, "wheel scrolls the reasoning window");
    assert.ok(!visibleRows(frames.scrolled).some((l) => l.includes("PCX_THINK_HEAD")), "one wheel line up still clips the very beginning");
    frames.refollowed = await refollow(20_000);
    assert.ok(visibleRows(frames.refollowed).some((l) => l.includes("PCX_THINK_TAIL")), "newest rows back in view");
  }

  frames.fullBody = await gotoState("full", 30_000);
  assert.ok(!/scroll · double-click for all/.test(visibleText()), "fully expanded body carries no peek hint");
  frames.peekAgain = await gotoState("peek", 30_000);
  assert.ok(!visibleRows(frames.peekAgain).some((l) => l.includes("PCX_THINK_HEAD")), "reasoning clipped again");
  frames.recollapsed = await gotoState("collapsed", 20_000);
  assert.ok(!visibleRows(frames.recollapsed).some((l) => l.includes("PCX_THINK_TAIL")), "reasoning hidden again");

  // Stage 3: tool run — real bash execution through the mock's tool call,
  // still Worked (proves the tool path doesn't brand Failed).
  type("please PCX_TOOL now");
  sendKeys(["Enter"]);
  frames.tool = await waitFor(/PCX_TOOL_MARK/, 60_000, "tool output");
  assert.match(frames.tool, /PCX_TOOL_MARK/, "bash tool executed for real");
  frames.toolSummary = await waitFor(/Worked for/, 60_000, "post-tool Worked summary");
  assert.match(frames.toolSummary, /Worked for/);

  // Stage 3b: glyph presentation — a tool whose COMMAND and OUTPUT carry ✔/✖
  // must reach the screen with the U+FE0E text-presentation selector (the
  // user's screenshot: an emoji font painted ~2 cells of ink over the next
  // character, hiding the backslash after ✖). Selector is zero-width, so the
  // frame must carry it but no bare mark may remain.
  type("please PCX_GLYPH now");
  sendKeys(["Enter"]);
  frames.glyph = await waitFor(/\u2716.? fail/, 60_000, "glyph tool output on screen");
  await new Promise((resolve) => setTimeout(resolve, 800)); // settle the frames
  const glyphFrame = visibleRows(capture()).join("\n");
  assert.ok(glyphFrame.includes("\u2714\uFE0E done"), "\u2714 carried the text-presentation selector on screen");
  assert.ok(glyphFrame.includes("\u2716\uFE0E fail"), "\u2716 carried the selector");
  assert.ok((glyphFrame.match(/\u2714\uFE0E/g) ?? []).length >= 2, "command row + output row both normalized");
  assert.ok((glyphFrame.match(/\u2716\uFE0E/g) ?? []).length >= 2, "command row + output row both normalized");
  assert.doesNotMatch(glyphFrame, /[\u2714\u2716](?![\uFE0E\uFE0F])/, "no bare \u2714/\u2716 reaches the screen");

  // Stage 3c: codex-todo — the mock model calls the todo tool; the persistent
  // widget appears above the editor and the store lands on disk in the
  // workspace (.pi/codex-todos/tasks.json).
  type("please PCX_TODO now");
  sendKeys(["Enter"]);
  const todoFrame = await waitFor(/Todos 0\/1 done/, 60_000, "codex-todo widget above the editor");
  assert.ok(todoFrame.includes("○ pty task"), "widget shows the task row");
  assert.ok(fs.existsSync(path.join(WORKSPACE, ".pi", "codex-todos", "tasks.json")), "store persisted in the workspace");

  // Stage 3d: the panel is clickable. Five tasks, so the collapsed view shows
  // three rows plus a "+N more" summary; a left click expands it to the whole
  // list and a second click collapses it back.
  type("please PCX_TODO_MANY");
  sendKeys(["Enter"]);
  const truncated = await waitFor(/\+2 more \(0 completed, 2 pending\)/, 60_000, "collapsed panel truncates the list");
  assert.match(truncated, /Todos 0\/5 done ▾ · click to expand/);
  // Scope every panel assertion to the widget's own rows: the transcript above
  // also mentions these titles (the todo tool reports what it added).
  const panelRowsOf = (frame, count) => {
    const rows = visibleRows(frame);
    const header = rows.findIndex((l) => l.includes("Todos 0/5 done"));
    return header < 0 ? [] : rows.slice(header, header + count);
  };
  const collapsedPanel = panelRowsOf(truncated, 6).join("\n");
  assert.equal((collapsedPanel.match(/○ pty task/g) ?? []).length, 3, "exactly three task rows while collapsed");
  assert.ok(!collapsedPanel.includes("pty task 5"), "the tail is hidden while collapsed");

  // The pane's hit rows drift a row or two from the captured rows (the same
  // caveat as the reasoning stages), so sweep down from the header: every row
  // of the panel toggles the same thing, and each attempt re-checks the target
  // state before clicking again, so a sweep can never double-toggle.
  const togglePanelUntil = async (pattern, label) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = visibleText();
      if (pattern.test(before)) return before;
      const header = visibleRows(capture()).findIndex((l) => l.includes("Todos 0/5 done"));
      assert.ok(header >= 0, `${label}: the panel must be on screen`);
      await clickAt(header + [2, 1, 3, 4, 5, 0][attempt % 6], 12);
      const after = visibleText();
      if (pattern.test(after)) return after;
    }
    throw new Error(`timeout waiting for ${label}:\n${visibleText()}`);
  };

  const expandedPanel = await togglePanelUntil(/click to collapse/, "a left click expands the todo panel");
  assert.match(expandedPanel, /Todos 0\/5 done ▴ · click to collapse/);
  const expandedRows = panelRowsOf(expandedPanel, 7).join("\n");
  assert.equal((expandedRows.match(/○ pty task/g) ?? []).length, 5, "all five task rows while expanded");
  assert.ok(!expandedRows.includes("+2 more"), "no summary row while expanded");
  assert.ok(expandedRows.includes("pty task 5"), "the whole list is visible when expanded");

  const recollapsed = await togglePanelUntil(/\+2 more/, "a second click collapses the todo panel");
  assert.match(recollapsed, /Todos 0\/5 done ▾ · click to expand/);
  const recollapsedRows = panelRowsOf(recollapsed, 6).join("\n");
  assert.equal((recollapsedRows.match(/○ pty task/g) ?? []).length, 3, "clicking again returns to three rows");
  assert.ok(!recollapsedRows.includes("pty task 5"), "collapsing hides the tail again");

  // A RIGHT PRESS alone hides the panel — no release needed. Warp (the user's
  // terminal) forwards the right press but eats the release for its context
  // menu, so the widget hides ON the press and deliberately does not claim
  // it. The harness therefore sends the release as a SEPARATE step to prove
  // the press alone is sufficient (and the release harmless).
  const rightClickUntil = async (pattern, present, label) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const frame = visibleText();
      if (present ? pattern.test(frame) : !pattern.test(frame)) return frame;
      const header = visibleRows(capture()).findIndex((l) => l.includes("Todos 0/5 done"));
      assert.ok(header >= 0, `${label}: the panel must be on screen`);
      const target = header + 1 + [2, 1, 3, 4, 5, 0][attempt % 6]; // SGR rows are 1-based
      sendKeys(["-H", ...sgrSeq(2, 12, target)]);
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    throw new Error(`timeout waiting for ${label}:\n${visibleText()}`);
  };

  await rightClickUntil(/Todos 0\/5 done/, false, "a right press hides the todo panel");
  assert.ok(!visibleText().includes("Todos 0/5 done"), "panel gone on the press alone");
  // The release — which Warp eats — must change nothing.
  sendKeys(["-H", ...sgrSeq(2, 12, 10, true)]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(!visibleText().includes("Todos 0/5 done"), "release after the hide changes nothing");

  // /todos restores it: the overlay is gone since 0.17.5, so the panel must
  // simply reappear (the command also prints the list as a text notify).
  type("/todos");
  sendKeys(["Enter"]);
  await waitFor(/Todos 0\/5 done ▾/, 30_000, "/todos restores the hidden panel");
  assert.ok(!/── todos \(5 tasks\)/.test(visibleText()), "no overlay since 0.17.5");

  // Mouse health after the UNCLAIMED right press: a stale host press target
  // would swallow these clicks, so the restored panel must still expand and
  // collapse on left clicks.
  const reexpanded = await togglePanelUntil(/click to collapse/, "left clicks still reach the panel after the right press");
  assert.ok(reexpanded.includes("pty task 5"), "panel expands again");
  await togglePanelUntil(/\+2 more/, "and collapses again");

  // Stage 3e (0.19.4): the completed-fold needs a real INPUT signal. pi's
  // `ui_prompt_start` is its blocking-dialog event, so the widget's turn ordinal
  // stayed 0 and ✓ rows never folded away. Note this harness types the next
  // message while the previous run is still streaming, so pi delivers it as a
  // `steer` — user input all the same, and the fold must react to it. The panel
  // must fold on the next message, disappear when the list is fully done, and
  // the next batch of work must start a NEW list instead of appending to the
  // finished one.
  type("please PCX_TODO_DONE now");
  sendKeys(["Enter"]);
  const allDone = await waitFor(/Todos 5\/5 done/, 60_000, "the panel reports every task complete");
  assert.ok(allDone.includes("pty task 5"), "the ✓ rows are still listed on the turn that completed them");

  type("PCX_FOLD_NOW");
  sendKeys(["Enter"]);
  await waitGone(/Todos \d+\/\d+ done/, 30_000, "the finished panel folds away on the next prompt");
  assert.ok(!visibleText().includes("Todos 5/5 done"), "no history is left on screen");

  type("please PCX_TODO_AGAIN now");
  sendKeys(["Enter"]);
  const freshList = await waitFor(/Todos 0\/1 done/, 60_000, "new work re-registers the panel");
  const freshRows = visibleRows(freshList);
  const freshHeader = freshRows.findIndex((line) => line.includes("Todos 0/1 done"));
  const freshPanel = freshRows.slice(freshHeader, freshHeader + 3).join("\n");
  assert.ok(freshPanel.includes("pty fresh task"), "the new task is listed");
  assert.ok(!/pty task 2|pty task 3|pty task 4|pty task 5/.test(freshPanel), "the finished list is not carried over as history");
  assert.ok(!/\+4 more|\(4 completed/.test(freshPanel), "the panel counts only the new list");

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
  const selectRows = visibleRows(frames.selectReply);
  const beginRow = selectRows.findIndex((l) => l.includes("SELECT_BEGIN_MARK"));
  const endRow = selectRows.findIndex((l) => l.includes("SELECT_END_MARK"));
  assert.ok(beginRow >= 0 && endRow > beginRow, "both markers visible in the viewport");
  const beginLine = selectRows[beginRow];
  const endLine = selectRows[endRow];
  const pressX = cellOf(beginLine, "SELECT_BEGIN_MARK", 0);
  // Drag to the end of the END marker row (past its last cell → boundary).
  const endX = cellOf(endLine, "SELECT_END_MARK", "SELECT_END_MARK".length);
  sendKeys(["-H", ...sgrSeq(0, pressX, beginRow + 1)]);
  sendKeys(["-H", ...sgrSeq(32, endX, endRow + 1)]);
  sendKeys(["-H", ...sgrSeq(0, endX, endRow + 1, true)]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  // The drag itself must be a real selection: the styled capture shows the reply rows in
  // reverse video before Ctrl+C consumes it.
  assert.ok(
    captureStyled().split("\n").some((line) => line.includes("\u001b[7m") && /SELECT_|alpha beta gamma/.test(line)),
    "the drag establishes a reverse-video selection over the reply",
  );
  // Ctrl+C through the PTY: with a selection this copies (consumed), the draft and the app
  // survive; a second Ctrl+C would clear — send exactly one. Pi shows "Copied!" only for the
  // last-assistant-text fallback; the selection path (handleCopyCommand →
  // copyActiveSelectionToClipboard) copies silently on 0.86.1 and 0.87.0, so the telemetry below
  // is the oracle for the copy itself.
  sendKeys(["C-c"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  frames.aliveAfterCopy = capture();
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
  assert.equal(Number(copyStats[6]), 0, "no failed or empty copy");
  assert.equal(copyStats[7], "exact", "the last copy used the exact serializer mode");
  assert.equal(Number(copyStats[8]), expectedChars, `copied char count matches the reply length (${expectedChars})`);

  // 0.9.4: fullscreen side gutters are active in this same run — transcript
  // rows are inset past margin (2) + outputPad (1) columns, clicks and the
  // exact copy above already prove the shifted frame stays coherent.
  assert.match(beginLine, /^\s{3,}SELECT_BEGIN_MARK/, `transcript content inset by margin + outputPad, got ${JSON.stringify(beginLine)}`);
  assert.ok(flat.includes("fullscreen-margin:applied(margin=2"), "margin diagnostics report applied");
  // The diagnostics block is taller than the pane once the todo panel sits above
  // the editor, so its first segments (composer/model/context/cache/speed) scroll
  // out of view. Wheel the transcript up until the header segment is on screen
  // and assert the speed scope there; everything below reads from the bottom-
  // anchored frame above.
  let flatTop = flat;
  if (SKIP_WHEEL) {
    skippedChecks.push("diagnostics speed scope (needs transcript wheel scrolling)");
  } else {
    for (let attempt = 0; attempt < 10 && !/outputspeed:/.test(flatTop); attempt += 1) {
      for (let i = 0; i < 3; i += 1) wheelRow(4, 30, true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      flatTop = visibleText().replace(/\s+/g, "");
    }
    assert.match(flatTop, /outputspeed:[\d.]+tok\/s\(output=80tokens/, "diagnostics expose the measured speed with its scope");
    // Back to the live tail: the TUI keeps the scroll position after a manual
    // scroll, so later stages would otherwise assert against an old viewport.
    for (let i = 0; i < 40; i += 1) wheelRow(4, 30, false);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  assert.ok(flat.includes('history-window:{"installed":true'), "bounded history installed in real fullscreen TUI");
  const glyphDiag = flat.match(/glyphs:applied\(terminalprototypewrite\)marks=5\[[^\]]*\]frames=(\d+)changed=(\d+)/);
  assert.ok(glyphDiag, "glyph-presentation diagnostics report applied on the real TUI");
  assert.ok(Number(glyphDiag[1]) > 0 && Number(glyphDiag[2]) > 0, `glyph frames=${glyphDiag[1]} changed=${glyphDiag[2]}`);
  // Extension registrations in a LIVE session. `/hotkeys` renders an Extensions table from
  // the host's shortcut registry, so this is positive proof that both our own todo entry and
  // the vendored codex-conversion entry reached a real pi session (a broken vendored build or
  // a load failure would leave the rows missing). Runs last: the block is large, so every
  // coordinate-sensitive stage above is already done.
  type("/hotkeys");
  sendKeys(["Enter"]);
  const hotkeys = await waitFor(/Previous Codex background shell/, 20_000, "extensions in /hotkeys");
  assert.match(hotkeys, /Fold or open Codex background shell widget/, "vendored codex-conversion shortcuts registered");
  assert.ok(!/codex-todo widget/.test(hotkeys), "codex-todo keyboard shortcut is gone (mouse-only since 0.17.3)");

  // 0.17.6: skill-mux — TWO skills in ONE input. The composer slash menu
  // shows nothing for these tokens, so Enter submits the literal text; the
  // input hook must expand both skills (host-format blocks) and keep the
  // trailing text before the host dispatches to the model.
  // 0.18.0/0.18.1 (the user's repro): the editor auto-triggers "/" only at
  // line start and the built-in returns nothing for `/skill:a ` — that null
  // kills the menu state, after which the second "/" keystroke reached NO
  // provider and nothing popped (typing a letter, Tab, or the space+backspace
  // dance re-armed it). The composer now forces that one query itself, and no
  // extra row is shown at the trailing space: the SECOND "/" alone must pop
  // the skill menu, with the state alive (this stage) or dead (next stage).
  type("/skill:pcx-pty-mux-a ");
  type("/");
  await waitFor(/pty probe/, 15_000, "the bare second / pops the skill menu by itself");
  assert.ok(!/继续添加 skill/.test(visibleText()), "no state-keeping row is shown");
  type("mux-b");
  await waitFor(/pty probe/, 15_000, "the menu filters as letters arrive");
  sendKeys(["Tab"]); // accept the selected pcx-pty-mux-b (proven accept key)
  await new Promise((resolve) => setTimeout(resolve, 300));
  type("MUX_TAIL_MARKER");
  sendKeys(["Enter"]);
  await waitFor(/MUX_REPLY A=true B=true TAIL=true RAW=false/, 30_000, "second-/ completion expands");

  // 0.18.1 (THE user repro): the host editor auto-triggers "/" only at line
  // start, so once its menu state is dead (any accept/escape cancels it; the
  // built-in also answers nothing for `/skill:a `) the second "/" reaches NO
  // provider and nothing popped until the user typed a letter, Tab, or deleted
  // the slash. The composer now forces that one query itself. Here the state
  // is killed with Escape, then " " + "/" must pop the menu on its own.
  type("/skill:pcx-pty-mux-a");
  await waitFor(/pty probe/, 15_000, "first-token menu before Escape");
  sendKeys(["Escape"]);
  for (let i = 0; i < 40 && /pty probe/.test(visibleText()); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  } // the menu is really gone — no stale frame can satisfy the next wait
  type(" ");
  type("/");
  await waitFor(/pty probe/, 15_000, "the bare second / pops the menu with a DEAD editor state");
  type("mux-b");
  await waitFor(/pty probe/, 15_000, "dead-state menu filters as letters arrive");
  sendKeys(["Tab"]); // accept the selected pcx-pty-mux-b
  await new Promise((resolve) => setTimeout(resolve, 300));
  type("MUX_TAIL_MARKER");
  sendKeys(["Enter"]);
  await waitFor(/MUX_REPLY A=true B=true TAIL=true RAW=false/, 30_000, "dead-state / completion expands");

  // 0.17.6 baseline still holds without the menu: full tokens typed out.
  type("/skill:pcx-pty-mux-a /skill:pcx-pty-mux-b MUX_TAIL_MARKER");
  sendKeys(["Enter"]);
  await waitFor(/MUX_REPLY A=true B=true TAIL=true RAW=false/, 30_000, "both skills expanded from one input");
  // Transcript folding: the host parses exactly ONE leading skill block, so the
  // expansion nests every later skill inside the first — the entry stays a
  // single collapsed `[skill] …` line (bodies hidden) instead of dumping the
  // second block as raw user text.
  await waitFor(/\[skill\] pcx-pty-mux-a/, 15_000, "multi-skill prompt folds into one [skill] entry");
  assert.ok(!/probe body\./.test(visibleText()), "skill bodies stay collapsed inside the folded entry");
  // skill-label extension: the folded line names every invoked skill, not just
  // the first one (the host's own render lists `skillBlock.name` only).
  await waitFor(
    /\[skill\] pcx-pty-mux-a \+ pcx-pty-mux-b \(ctrl\+o to expand\)/,
    15_000,
    "the folded entry lists both skill names",
  );
  // skill-fold extension: the host's entry is clickable — one left click on the
  // `[skill] …` line expands it, the next one collapses it again.
  // Click ON the label: the transcript has a small left gutter, so the click
  // column is the label's own cell (counted with CJK widths).
  await waitStableFrame();
  assert.ok(rowOf(/\[skill\] pcx-pty-mux-a/) >= 0, "the folded [skill] entry is on screen");
  await clickRowUntilState(
    /\[skill\] pcx-pty-mux-a \+ pcx-pty-mux-b \(ctrl\+o to expand\)/,
    "[skill]",
    () => /probe body\./.test(visibleText()),
    20_000,
    "a click expands the folded skill entry",
  );
  // Expanded, the entry renders a bare `[skill]` label plus the bodies (the
  // markdown header is joined by the same extension), so the
  // second click targets a body row — same component, same toggle.
  await clickRowUntilState(
    /probe body\./,
    "probe body.",
    () => !/probe body\./.test(visibleText()),
    20_000,
    "a second click collapses the skill entry again",
  );
  await waitFor(/\[skill\] pcx-pty-mux-a/, 15_000, "the entry stays collapsed after collapsing it");

  // 0.17.9: ￥ is a registered trigger character — after a complete skill
  // token + space, typing ￥ ALONE must pop the menu (no letter needed).
  type("￥");
  await waitFor(/pty probe/, 15_000, "￥ alone pops the menu at a token boundary");
  type("pcx-pty-mux-a /mux-b");
  await waitFor(/pty probe/, 15_000, "￥ flow filters down to mux-b");
  sendKeys(["Tab"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  type("MUX_TAIL_MARKER");
  sendKeys(["Enter"]);
  await waitFor(/MUX_REPLY A=true B=true TAIL=true RAW=false/, 30_000, "￥ + accepted / token both expand");

  // Restart with a finished list (0.19.1). The store is per workspace and
  // outlives the session, while the widget's turn counter restarts at 0 — the
  // panel must not pop back up for work that was already done.
  const storePath = path.join(WORKSPACE, ".pi", "codex-todos", "tasks.json");
  const stored = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const finishedAt = Date.now() - 3_600_000;
  assert.ok(stored.tasks.length > 0, "the todo stage left tasks to finish");
  fs.writeFileSync(storePath, JSON.stringify({
    ...stored,
    tasks: stored.tasks.map((t) => ({ ...t, status: "complete", evidence: "pty restart probe", completedAt: finishedAt, completedAtTurn: 3 })),
  }, null, 2));
  const finishedCount = stored.tasks.length;

  bootPi();
  await waitFor(/Ask anything\.\.\.|ctx [0-9—]/, 30_000, "composer after the restart");
  await waitStableFrame();
  const restartFrame = visibleText();
  assert.ok(/Ask anything\.\.\./.test(restartFrame), "the restarted TUI is up (composer placeholder visible)");
  assert.ok(
    !/Todos \d+\/\d+ done/.test(restartFrame),
    `no todo panel on restart for ${finishedCount} tasks finished in an earlier session:\n${restartFrame.slice(-800)}`,
  );
  assert.ok(!/task\(s\) pending from the previous session/.test(restartFrame), "no pending-tasks reminder for finished work");
  // Positive control: the list is still on disk, the panel simply folded —
  // /todos lists the tasks as text without resurrecting the panel.
  type("/todos");
  sendKeys(["Enter"]);
  await waitFor(new RegExp(`Todos: ${finishedCount}/${finishedCount} done`), 30_000, "/todos lists the finished tasks after the restart");
  assert.ok(!/Todos \d+\/\d+ done/.test(visibleText()), "/todos does not resurrect the folded panel");

  console.log("PASS: real TUI frames verified —");
  console.log("  idle footer:  model/effort/provider/capacity visible");
  console.log(
    hasGit
      ? "  git changes:  work tree vs HEAD (staged+unstaged once, untracked text): +4 -0 existing WIP, +12 -2 with tracked deletions, commit clears, rewrite reports +2 -3"
      : "  git changes:  not asserted (git unavailable)",
  );
  console.log("  thinking:     6-row peek + hint while streaming; 1 click folds/opens, 2 clicks expand");
  if (!SKIP_WHEEL) console.log("  thinking:     wheel scrolls the peek window in place and refollows its tail (full run)");
  console.log("  output speed: measured tok/s rendered after ↑input (real stream window)");
  console.log("  live Working: Working… + elapsed + live tokens mid-stream");
  console.log("  thinking:     elapsed + thinking timers grow together; summary 'thought for'");
  console.log("  auto-collapse: 'Thought for Ns' label; 1 click = 6-row peek window, 2 clicks = full body");
  if (!SKIP_WHEEL) console.log("  peek window:  live reasoning clipped to the newest rows; wheel scrolls it in place (full run)");
  console.log("  tool run:     real bash output, summary still Worked");
  console.log("  codex-todo:   mock model calls the todo tool -> \"Todos 0/1 done\" panel + store on disk");
  console.log("  codex-todo:   ✓ rows fold on the next prompt, a finished panel disappears, new work starts a fresh list");
  console.log("  todo panel:   a left click expands it to all 5 tasks, a second click collapses it back to 3 rows");
  console.log("  todo panel:   a right press alone hides it (no release needed); /todos restores it; left clicks stay healthy");
  console.log("  todo restart: a store finished in an earlier session shows no panel on the next boot; /todos still lists it");
  console.log("  extensions:   /hotkeys lists the vendored codex-conversion shortcuts; codex-todo registers none (mouse-only)");
  console.log("  skill-mux:    multi-skill prompt folds into ONE collapsed [skill] entry naming BOTH skills (no raw second block) and click-to-expand/collapse toggles it; bare 2nd / pops the menu by itself (live and dead editor state) with no extra row, ￥ triggers at the token boundary; accepted tokens expand → both blocks + tail reach the model, no raw tokens");
  console.log("  provider err: summary Failed after (real terminal evidence)");
  console.log(`  selection:    SGR mouse drag + Ctrl+C → exact copy, ${copyStats[8]} chars (exact=${copyStats[2]} mixed=${copyStats[3]} native=${copyStats[4]})`);
  console.log("  margins:      fullscreen side gutters applied (margin=2), transcript inset verified");
  if (skippedChecks.length > 0) console.log(`  SKIPPED (PCX_PTY_SKIP_WHEEL=1): ${skippedChecks.join("; ")} — not verified in this run`);
} finally {
  try { execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "pipe" }); } catch { /* already gone */ }
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
}
