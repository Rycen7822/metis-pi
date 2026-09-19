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

execFileSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "120", "-y", "35", "-c", WORKSPACE]);
sendKeys(["-l", `env HOME=${HOME_DIR} ${PI_BIN}`]);
sendKeys(["Enter"]);

const frames = {};
try {
  // Stage 1: idle footer with REAL model/effort/provider/capacity visible.
  // Wait for the composer METADATA row (ctx segment lives there in 0.8.5).
  frames.idle = await waitFor(/ctx [0-9—]/, 30_000, "idle composer metadata");
  // The vendored codex-conversion entry is part of this package's manifest, so a broken
  // vendored build, a missing asset or a shortcut collision with a pi built-in shows up
  // here as an "[Extension issues]" block in the transcript.
  assert.ok(!frames.idle.includes("[Extension issues]"), "extensions load without issues (see the frame above)");
  assert.ok(!/Could not read the @howaboua\/pi-codex-conversion changelog/.test(frames.idle), "vendored CHANGELOG.md is present");
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
  // 0.13.0: session change counts ride with the branch, straight from git.
  if (hasGit) {
    // The counts are the SESSION's delta: work that predates the session (the
    // pre-existing untracked file above) must not appear at all. The poll (2s)
    // and the frames are asynchronous, so assert on a settled frame.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const cleanFrame = capture();
    assert.ok(!/\+\d+ -\d+/.test(visibleRows(cleanFrame).join("\n")), "pre-existing work is the baseline, not the session's");

    // An edit from outside the agent (a script / another terminal) counts the
    // same way the agent's own tools do: untracked 3 lines → "+3 -0".
    fs.writeFileSync(path.join(WORKSPACE, "scripted.txt"), "alpha\nbeta\ngamma\n");
    frames.gitChanges = await waitFor(/\+3 -0/, 15_000, "footer session change counts (+3 for one script-written 3-line file)");
    assert.match(frames.gitChanges, /\(main\) \+3 -0/, "counts follow the branch");

    // A tracked rewrite with real deletions (5 added, 2 removed): the footer
    // must show the absolute pair — never a net "+1 -0" or a line-count delta.
    fs.writeFileSync(path.join(WORKSPACE, "tracked.txt"), "one\nfour\nfive\nsix\nseven\neight\n");
    frames.gitChangesEdit = await waitFor(/\+8 -2/, 15_000, "absolute counts: +3 untracked and +5 tracked, 2 deletions");
    assert.match(frames.gitChangesEdit, /\(main\) \+8 -2/, "additions and deletions are absolute, not a net");

    // A commit mid-session (the agent's /commit, or git from a script) clears
    // the stat: the tree is clean against the new HEAD, so no counts by the
    // branch. (0.15.4 — the committed delta folds out of the baseline.)
    execFileSync("git", ["add", "-A"], { cwd: WORKSPACE, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "mid-session"], { cwd: WORKSPACE, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const committed = visibleRows(capture()).join("\n");
    assert.ok(!/\+\d+ -\d+/.test(committed), "a mid-session commit clears the counts");

    // …and work made after the commit counts fresh against the new HEAD:
    // 3 appended lines → "+3 -0".
    fs.appendFileSync(path.join(WORKSPACE, "scripted.txt"), "delta\nepsilon\nzeta\n");
    frames.gitChangesAfter = await waitFor(/\(main\) \+3 -0/, 15_000, "post-commit edits count against the new HEAD");
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
  assert.ok(speedRow.indexOf("tok/s") < speedRow.indexOf("↑"), "rate sits left of ↑input in the same row");

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
  frames.scrolled = await wheelUntil(/below of \d+ lines/, 20_000, "wheel scrolls the reasoning window");
  assert.ok(!visibleRows(frames.scrolled).some((l) => l.includes("PCX_THINK_HEAD")), "one wheel line up still clips the very beginning");

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
  frames.refollowed = await refollow(20_000);
  assert.ok(visibleRows(frames.refollowed).some((l) => l.includes("PCX_THINK_TAIL")), "newest rows back in view");

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
  assert.match(hotkeys, /Expand\/collapse the codex-todo widget/, "codex-todo shortcut registered in the same session");

  console.log("PASS: real TUI frames verified —");
  console.log("  idle footer:  model/effort/provider/capacity visible");
  console.log(hasGit ? "  git changes:  session Δ +8 -2 absolute, commit clears, post-commit edits re-count" : "  git changes:  not asserted (git unavailable)");
  console.log("  thinking:     6-row peek + hint while streaming; 1 click folds/opens, 2 clicks expand, wheel scrolls the window");
  console.log("  output speed: measured tok/s rendered left of ↑input (real stream window)");
  console.log("  live Working: Working… + elapsed + live tokens mid-stream");
  console.log("  thinking:     elapsed + thinking timers grow together; summary 'thought for'");
  console.log("  auto-collapse: 'Thought for Ns' label; 1 click = 6-row peek window, 2 clicks = full body");
  console.log("  peek window:  live reasoning clipped to the newest rows; wheel scrolls it in place");
  console.log("  tool run:     real bash output, summary still Worked");
  console.log("  codex-todo:   mock model calls the todo tool -> \"Todos 0/1 done\" panel + store on disk");
  console.log("  todo panel:   a left click expands it to all 5 tasks, a second click collapses it back to 3 rows");
  console.log("  extensions:   /hotkeys lists the vendored codex-conversion + codex-todo shortcuts (live registrations)");
  console.log("  provider err: summary Failed after (real terminal evidence)");
  console.log(`  selection:    SGR mouse drag + Ctrl+C → exact copy, ${copyStats[8]} chars (exact=${copyStats[2]} mixed=${copyStats[3]} native=${copyStats[4]})`);
  console.log("  margins:      fullscreen side gutters applied (margin=2), transcript inset verified");
} finally {
  try { execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "pipe" }); } catch { /* already gone */ }
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
}
