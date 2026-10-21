import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { SubagentViewer } from "../../src/subagents/ui/viewer.ts";
import { sgr, theme } from "../helpers.mjs";
import { altScreen, container, screenLines } from "../helpers/ui-fixtures.mjs";

initTheme("dark", false);

const defaultAgents = ["reader", "writer", "tester"].map(name => ({ id: name, name, state: "running" }));
const textMessage = text => ({ role: "assistant", content: [{ type: "text", text }] });
const inspection = (agentId, messages = [], options = {}) => ({
  agent: { name: agentId, state: "running" },
  messages: messages.map((message, id) => ({ id: String(id), message })),
  session_file: `${agentId}.jsonl`,
  next_cursor: 1,
  has_more: false,
  ...options,
});

function popup(t, options = {}) {
  const agents = options.agents ?? (() => defaultAgents);
  const tui = options.tui ?? { terminal: { rows: 80 }, requestRender() {} };
  const calls = [], closes = [];
  const inspect = options.inspect ?? (async (agentId, after) => {
    const name = agents().find(agent => agent.id === agentId)?.name ?? agentId;
    return inspection(agentId, after === 0
      ? options.messages?.[agentId] ?? [textMessage(`CONTENT_${agentId}`)] : [], {
      agent: { name, state: "running" },
    });
  });
  const viewer = new SubagentViewer(
    options.agentId ?? "reader", theme, tui,
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o" },
      "app.thinking.toggle": { defaultKeys: "ctrl+t" },
    }),
    value => closes.push(value), new AbortController(),
    (agentId, after, signal) => {
      calls.push({ agentId, after, signal });
      return inspect(agentId, after, signal);
    },
    undefined, agents,
  );
  t.after(() => viewer.dispose());
  const rows = (width = 90) => viewer.render(width).map(stripVTControlCharacters);
  const mouse = (width, x, y, options = {}) => viewer.handleMouse({
    type: "click", button: "left", x, y, screenX: x, screenY: y,
    width, height: Math.floor(tui.terminal.rows * 0.7), ...options,
  });
  const clickText = (label, width = 90, options = {}) => {
    const { header = false, ...event } = options;
    const rendered = rows(width);
    const y = header ? 1 : rendered.findIndex(row => row.includes(label));
    const index = rendered[y]?.indexOf(label) ?? -1;
    assert.ok(index >= 0, `visible mouse target ${label}`);
    return mouse(width, visibleWidth(rendered[y].slice(0, index)), y, {
      ...(event.button === "right" && process.platform !== "win32" ? { type: "press" } : {}), ...event,
    });
  };
  return { viewer, calls, closes, rows, mouse, clickText };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("conversation popup keeps native click folds through refresh and scrolling", async t => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: Array.from({ length: 18 }, (_, i) => `THINK_${i + 1}`).join("\n\n") },
        { type: "toolCall", id: "shell", name: "bash", arguments: { command: "printf 'hello world'" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "shell",
      toolName: "bash",
      content: [{ type: "text", text: Array.from({ length: 14 }, (_, i) => `OUTPUT_${i + 1}`).join("\n") }],
    },
  ];
  let sent = false,
    refreshes = 0;
  const tui = { terminal: { rows: 80 }, requestRender() {} };
  const viewer = new SubagentViewer(
    "agent",
    { fg: (_color, text) => text, bold: (text) => text },
    tui,
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o" },
      "app.thinking.toggle": { defaultKeys: "ctrl+t" },
    }),
    () => {},
    new AbortController(),
    async () => {
      refreshes++;
      const page = {
        agent: { name: "reader", state: "running" },
        messages: sent ? [] : messages.map((message, id) => ({ id: String(id), message })),
        session_file: "saved.jsonl",
        next_cursor: 1,
        has_more: false,
      };
      sent = true;
      return page;
    },
    undefined,
    () => [{ id: "agent", name: "reader", state: "running" }],
  );
  t.after(() => viewer.dispose());
  await delay(0);
  const rows = () => viewer.render(90).map(stripVTControlCharacters);
  const click = (label, button = "left") => {
    const y = rows().findIndex(row => row.includes(label)); assert.ok(y >= 0, label);
    const type = button === "right" && process.platform !== "win32" ? "press" : "click";
    return viewer.handleMouse({ type, button, x: 3, y, screenX: 3, screenY: y, width: 90, height: 56 });
  };
  assert.ok(!rows().some(row => row.includes("OUTPUT_7")));
  assert.equal(click("Ran").handled, true);
  assert.ok(rows().some(row => row.includes("OUTPUT_7")));
  click("Ran"); assert.ok(!rows().some(row => row.includes("OUTPUT_7")));
  click("Thought");
  assert.ok(rows().some(row => row.includes("THINK_18")), "left click opens the same tail preview immediately as the main transcript");
  assert.ok(!rows().some(row => row.includes("THINK_1 ")));
  click("THINK_18");
  assert.ok(!rows().some(row => row.includes("THINK_18")));
  click("Thought"); click("THINK_18", "right");
  assert.ok(rows().some(row => row.includes("THINK_1 ")), "right click turns the preview into full thought text");
  const full = rows(); click("THINK_1 ");
  assert.deepEqual(rows(), full, "left leaves full thoughts unchanged");
  click("THINK_1 ", "right");
  assert.ok(!rows().some(row => row.includes("THINK_18")));
  click("Thought", "right");
  assert.ok(rows().some(row => row.includes("THINK_1 ")), "right also opens a collapsed thought directly");
  click("THINK_1 ", "right");
  assert.ok(!rows().some(row => row.includes("THINK_18")));
  viewer.handleInput("\u0014"); viewer.handleInput("\u0014"); click("Ran");
  const before = rows();
  while (refreshes < 2) await delay(20);
  assert.deepEqual(rows(), before, "refresh preserves each component's expansion choice");
  viewer.handleInput("\u000f"); assert.ok(rows().some(row => row.includes("OUTPUT_7")));
  viewer.handleInput("\u000f"); assert.ok(!rows().some(row => row.includes("OUTPUT_7")));
  tui.terminal.rows = 30; click("Ran"); viewer.handleInput("\u001b[F");
  click("OUTPUT_7"); assert.ok(!rows().some(row => row.includes("OUTPUT_7")), "scrolled output receives the correct native mouse coordinates");
  for (const width of [1, 4, 40]) assert.ok(viewer.render(width).every(row => visibleWidth(row) <= width));
});

