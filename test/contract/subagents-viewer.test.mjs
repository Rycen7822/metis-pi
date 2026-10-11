import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { SubagentViewer } from "../../src/subagents/viewer.ts";

initTheme("dark", false);

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
        agent: { name: "reader", state: "idle" },
        messages: sent ? [] : messages.map((message, id) => ({ id: String(id), message })),
        session_file: "saved.jsonl",
        next_cursor: 1,
        has_more: false,
      };
      sent = true;
      return page;
    },
  );
  t.after(() => viewer.dispose());
  await delay(0);
  const rows = () => viewer.render(90).map(stripVTControlCharacters);
  const click = (label, button = "left") => {
    const y = rows().findIndex(row => row.includes(label)); assert.ok(y >= 0, label);
    return viewer.handleMouse({ type: "click", button, x: 3, y, screenX: 3, screenY: y, width: 90, height: 56 });
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
