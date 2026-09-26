// Real Pi/tmux terminal journeys against a local mock provider and clipboard sink.
// Requires pi on PATH (or PI_BIN), tmux, and Git for E1. Every selected journey is required.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { visibleWidth } from "@earendil-works/pi-tui";

const PI_BIN = process.env.PI_BIN ?? execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
execFileSync(PI_BIN, ["--version"], { stdio: "ignore" });
execFileSync("tmux", ["-V"], { stdio: "ignore" });

// --strict remains accepted; the default invocation now has the same requirements.
const JOURNEYS = ["E1", "E2", "E3", "E4", "E5", "E6"];
const requested = process.argv.find((arg) => arg.startsWith("--journey="))?.slice("--journey=".length);
if (requested && !JOURNEYS.includes(requested)) throw new Error(`Unknown PTY journey: ${requested}`);
const selected = new Set(requested ? [requested] : JOURNEYS);
if (process.env.PCX_PTY_SKIP_WHEEL === "1") throw new Error("PTY verification cannot skip wheel scenarios");
if (selected.has("E1")) execFileSync("git", ["--version"], { stdio: "ignore" });

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-pty-"));
// Setup below opens files and a server before the main scenario's try/finally.
// Keep the isolated directory owned even if bootstrap fails early.
process.once("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME_DIR = path.join(ROOT, "home");
// pi reads models.json/settings.json from $HOME/.pi/agent (PI_AGENT_DIR does
// NOT relocate them — verified against pi 0.85.1).
const AGENT_DIR = path.join(HOME_DIR, ".pi", "agent");
let WORKSPACE = path.join(ROOT, "E1");
const CLIPBOARD_SINK = path.join(ROOT, "clipboard.jsonl");
const CLIPBOARD_READY = path.join(ROOT, "clipboard-ready");
fs.mkdirSync(AGENT_DIR, { recursive: true });
const sinkExtension = path.join(AGENT_DIR, "extensions", "clipboard-sink.ts");
fs.mkdirSync(path.dirname(sinkExtension), { recursive: true });
fs.writeFileSync(sinkExtension, `import { appendFileSync, writeFileSync } from "node:fs";
import { TuiAltScreen } from "@earendil-works/pi-tui";
const prototype = TuiAltScreen.prototype;
const original = Object.getOwnPropertyDescriptor(prototype, "copyTextToClipboard");
if (!original || typeof original.value !== "function") throw new Error("clipboard sink: missing Pi TUI copy method");
const capture = async function (text) {
  appendFileSync(process.env.PCX_PTY_CLIPBOARD_SINK, JSON.stringify({ text }) + "\\n");
  return true;
};
Object.defineProperty(prototype, "copyTextToClipboard", { ...original, value: capture });
writeFileSync(process.env.PCX_PTY_CLIPBOARD_READY, "ready");
export default function clipboardSink(pi) {
  pi.on("session_shutdown", () => {
    if (Object.getOwnPropertyDescriptor(prototype, "copyTextToClipboard")?.value === capture)
      Object.defineProperty(prototype, "copyTextToClipboard", original);
  });
}
`);
// Two discovered skills let E6 check real composer expansion at the provider.
for (const probe of ["pcx-pty-mux-a", "pcx-pty-mux-b"]) {
  const dir = path.join(AGENT_DIR, "skills", probe);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${probe}\ndescription: pty probe\n---\n${probe} probe body.\n`);
}
// HOME isolation: the real ~/.pi/agent user extensions (including the
// published copy of THIS extension) must not shadow the code under test.
const ISOLATED_ENV = { ...process.env, HOME: HOME_DIR };

const toolCall = (id, name, args, index = 0) => ({
  index, id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
// ---------- mock provider ----------
// Journeys supply response data; this transport never interprets prompts or tool history.
let lastRequest;
const responses = [];
const unexpectedRequests = [];
let retryResponse;
const messageText = (message) => typeof message?.content === "string"
  ? message.content : (message?.content ?? []).map((part) => part.text ?? "").join("\n");
const lastUserText = () => messageText(lastRequest?.messages?.findLast((message) => message.role === "user"));
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      lastRequest = parsed;
      const response = responses.shift() ?? retryResponse;
      if (!response) unexpectedRequests.push(parsed);
      if (!response || response.error) {
        retryResponse = response; // A planned provider failure also answers Pi's retries.
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: response?.error ?? "Unexpected PTY provider request" } }));
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
      const chunk = (delta, finish_reason = null) =>
        send({ ...base, choices: [{ index: 0, delta, finish_reason }] });
      const finish = (reason) => {
        chunk({}, reason);
        send({ ...base, choices: [], usage });
        res.end("data: [DONE]\n\n");
      };
      const streamField = async (field, text, size, interval) => {
        for (let offset = 0; offset < text.length; offset += size) {
          await delay(interval);
          chunk({ [field]: text.slice(offset, offset + size) });
        }
      };
      if (response.calls) {
        chunk({ role: "assistant", tool_calls: response.calls });
        await delay(400);
        finish("tool_calls");
        return;
      }
      if (response.reasoning) {
        await streamField("reasoning_content", response.reasoning, 80, 300);
        await delay(300);
      }
      chunk({ role: "assistant", content: "" });
      await streamField("content", response.text, response.streamed ? 2 : response.text.length, response.streamed ? 250 : 0);
      await delay(200);
      finish("stop");
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
// Avoid the vendor alt+q/Pi built-in collision, which adds an extension-issues banner.
fs.writeFileSync(path.join(AGENT_DIR, "pi-codex-conversion.json"), JSON.stringify({
  ui: { backgroundShellPrevShortcut: "alt+u" },
}));
// Suppress the vendor first-run notice so mouse coordinates target the tested rows.
fs.writeFileSync(path.join(AGENT_DIR, "howaboua-pi-stuff-changelog.json"), JSON.stringify({ suppress: true }));
// Install THIS repo (the code under test), not the published one.
execFileSync(PI_BIN, ["install", path.resolve(new URL("..", import.meta.url).pathname)], {
  env: ISOLATED_ENV,
  stdio: "pipe",
});

// ---------- tmux driving ----------
const SESSION = `pcx-pty-${process.pid}`;
const tmux = (args, options) => execFileSync("tmux", ["-L", SESSION, ...args], options);
/** Both views capture the same scrollback; ANSI is needed only for visual attributes. */
const capture = (styled = false) => {
  try {
    return tmux(["capture-pane", "-p", ...(styled ? ["-e"] : []), "-t", SESSION, "-S", "-200"], { encoding: "utf8" });
  } catch {
    return "";
  }
};
const sendKeys = (keys) => tmux(["send-keys", "-t", SESSION, ...keys]);
const type = (text) => sendKeys(["-l", text]);
const submit = (text) => {
  type(text);
  sendKeys(["Enter"]);
};
const waitUntil = async (check, timeoutMs, label, intervalMs = 300) => {
  const start = Date.now();
  for (;;) {
    const frame = capture();
    const found = check(frame);
    if (found !== undefined) return found;
    if (Date.now() - start > timeoutMs) assert.fail(`timeout waiting for ${label}:\n${frame.slice(-2200)}`);
    await delay(intervalMs);
  }
};
const waitFor = (pattern, timeoutMs, label) =>
  waitUntil((frame) => pattern.test(frame) ? frame : undefined, timeoutMs, label);
const copiedTexts = () => fs.existsSync(CLIPBOARD_SINK)
  ? fs.readFileSync(CLIPBOARD_SINK, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).text)
  : [];
const waitForSink = (previous) =>
  waitUntil(() => copiedTexts().length > previous ? true : undefined,
    10_000, "Ctrl+C to reach the isolated clipboard sink", 100);
/** A settled line must follow this request's marker, not an older scrollback hit. */
const waitForAfter = (pattern, marker, timeoutMs, label) =>
  waitUntil((frame) => {
    const markerAt = frame.lastIndexOf(marker);
    if (markerAt < 0) return undefined;
    const fresh = frame.slice(markerAt + marker.length);
    return pattern.test(fresh) ? fresh : undefined;
  }, timeoutMs, `${label} after ${marker}`);

// Shared viewport/mouse helpers: capture-pane includes scrollback, so mouse
// rows are SCREEN rows — always index through the last pane_height lines.
const paneSize = () => {
  const out = tmux(["display-message", "-p", "-t", SESSION, "#{pane_width} #{pane_height}"], { encoding: "utf8" });
  const [w, h] = out.trim().split(" ").map(Number);
  return { w, h };
};
const visibleRows = (frame) =>
  (frame.endsWith("\n") ? frame.slice(0, -1) : frame).split("\n").slice(-paneSize().h);
/** Wait until `pattern` is no longer on screen (inverse of waitFor). */
const waitGone = (pattern, timeoutMs, label) =>
  waitUntil((frame) => !pattern.test(visibleRows(frame).join("\n")) ? true : undefined,
    timeoutMs, `${label} to disappear`, 200);
/** Wait until two consecutive captures are identical (streaming output settled). */
const waitStableFrame = (timeoutMs = 15_000) => {
  let previous;
  return waitUntil((frame) => {
    if (frame === previous) return frame;
    previous = frame;
  }, timeoutMs, "a stable frame", 250);
};
/** 0-based screen row of the first visible line matching `pattern` (-1 when absent). */
const rowOf = (pattern) => visibleRows(capture()).findIndex((line) => pattern.test(line));
const cellOf = (rowText, needle, offset = 0) => {
  // Mouse coordinates use Pi's terminal columns, including combining characters.
  const at = rowText.indexOf(needle) + offset;
  return visibleWidth(rowText.slice(0, at)) + 1;
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
  await delay(80);
  clickRow(rowIndex0, col);
};

const visibleText = () => visibleRows(capture()).join("\n");
const waitForVisible = (pattern, timeoutMs, label) =>
  waitUntil((frame) => pattern.test(visibleRows(frame).join("\n")) ? frame : undefined,
    timeoutMs, `${label} (visible rows only)`);

/** (Re)start the TUI in the same tmux session — the restart stage uses this. */
const bootPi = () => {
  try { tmux(["kill-session", "-t", SESSION], { stdio: "pipe" }); } catch { /* not running */ }
  tmux(["new-session", "-d", "-s", SESSION, "-x", "120", "-y", "35", "-c", WORKSPACE]);
  tmux(["set-option", "-g", "mouse", "on"]);
  tmux(["set-option", "-g", "extended-keys", "on"]);
  tmux(["set-option", "-g", "set-clipboard", "off"]);
  tmux(["set-option", "-g", "allow-passthrough", "off"]);
  // Keep asynchronous update banners from moving mouse targets.
  sendKeys(["-l", `env -u DISPLAY -u WAYLAND_DISPLAY -u WSL_INTEROP -u WSL_DISTRO_NAME -u NO_COLOR FORCE_COLOR=3 COLORTERM=truecolor HOME=${HOME_DIR} PI_SKIP_VERSION_CHECK=1 PCX_PTY_CLIPBOARD_SINK=${CLIPBOARD_SINK} PCX_PTY_CLIPBOARD_READY=${CLIPBOARD_READY} ${PI_BIN}`]);
  sendKeys(["Enter"]);
};
const startJourney = async (name) => {
  assert.equal(responses.length, 0, `${name}: the preceding journey consumed its planned responses`);
  retryResponse = undefined;
  // Distinct names isolate journeys; reusing E5 restarts its real persisted workspace.
  WORKSPACE = path.join(ROOT, name);
  fs.mkdirSync(WORKSPACE, { recursive: true });
  if (name === "E1") {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: WORKSPACE, stdio: "ignore" });
    fs.writeFileSync(path.join(WORKSPACE, "tracked.txt"), "one\ntwo\nthree\n");
    execFileSync("git", ["add", "-A"], { cwd: WORKSPACE, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: WORKSPACE, stdio: "ignore" });
    fs.writeFileSync(path.join(WORKSPACE, "preexisting.txt"), "old\nwork\nhere\nfour\n");
  }
  fs.rmSync(CLIPBOARD_READY, { force: true });
  bootPi();
  const frame = await waitFor(/ctx [0-9—]/, 30_000, `${name} idle footer`);
  assert.ok(fs.existsSync(CLIPBOARD_READY), `${name}: isolated clipboard sink installed`);
  assert.doesNotMatch(frame, /\[Extension issues\]/, `${name}: extensions load`);
  return frame;
};

let copiedChars = 0;
try {
  if (selected.has("E1")) {
    // E1: real idle footer and editor placement.
    const idle = await startJourney("E1");
    // Extension issues also catch missing vendor assets and shortcut collisions.
    assert.ok(!/Could not read the @howaboua\/pi-codex-conversion changelog/.test(idle), "vendored CHANGELOG.md is present");
    assert.match(idle, /pcx-mock-model · high · pcx-mock/, "footer: model/effort/provider");
    assert.match(idle, /ctx 0\/1\.0M · 0%/, "footer: context usage");
    assert.match(idle, /Ask anything\.\.\./, "composer placeholder on the gray surface");
    assert.match(idle, /(^|\n)\s*> /, "`> ` prompt prefix on the first input row");
    const orderedFooter = idle.slice(idle.indexOf("pcx-mock-model"));
    assert.ok(orderedFooter.indexOf("(main)") > orderedFooter.indexOf("pcx-mock-model"), "path/branch follows model/provider below editor");
    assert.ok(orderedFooter.indexOf("ctx 0/1.0M") > orderedFooter.indexOf("(main)"), "context follows path");
    assert.ok(idle.indexOf("Ask anything...") < idle.lastIndexOf("pcx-mock-model"),
      `footer lives below the editor: ${JSON.stringify(idle.slice(-550))}`);
    // Git parser and HEAD transitions have focused tests; this proves footer wiring.
    await waitFor(/\(main\) \+4 -0/, 15_000, "existing work appears in the footer");
    fs.writeFileSync(path.join(WORKSPACE, "tracked.txt"), "one\ntwo\n");
    await waitForVisible(/\(main\) \+4 -1/, 15_000, "running Git poll updates the footer");
    const coloredFooter = capture(true);
    assert.match(coloredFooter, /\x1b\[32m \+4/, "added lines use diff green");
    assert.match(coloredFooter, /\x1b\[31m -1/, "removed lines use diff red");

  }
  if (selected.has("E2")) {
    await startJourney("E2");
    responses.push(
      { text: "PCX_OK", streamed: true },
      { calls: [toolCall("call_pcx1", "bash", { command: "echo PCX_TOOL_MARK" })] },
      { text: "PCX_TOOL_ACK" },
      { error: "PCX forced provider failure" },
    );
    // E2: live Working, completed usage, one real tool, and a provider failure.
    submit("say PCX_OK");
    const working = await waitFor(/• Working \(/, 15_000, "live Working line");
    assert.match(working, /• Working \(\d+s · esc to interrupt\)/, "Codex status rhythm with elapsed");
    assert.match(working, /\d+s/, "elapsed seconds ticking");
    const summary = await waitForAfter(/Worked for/, "PCX_OK", 30_000, "Worked summary");
    // Pi normalizes usage: input = uncached prompt tokens (1200 - 1000 cached
    // = 200), cacheRead = 1000. Arrows follow Pi's ↑=input ↓=output grammar.
    assert.match(summary, /↑200/, "interaction input from the final usage");
    assert.match(summary, /↓80/, "interaction output from the final usage");
    // The mock's paced chunks give the footer a measured speed window.
    const speedRow = summary.split("\n").find((l) => l.includes("tok/s"));
    assert.ok(speedRow, `footer shows the measured output speed:\n${summary.slice(-800)}`);
    assert.match(speedRow, /\d+(\.\d+)? tok\/s/, "rate carries its unit");
    assert.ok(summary.includes("↑") && summary.lastIndexOf("tok/s") > summary.lastIndexOf("↑"),
      "rate follows input/output in the footer");

    // A real bash call still ends Worked.
    submit("please PCX_TOOL now");
    await waitForAfter(/Worked for/, "PCX_TOOL_MARK", 60_000, "post-tool Worked summary");
    const toolResult = lastRequest.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_pcx1");
    assert.equal(lastUserText(), "please PCX_TOOL now");
    assert.equal(messageText(toolResult).trim(), "PCX_TOOL_MARK", "the provider receives stdout from the real bash execution");

    // Provider error must end Failed.
    submit("please PCX_FAIL now");
    await waitForAfter(/Failed after/, "PCX_FAIL", 60_000, "Failed summary");
    assert.equal(lastUserText(), "please PCX_FAIL now");

  }
  if (selected.has("E3")) {
    await startJourney("E3");
    responses.push({
      reasoning: `PCX_THINK_HEAD ${"the transcript window keeps the newest rows ".repeat(20)}PCX_THINK_TAIL`,
      text: "PCX_THINK_DONE",
    });
    // E3: live thinking, peek/full/collapse gestures, and wheel movement.
    submit("please PCX_THINK now");
    await waitFor(/thinking \d+s/, 30_000, "live thinking timer");
    // Screen-only checks keep old scrollback hints from satisfying a live peek.
    const livePeek = await waitForVisible(/scroll · double-click for all/, 30_000, "live thinking peek window");
    assert.ok(!visibleRows(livePeek).some((l) => l.includes("PCX_THINK_HEAD")), "peek follows the newest rows (head clipped away)");
    // Wheel input waits for the settled block so its target row stays stable.
    await waitForAfter(/thought for \d+s/, "PCX_THINK_DONE", 30_000, "closed thinking in summary");
    assert.equal(lastUserText(), "please PCX_THINK now");

    // One click, one wheel event and one double-click exercise terminal routing.
    const collapsed = await waitFor(/Thought for \d+s/, 30_000, "auto-collapsed thinking label");
    assert.ok(!visibleRows(collapsed).some((l) => l.includes("PCX_THINK_TAIL")), "reasoning body hidden while collapsed");

    const summaryRow = rowOf(/Thought for \d+s/);
    assert.ok(summaryRow >= 0, "collapsed thinking is visible before one click");
    clickRow(summaryRow, 3);
    const peeked = await waitForVisible(/scroll · double-click for all/, 25_000, "one click opens peek");
    assert.ok(!visibleRows(peeked).some((l) => l.includes("PCX_THINK_HEAD")), "peek window clips the head of the reasoning");
    assert.ok(visibleRows(peeked).some((l) => l.includes("PCX_THINK_TAIL")), "peek window shows the newest rows");

    // One input only: retries would hide a missed terminal gesture.
    const hint = rowOf(/scroll · double-click for all/);
    assert.ok(hint >= 0, "peek hint is visible before the wheel input");
    wheelRow(hint + 1, 40, true);
    const scrolled = await waitForVisible(/below of \d+ lines/, 10_000, "one wheel-up moves the peek window");
    assert.ok(!visibleRows(scrolled).some((line) => line.includes("PCX_THINK_HEAD")));

    const peekRow = rowOf(/scroll · double-click for all/);
    assert.ok(peekRow >= 0, "peek is visible before one double-click");
    // The rail avoids Pi's separate word-selection gesture on Markdown text.
    await doubleClickRow(peekRow, 3);
    await waitForVisible(/PCX_THINK_HEAD/, 30_000, "one double-click opens full thinking");
    assert.ok(!/scroll · double-click for all/.test(visibleText()), "fully expanded body carries no peek hint");

  }
  if (selected.has("E4")) {
    await startJourney("E4");
    const selectReply = "SELECT_BEGIN_MARK\n这一段很长的中文回答会在终端宽度下软折行显示成多个屏幕行，复制时应当保持为一行逻辑文本，不添加多余的换行或空格。\nselect alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\nSELECT_END_MARK";
    const history = Array.from({ length: 40 }, (_, i) => `SCROLL_FILLER_${i}`).join("\n\n");
    responses.push({ text: `${history}\n\n${selectReply}` }, { text: "PCX_DRAFT_ACK" }, { text: "PCX_AFTER_CLEAR_ACK" });
    // E4: real SGR drag and Ctrl+C through the isolated clipboard sink.
    submit("please PCX_SELECT now");
    await waitForAfter(/Worked for/, "SELECT_END_MARK", 60_000, "selectable reply is settled");
    assert.equal(lastUserText(), "please PCX_SELECT now");
    type("PCX_DRAFT_STAYS");
    await waitForVisible(/PCX_DRAFT_STAYS/, 10_000, "selection keeps a typed draft in the composer");
    const selectRows = visibleRows(capture());
    assert.ok(selectRows.some((line) => line.includes("SCROLL_FILLER_39")), "the preceding history reaches the viewport");
    assert.ok(!selectRows.some((line) => line.includes("SCROLL_FILLER_0")), "copy runs below the clipped history");
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
    // Reverse video proves the one drag selected visible reply cells.
    await waitUntil(() => capture(true).split("\n").some((line) =>
      line.includes("\u001b[7m") && /SELECT_|alpha beta gamma/.test(line)) ? true : undefined,
      10_000, "the drag establishes a reverse-video selection over the reply");
    // One Ctrl+C must copy silently while preserving the draft and the app.
    const copiesBeforeCtrlC = copiedTexts().length;
    sendKeys(["C-c"]);
    await waitForSink(copiesBeforeCtrlC);
    assert.match(visibleText(), /PCX_DRAFT_STAYS/, "Ctrl+C keeps the unsent draft");
    const copied = copiedTexts();
    assert.equal(copied.length, copiesBeforeCtrlC + 1, "one Ctrl+C adds one clipboard write");
    assert.equal(copied.at(-1), selectReply, "the real Ctrl+C path writes exact logical text to the local sink");
    copiedChars = copied.at(-1).length;
    sendKeys(["Enter"]);
    await waitFor(/PCX_DRAFT_ACK/, 30_000, "the preserved draft reaches the provider");
    assert.equal(lastUserText(), "PCX_DRAFT_STAYS", "the preserved draft is sent without modification");

    assert.match(beginLine, /^\s{3,}SELECT_BEGIN_MARK/,
      "selection starts inside the inset transcript row");
    await waitForAfter(/Worked for/, "PCX_DRAFT_ACK", 30_000, "draft request settles before testing clear");
    type("PCX_CLEAR_DRAFT");
    await waitForVisible(/PCX_CLEAR_DRAFT/, 10_000, "the new draft is visible without a selection");
    sendKeys(["C-c"]);
    await waitGone(/PCX_CLEAR_DRAFT/, 10_000, "Ctrl+C clears a draft without selection");
    assert.equal(copiedTexts().length, copied.length, "clearing a draft does not write the clipboard");
    submit("PCX_APP_STILL_ALIVE");
    await waitForAfter(/Worked for/, "PCX_AFTER_CLEAR_ACK", 30_000, "the request after clear settles");
    assert.equal(lastUserText(), "PCX_APP_STILL_ALIVE", "Pi sends the new draft after clearing without a selection");

  }
  if (selected.has("E5")) {
    await startJourney("E5");
    responses.push(
      { calls: [toolCall("call_pcx3", "todo", { action: "add", tasks: [1, 2, 3, 4, 5].map((id) => ({ title: `pty task ${id}` })) })] },
      { text: "PCX_TODO_ACK" },
      { calls: [1, 2, 3, 4, 5].map((id, index) => toolCall(`call_pcxd${id}`, "todo", { action: "complete", id, evidence: `pty completion ${id}` }, index)) },
      { text: "PCX_TODO_DONE_ACK" },
      { text: "PCX_FOLD_ACK" },
    );
    // E5: a real todo tool call installs the persistent panel.
    submit("please PCX_TODO now");
    const todoFrame = await waitForVisible(/Todos 0\/5 done ▾ · click to expand/, 60_000, "collapsed todo panel");
    assert.equal(lastUserText(), "please PCX_TODO now");
    assert.ok(todoFrame.includes("pty task 1"), "widget shows the task row");
    assert.ok(fs.existsSync(path.join(WORKSPACE, ".pi", "codex-todos", "tasks.json")), "store persisted in the workspace");

    const collapsedTodoRow = rowOf(/Todos 0\/5 done/);
    assert.ok(collapsedTodoRow >= 0, "todo header is visible before one click");
    clickRow(collapsedTodoRow + 2, 12);
    await waitForVisible(/click to collapse/, 15_000, "left click expands the panel");
    assert.match(visibleText(), /pty task 5/, "one click exposes the tail task");
    const header = rowOf(/Todos 0\/5 done/);
    sendKeys(["-H", ...sgrSeq(2, 12, header + 3)]);
    await waitGone(/Todos 0\/5 done/, 15_000, "right press hides the panel");
    sendKeys(["-H", ...sgrSeq(2, 12, header + 3, true)]);
    submit("/todos");
    await waitForVisible(/Todos 0\/5 done ▴/, 30_000, "/todos restores the expanded panel");
    const restored = rowOf(/Todos 0\/5 done/);
    clickRow(restored + 2, 12);
    await waitForVisible(/Todos 0\/5 done ▾ · click to expand/, 15_000,
      "left click still reaches the panel after the unclaimed right press");

    // A real input advances the turn; completed rows fold on the next prompt.
    submit("please PCX_TODO_DONE now");
    const allDone = await waitForVisible(/Todos 5\/5 done/, 60_000, "the panel reports every task complete");
    assert.equal(lastUserText(), "please PCX_TODO_DONE now");
    assert.ok(allDone.includes("pty task 5"), "the ✓ rows are still listed on the turn that completed them");

    submit("PCX_FOLD_NOW");
    await waitGone(/Todos \d+\/\d+ done/, 30_000, "the finished panel folds away on the next prompt");
    assert.ok(!visibleText().includes("Todos 5/5 done"), "no history is left on screen");
    await waitForAfter(/Worked for/, "PCX_FOLD_ACK", 30_000, "fold prompt finishes before restart");

    // Restart with the real completed store; the panel must stay folded.
    const storePath = path.join(WORKSPACE, ".pi", "codex-todos", "tasks.json");
    const stored = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.equal(stored.tasks.length, 5, "the real todo tool persisted the five tasks");
    assert.ok(stored.tasks.every((task) => task.status === "complete" && task.completedAt != null),
      "the restart reads real completed tasks, not a rewritten fixture");
    const finishedCount = stored.tasks.length;

    await startJourney("E5");
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
    submit("/todos");
    await waitFor(new RegExp(`Todos: ${finishedCount}/${finishedCount} done`), 30_000, "/todos lists the finished tasks after the restart");
    assert.ok(!/Todos \d+\/\d+ done/.test(visibleText()), "/todos does not resurrect the folded panel");

  }
  if (selected.has("E6")) {
    await startJourney("E6");
    responses.push({ text: "MUX_ACK" });
    // Both triggers reopen a dead menu within the same two-skill draft.
    type("/skill:pcx-pty-mux-a");
    await waitForVisible(/pty probe/, 15_000, "first-token menu before Escape");
    sendKeys(["Escape"]);
    await waitGone(/pty probe/, 4_000, "first-token menu after Escape");
    type(" ");
    type("/");
    await waitForVisible(/pty probe/, 15_000, "the bare second / pops the menu with a DEAD editor state");
    sendKeys(["Escape"]);
    await waitGone(/pty probe/, 4_000, "second-token menu after Escape");
    sendKeys(["BSpace"]); // Replace only the bare slash, keeping the first skill.
    type("￥");
    await waitForVisible(/pty probe/, 15_000, "bare second ￥ reopens the menu");
    type("pcx-pty-mux-b");
    await waitUntil((frame) => {
      const choices = visibleRows(frame).filter((line) => line.includes("pty probe"));
      return choices.length === 1 && choices[0].includes("pcx-pty-mux-b") ? frame : undefined;
    }, 15_000, "the filtered menu contains only the second skill");
    sendKeys(["Tab"]); // accept the selected pcx-pty-mux-b
    await delay(300);
    submit("MUX_TAIL_MARKER");
    await waitFor(/MUX_ACK/, 30_000, "provider acknowledges the skill request");
    const text = lastUserText();
    for (const name of ["pcx-pty-mux-a", "pcx-pty-mux-b"]) {
      assert.match(text, new RegExp(`<skill name="${name}"`), `${name} reaches the provider as a parsed skill block`);
      assert.ok(text.includes(`${name} probe body.`), `${name} body reaches the provider`);
    }
    assert.ok(text.includes("MUX_TAIL_MARKER"), "the request retains the literal tail");
    assert.doesNotMatch(text, /\/skill:pcx-pty-mux|￥pcx-pty-mux/, "the request contains no unexpanded skill triggers");

    // The host folds one leading block; later skills must nest inside it.
    await waitForVisible(/\[skill\] pcx-pty-mux-a/, 15_000, "multi-skill prompt folds into one [skill] entry");
    assert.ok(!/probe body\./.test(visibleText()), "skill bodies stay collapsed inside the folded entry");
    // One label click proves terminal hit-testing reaches the native skill component.
    await waitStableFrame();
    const skillRows = visibleRows(capture());
    const skillRow = skillRows.findIndex((line) => /\[skill\] pcx-pty-mux-a/.test(line));
    assert.ok(skillRow >= 0, "the folded skill label is visible before the click");
    clickRow(skillRow, cellOf(skillRows[skillRow], "[skill]"));
    await waitForVisible(/probe body\./, 20_000, "one click expands the skill entry");

  }
  assert.equal(responses.length, 0, "all planned responses reached the real host");
  assert.deepEqual(unexpectedRequests, [], "journeys must account for every provider request");
  console.log(`PASS: ${[...selected].join(", ")}`);
  if (selected.has("E4")) console.log(`  clipboard: isolated sink received ${copiedChars} exact characters`);
} finally {
  try { tmux(["kill-session", "-t", SESSION], { stdio: "pipe" }); } catch { /* already gone */ }
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
}