test("conversation scrollbar tracks keys, wheel, pointer capture and resize without taking body columns", async t => {
  const tui = { terminal: { rows: 80 }, requestRender() {} };
  const { viewer, rows, mouse, clickText } = popup(t, { tui, messages: {
    reader: [textMessage(Array.from({ length: 100 }, (_, i) => `ROW_${i}`).join("\n\n"))],
  } });
  await nextTurn();
  const thumb = () => rows().flatMap((row, index) => row.endsWith("┃") ? [index] : []);
  const initial = thumb();
  assert.ok(initial.length > 0, "overflow has a visible right-edge scrollbar");
  assert.equal(initial.at(-1), rows().length - 3, "the initial follow-tail thumb reaches the body bottom");
  viewer.handleInput("\u001b[H");
  const top = thumb()[0];
  assert.equal(top, rows().findIndex(row => row.includes("assistant:")), "Home puts the thumb at the first body row");
  mouse(90, 3, top, { type: "wheel", button: "none", wheelDelta: 40 });
  assert.ok(thumb()[0] > top && thumb().at(-1) < initial.at(-1), "wheel updates the reading position");
  mouse(90, 89, rows().length - 3);
  assert.equal(thumb().at(-1), rows().length - 3, "clicking the lower track reaches the tail");
  assert.equal(mouse(90, 89, top, { type: "press" }).capture, true);
  assert.equal(thumb()[0], top, "pressing the upper track scrolls to the start");
  const below = rows().length + 20;
  assert.equal(mouse(90, -5, below, { type: "drag" }).handled, true);
  assert.equal(thumb().at(-1), rows().length - 3, "captured drag clamps outside the popup");
  assert.equal(mouse(90, -5, below, { type: "release" }).handled, true);
  assert.equal(mouse(90, -5, -1, { type: "drag" }), undefined, "release ends capture ownership");
  tui.terminal.rows = 40;
  assert.ok(thumb().length < initial.length, "resizing updates the thumb without changing the follow-tail anchor");
  assert.equal(thumb().at(-1), rows().length - 3);
  assert.equal(mouse(90, 89, thumb()[0], { type: "press" }).capture, true);
  assert.deepEqual(viewer.render(0), []);
  assert.equal(mouse(90, -5, -1, { type: "drag" }), undefined, "a hidden scrollbar cannot retain a drag");
  clickText("writer", 90, { header: true });
  await nextTurn();
  assert.deepEqual(thumb(), [], "a short tab has no scrollbar");
  for (const width of [1, 4, 5, 90]) assert.ok(viewer.render(width).every(row => visibleWidth(row) <= width));
});

test("one-row tabs keep close at the right border and only a left click closes", async t => {
  const { rows, mouse, closes } = popup(t);
  await nextTurn();
  const width = 90, header = rows(width)[1];
  assert.match(header, /\[reader\].*writer.*tester/);
  assert.match(header, /\[X\]│$/);
  assert.equal(visibleWidth(header), width);
  const x = width - 3, y = 1;
  assert.equal(mouse(width, x, y, { type: "press" }).handled, true, "claim primary press before Pi's selection fallback");
  for (const event of [
    { type: "release" }, { type: "drag" }, { type: "move" },
    { button: "right" }, { button: "middle" },
    { type: "wheel", button: "none", wheelDelta: 1 },
  ]) mouse(width, x, y, event);
  assert.deepEqual(closes, [], "press, release, drag, non-primary click and wheel never activate close");
  assert.equal(mouse(width, x, y).handled, true);
  assert.deepEqual(closes, [undefined]);
});

test("resizing to zero and narrow widths clears invisible tab and close hit targets", async t => {
  const { rows, mouse, calls, closes } = popup(t);
  await nextTurn();
  const wide = rows(90)[1];
  const oldTabX = visibleWidth(wide.slice(0, wide.indexOf("writer")));
  const initialCalls = calls.length;
  for (const width of [0, 1, 4, 5]) {
    const rendered = rows(width);
    assert.ok(rendered.every(row => visibleWidth(row) <= width), `rows fit ${width} columns`);
    if (width === 0) assert.deepEqual(rendered, []);
    if (width === 5) assert.match(rendered[1], /\[X\]│$/);
    mouse(width, oldTabX, 1);
    mouse(width, 87, 1);
    assert.equal(calls.length, initialCalls, `hidden old tab cannot switch at width ${width}`);
    assert.deepEqual(closes, [], `hidden old close cannot fire at width ${width}`);
  }
  mouse(5, 2, 0);
  mouse(5, 2, 2);
  mouse(5, 4, 1);
  assert.deepEqual(closes, [], "close is not a whole-header or border-row target");
  assert.equal(mouse(5, 2, 1).handled, true);
  assert.deepEqual(closes, [undefined], "the five-column header still has its visible close target");
});

test("q, Escape and Ctrl+C still close the tabbed popup", async t => {
  for (const key of ["q", "\u001b", "\u0003"]) {
    const { viewer, closes } = popup(t);
    await nextTurn();
    viewer.handleInput(key);
    assert.deepEqual(closes, [undefined], `close key ${JSON.stringify(key)}`);
    viewer.dispose();
  }
});

test("mouse and keyboard tab switches show the selected transcript and retain each scroll and fold choice", async t => {
  const readerMessages = [
    { role: "assistant", content: [
      { type: "thinking", thinking: Array.from({ length: 18 }, (_, i) => `READER_THOUGHT_${i + 1}`).join("\n\n") },
      { type: "toolCall", id: "shell", name: "bash", arguments: { command: "printf reader" } },
    ] },
    { role: "toolResult", toolCallId: "shell", toolName: "bash", content: [
      { type: "text", text: Array.from({ length: 14 }, (_, i) => `READER_OUTPUT_${i + 1}`).join("\n") },
    ] },
    textMessage(Array.from({ length: 60 }, (_, i) => `READER_LINE_${i + 1}`).join("\n\n")),
  ];
  const writerMessages = [
    { role: "assistant", content: [
      { type: "thinking", thinking: "WRITER_THOUGHT_PRIVATE" },
      { type: "toolCall", id: "writer-shell", name: "bash", arguments: { command: "printf writer" } },
    ] },
    { role: "toolResult", toolCallId: "writer-shell", toolName: "bash", content: [
      { type: "text", text: Array.from({ length: 14 }, (_, i) => `WRITER_OUTPUT_${i + 1}`).join("\n") },
    ] },
    textMessage(Array.from({ length: 60 }, (_, i) => `WRITER_LINE_${i + 1}`).join("\n\n")),
  ];
  const { viewer, rows, clickText } = popup(t, { messages: { reader: readerMessages, writer: writerMessages } });
  await nextTurn();
  rows();
  viewer.handleInput("\u001b[H");
  assert.ok(!rows().some(row => row.includes("READER_OUTPUT_10")));
  clickText("Thought", 90, { button: "right" });
  clickText("Ran");
  assert.ok(rows().some(row => row.includes("READER_THOUGHT_1 ")));
  assert.ok(rows().some(row => row.includes("READER_OUTPUT_10")));
  for (let i = 0; i < 3; i++) viewer.handleInput("\u001b[B");
  const readerView = rows();
  assert.ok(readerView.some(row => row.includes("READER_OUTPUT_10")), "expanded output is in the saved scrolled viewport");

  clickText("writer", 90, { header: true });
  await nextTurn();
  assert.match(rows()[1], /\[writer\]/);
  assert.ok(rows().some(row => row.includes("WRITER_LINE_60")), "new tabs start at their own transcript tail");
  assert.ok(!rows().some(row => /READER_(THOUGHT|OUTPUT|LINE)/.test(row)));
  viewer.handleInput("\u001b[H");
  assert.ok(!rows().some(row => row.includes("WRITER_OUTPUT_10")), "reader's manual fold choices do not become writer's defaults");
  viewer.handleInput("\u000f");
  assert.ok(rows().some(row => row.includes("WRITER_OUTPUT_10")));
  viewer.handleInput("\u000f");
  viewer.handleInput("\u0014");
  assert.ok(rows().some(row => row.includes("WRITER_THOUGHT_PRIVATE")));
  viewer.handleInput("\u0014");
  assert.ok(!rows().some(row => row.includes("WRITER_OUTPUT_10") || row.includes("WRITER_THOUGHT_PRIVATE")));
  for (let i = 0; i < 5; i++) viewer.handleInput("\u001b[B");
  const writerView = rows();
  assert.ok(!writerView.some(row => row.includes("WRITER_LINE_60")), "writer has a distinct saved scroll position");

  viewer.handleInput("\u001b[D");
  await nextTurn();
  assert.deepEqual(rows(), readerView, "left returns to reader's scroll and both native folds");
  viewer.handleInput("\t");
  await nextTurn();
  assert.deepEqual(rows(), writerView, "Tab returns to writer's independent scroll position");
  viewer.handleInput("\u001b[C");
  await nextTurn();
  assert.match(rows()[1], /\[tester\]/);
  assert.ok(rows().some(row => row.includes("CONTENT_tester")));
  viewer.handleInput("\u001b[Z");
  await nextTurn();
  assert.deepEqual(rows(), writerView, "Shift+Tab switches back without resetting the view");
});

test("only active agents become tabs; inactive history and a finished initial selection are excluded", async t => {
  const agents = [
    { id: "old-review", name: "old-review", state: "dormant" },
    { id: "old-tests", name: "old-tests", state: "idle" },
    defaultAgents[0],
    { id: "starting", name: "starting", state: "starting" },
    { id: "waiting", name: "waiting", state: "needs_input" },
    { id: "stopping", name: "stopping", state: "stopping" },
    { id: "closed", name: "closed", state: "closed" },
  ];
  const { rows, calls } = popup(t, { agentId: "old-review", agents: () => agents });
  await nextTurn();
  assert.match(rows()[1], /\[reader\].*starting.*waiting.*stopping/);
  assert.ok(!rows().some(row => /old-review|old-tests|closed/.test(row)));
  assert.ok(rows().some(row => row.includes("CONTENT_reader")));
  assert.deepEqual(calls.map(call => call.agentId), ["reader"], "inactive history is never inspected");
});

test("finished tabs disappear, selection moves to an active agent, and an empty source closes polling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let agents = defaultAgents.slice(0, 2);
  const lateReader = deferred();
  const { viewer, rows, calls, closes } = popup(t, {
    agents: () => agents,
    inspect: async (agentId, after) => agentId === "reader" && after > 0
      ? lateReader.promise : inspection(agentId, after === 0 ? [textMessage(`ACTIVE_${agentId}`)] : []),
  });
  await nextTurn();
  assert.match(rows()[1], /\[reader\].*writer/);
  t.mock.timers.tick(1_000);
  await nextTurn();
  const pending = calls.at(-1);
  assert.equal(pending.agentId, "reader");
  assert.equal(pending.signal.aborted, false);
  agents = [{ ...defaultAgents[0], state: "idle" }, ...defaultAgents.slice(1)];
  assert.match(rows()[1], /\[writer\].*tester/);
  await nextTurn();
  assert.equal(pending.signal.aborted, true, "finishing the selected agent cancels its pending read");
  assert.ok(!rows().some(row => row.includes("reader")));
  assert.ok(rows().some(row => row.includes("ACTIVE_writer")));
  lateReader.resolve(inspection("reader", [textMessage("LATE_FINISHED_READER")], { has_more: true }));
  await nextTurn();
  assert.ok(!rows().some(row => row.includes("LATE_FINISHED_READER")));
  agents = [defaultAgents[1]];
  assert.match(rows()[1], /\[writer\]/);
  assert.ok(!rows()[1].includes("tester"), "a non-selected finished tab is also removed");
  viewer.handleInput("\t");
  assert.equal(calls.filter(call => call.agentId === "writer").length, 1, "keyboard cycling never revives a removed agent");
  agents = [];
  t.mock.timers.tick(1_000);
  await nextTurn();
  assert.deepEqual(closes, [undefined], "the final completion closes the viewer even without a render or input");
  assert.deepEqual(rows(), []);
  assert.ok(calls.every(call => call.signal.aborted));
  const stoppedCalls = calls.length;
  t.mock.timers.tick(2_000);
  await nextTurn();
  assert.equal(calls.length, stoppedCalls, "empty active lists cannot rearm polling");
});

test("an initially empty active list closes without inspecting retained history", async t => {
  const { viewer, rows, calls, closes } = popup(t, {
    agents: () => [{ id: "reader", name: "reader", state: "dormant" }],
  });
  await nextTurn();
  assert.deepEqual(calls, []);
  assert.deepEqual(closes, [undefined]);
  assert.deepEqual(rows(), []);
  viewer.handleInput("\t");
  assert.deepEqual(closes, [undefined], "an empty viewer cannot be reopened by cycling");
});

test("overflow arrows navigate tabs and keyboard selection remains visible", async t => {
  const agents = Array.from({ length: 10 }, (_, i) => ({ id: `worker${i}`, name: `worker${i}`, state: "running" }));
  const { viewer, rows, clickText } = popup(t, { agentId: "worker0", agents: () => agents });
  await nextTurn();
  const width = 44;
  assert.match(rows(width)[1], /\[worker0\]/);
  assert.match(rows(width)[1], /\[>\]/);
  for (let i = 1; i < agents.length; i++) {
    viewer.handleInput("\u001b[C");
    await nextTurn();
    assert.ok(rows(width)[1].includes(`[worker${i}]`), `selected worker${i} is visible rather than clipped off-page`);
    assert.ok(rows(width).some(row => row.includes(`CONTENT_worker${i}`)));
  }
  assert.ok(rows(23)[1].includes("[worker9]"), "resizing also reveals the selected tab");
  const lastFrame = rows(width), lastHeader = lastFrame[1];
  assert.match(lastHeader, /\[<\]/);
  clickText("[<]", width, { header: true });
  await nextTurn();
  const pagedFrame = rows(width), header = pagedFrame[1];
  assert.notEqual(header, lastHeader, "the visible paging arrow is actionable");
  assert.deepEqual(pagedFrame.slice(2), lastFrame.slice(2), "browsing off-screen labels does not change the selected transcript");
  assert.match(header, /\[X\]│$/);
});

test("backward overflow paging does not skip variable-width tab labels", async t => {
  const agents = ["reader", "writer", "tester", "x"].map(name => ({ id: name, name, state: "running" }));
  const { rows, clickText } = popup(t, { agents: () => agents });
  await nextTurn();
  const width = 23;
  assert.match(rows(width)[1], /\[reader\]/);
  clickText("[>]", width, { header: true });
  assert.ok(rows(width)[1].includes("writer"));
  clickText("[>]", width, { header: true });
  assert.match(rows(width)[1], /tester.*x/);
  clickText("[<]", width, { header: true });
  assert.ok(rows(width)[1].includes("writer"), "backward paging must expose the preceding page, not skip it when the current page contains more tabs");
  clickText("[<]", width, { header: true });
  assert.match(rows(width)[1], /\[reader\]/);
});

test("Unicode tab labels truncate within terminal columns without corrupting text or the close button", async t => {
  const name = "读者👩‍👩‍👦e\u0301🚀".repeat(5);
  const { rows } = popup(t, { agents: () => [{ id: "reader", name, state: "running" }, ...defaultAgents.slice(1)] });
  await nextTurn();
  assert.ok(rows(90)[1].includes(`[${name}]`), "the full Unicode label is actually rendered when it fits");
  for (const width of [1, 4, 5, 6, 9, 14, 22, 44, 90]) {
    const rendered = rows(width);
    assert.ok(rendered.every(row => visibleWidth(row) <= width), `wide and combining labels fit ${width} columns`);
    assert.ok(rendered.every(row => row.isWellFormed() && !row.includes("\ufffd")), "labels do not contain split surrogates or replacement glyphs");
    if (width >= 5) assert.match(rendered[1], /\[X\]│$/);
  }
});

test("recent tab state is retained but traversing nine agents evicts an old transcript", async t => {
  const agents = Array.from({ length: 9 }, (_, i) => ({ id: `agent${i}`, name: `agent${i}`, state: "running" }));
  const messages = Object.fromEntries(agents.map(({ id }) => [id, [textMessage(
    Array.from({ length: 50 }, (_, i) => `${id}_LINE_${i + 1}`).join("\n\n"),
  )]]));
  const { viewer, rows, calls } = popup(t, { agentId: "agent0", agents: () => agents, messages });
  await nextTurn();
  rows(); viewer.handleInput("\u001b[H");
  assert.ok(rows().some(row => row.includes("agent0_LINE_1 ")));
  for (let i = 1; i < agents.length; i++) {
    viewer.handleInput("\u001b[C");
    await nextTurn();
    rows();
    if (i === 7) viewer.handleInput("\u001b[H");
  }
  viewer.handleInput("\u001b[D");
  await nextTurn();
  assert.ok(rows().some(row => row.includes("agent7_LINE_1 ")), "a recent tab retains its scrolled viewport");
  assert.equal(calls.filter(call => call.agentId === "agent7").at(-1).after, 1, "recent history is not fetched again from zero");
  for (let i = 0; i < 7; i++) {
    viewer.handleInput("\u001b[D");
    await nextTurn();
  }
  assert.match(rows()[1], /\[agent0\]/);
  assert.equal(calls.filter(call => call.agentId === "agent0").at(-1).after, 0, "evicted history restarts with its own initial cursor");
  assert.ok(rows().some(row => row.includes("agent0_LINE_50")), "evicted scroll state resets instead of keeping unlimited hidden views");
});

for (const outcome of ["response", "error"]) {
  test(`switching aborts the old inspection and ignores its late ${outcome} without rearming its poll`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const old = deferred();
    const { viewer, rows, clickText, calls } = popup(t, {
      inspect: (agentId, after) => agentId === "reader" ? old.promise : Promise.resolve(
        inspection(agentId, after === 0 ? [textMessage("CURRENT_WRITER")] : []),
      ),
    });
    const oldCall = calls[0];
    assert.equal(oldCall.agentId, "reader");
    assert.equal(oldCall.after, 0);
    assert.ok(oldCall.signal instanceof AbortSignal);
    assert.equal(oldCall.signal.aborted, false);
    clickText("writer", 90, { header: true });
    await nextTurn();
    const currentCall = calls.find(call => call.agentId === "writer");
    assert.ok(currentCall, "selection immediately inspects the destination");
    assert.equal(oldCall.signal.aborted, true, "selection cancels the previous in-flight inspection");
    assert.notEqual(currentCall.signal, oldCall.signal);
    assert.equal(currentCall.signal.aborted, false);
    assert.ok(rows().some(row => row.includes("CURRENT_WRITER")));
    if (outcome === "response") old.resolve(inspection("reader", [textMessage("STALE_READER")], { next_cursor: 777, has_more: true }));
    else old.reject(new Error("STALE_READER_ERROR"));
    await nextTurn();
    assert.match(rows()[1], /\[writer\]/);
    assert.ok(rows().some(row => row.includes("CURRENT_WRITER")));
    assert.ok(!rows().some(row => row.includes("STALE_READER")), "late success or error cannot mutate the selected view");
    t.mock.timers.tick(50);
    await nextTurn();
    t.mock.timers.tick(1_500);
    await nextTurn();
    assert.equal(calls.filter(call => call.agentId === "reader").length, 1, "a late settlement cannot restart polling for an inactive tab");
    assert.ok(calls.some(call => call.agentId === "writer" && call.after === 1), "only the destination continues polling with its own cursor");
    assert.ok(!rows().some(row => row.includes("STALE_READER")));
    viewer.dispose();
    assert.equal(calls.at(-1).signal.aborted, true, "disposing also cancels the selected request lifecycle");
  });
}

test("returning to the same tab still isolates an older cancelled inspection generation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = deferred();
  let readerRequests = 0;
  const { viewer, rows, clickText, calls } = popup(t, {
    inspect: (agentId, after) => {
      if (agentId === "reader" && ++readerRequests === 1) return old.promise;
      return Promise.resolve(inspection(agentId, after === 0 ? [textMessage(`FRESH_${agentId}`)] : []));
    },
  });
  clickText("writer", 90, { header: true });
  await nextTurn();
  clickText("reader", 90, { header: true });
  await nextTurn();
  assert.equal(calls[0].signal.aborted, true);
  assert.notEqual(calls[0].signal, calls.at(-1).signal);
  assert.ok(rows().some(row => row.includes("FRESH_reader")));
  old.resolve(inspection("reader", [textMessage("CANCELLED_GENERATION")], { next_cursor: 777, has_more: true }));
  await nextTurn();
  t.mock.timers.tick(1_500);
  await nextTurn();
  assert.match(rows()[1], /\[reader\]/);
  assert.ok(rows().some(row => row.includes("FRESH_reader")));
  assert.ok(!rows().some(row => row.includes("CANCELLED_GENERATION")));
  assert.ok(!calls.some(call => call.after === 777), "the obsolete cursor never replaces the current generation's cursor");
  const resumed = calls.filter(call => call.agentId === "reader").slice(2);
  assert.ok(resumed.length > 0, "the returned-to tab continues polling after the obsolete request settles");
  assert.ok(resumed.every(call => call.after === 1));
  assert.equal(calls.filter(call => call.agentId === "writer").length, 1, "only the returned-to tab is polled");
  viewer.dispose();
});

test("real Pi AltScreen overlay routes primary press/release to tab switching and close, then disposes polling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { tui, terminal } = altScreen(100, 60);
  terminal.hideCursor = () => terminal.write("\u001b[?25l");
  terminal.showCursor = () => terminal.write("\u001b[?25h");
  const { viewer, calls, closes } = popup(t, { tui, messages: {
    reader: [textMessage(Array.from({ length: 80 }, (_, i) => `SCROLL_${i}`).join("\n\n"))],
  } });
  tui.setLayoutRoot(container());
  const overlay = tui.showOverlay(viewer, { anchor: "center", width: "90%", maxHeight: "70%" });
  t.after(() => overlay.hide());
  await nextTurn();
  tui.doRender();
  // These are screen coordinates: the real overlay is offset from the terminal origin.
  const headerTarget = label => {
    const lines = screenLines(tui);
    const row = lines.findIndex(line => line.includes("[X]") && line.includes(label));
    assert.ok(row >= 0, `overlay header contains ${label}`);
    return { x: visibleWidth(lines[row].slice(0, lines[row].indexOf(label))) + 1, y: row + 1 };
  };
  const lines = screenLines(tui), thumbRow = lines.findIndex(line => line.includes("┃"));
  assert.ok(thumbRow >= 0, "the actual overlay paints its scrollbar");
  const barX = visibleWidth(lines[thumbRow].slice(0, lines[thumbRow].indexOf("┃"))) + 1;
  const bodyY = headerTarget("[reader]").y + 4;
  tui.handleTerminalInput(sgr(0, barX, bodyY));
  tui.doRender();
  assert.ok(screenLines(tui).some(line => line.includes("SCROLL_0")), "native track press reaches the start");
  tui.handleTerminalInput(sgr(32, 1, 60));
  tui.handleTerminalInput(sgr(0, 1, 60, true));
  tui.doRender();
  assert.ok(screenLines(tui).some(line => line.includes("SCROLL_79")), "native captured drag works beyond the overlay bounds");
  const writer = headerTarget("writer");
  tui.handleTerminalInput(sgr(0, writer.x, writer.y));
  assert.deepEqual(calls.map(call => call.agentId), ["reader"], "press alone does not activate the tab");
  tui.handleTerminalInput(sgr(0, writer.x, writer.y, true));
  await nextTurn();
  tui.doRender();
  assert.ok(screenLines(tui).some(line => line.includes("[writer]")), "native synthesized click selects the inactive tab");
  assert.ok(screenLines(tui).some(line => line.includes("CONTENT_writer")));
  assert.deepEqual(calls.map(call => call.agentId), ["reader", "writer"]);
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(closes, []);

  const close = headerTarget("[X]");
  close.x++; // The X cell, rather than the bracket, matches width - 3 in local coordinates.
  tui.handleTerminalInput(sgr(2, close.x, close.y));
  tui.handleTerminalInput(sgr(2, close.x, close.y, true));
  tui.handleTerminalInput(sgr(64, close.x, close.y));
  tui.handleTerminalInput(sgr(0, close.x, close.y));
  tui.handleTerminalInput(sgr(32, close.x - 3, close.y));
  tui.handleTerminalInput(sgr(0, close.x - 3, close.y, true));
  assert.deepEqual(closes, [], "native right click, wheel and drag cannot activate close");
  tui.handleTerminalInput(sgr(0, close.x, close.y));
  assert.deepEqual(closes, [], "close claims the native press without firing early");
  tui.handleTerminalInput(sgr(0, close.x, close.y, true));
  assert.deepEqual(closes, [undefined], "the native primary click invokes completion once");
  assert.ok(calls.every(call => call.signal.aborted), "completion cancels the inspection lifecycle");
  assert.deepEqual(viewer.render(90), [], "the closed viewer has disposed its rendered content and targets");
  const completedCalls = calls.length;
  t.mock.timers.tick(2_000);
  await nextTurn();
  assert.equal(calls.length, completedCalls, "no inspection timer survives close");
});
