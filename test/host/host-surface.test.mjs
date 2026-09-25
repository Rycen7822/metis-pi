// host-surface.test.mjs — 0.9.2 production-path tests against the REAL Pi
// host classes (not fakes):
// - the user-message gray surface via the NATIVE userMessageBg theme slot;
// - the thinking visibility policy on the REAL AssistantMessageComponent
//   prototype: auto-collapse once through the host's own override map,
//   duration labels only on ended runs, native click toggle untouched.
process.env.FORCE_COLOR ??= "3";
process.env.COLORTERM ??= "truecolor";
const { default: test } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const Core = await import("@earendil-works/pi-coding-agent");
const Tui = await import("@earendil-works/pi-tui");
const { TranscriptState } = await import("../../src/transcript-state.ts");
const { installTranscriptDecorations } = await import("../../src/transcript-adapter.ts");
const { thoughtSummaryText } = await import("../../src/thinking-summary.ts");
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// Activate THIS package's theme through the host's own loader (custom themes
// live at <agentDir>/themes; getAgentDir honors PI_CODING_AGENT_DIR) so the
// host components render the real palette. Deep theme imports are
// exports-blocked, and the theme singleton cannot be swapped from the API.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-theme-"));
fs.mkdirSync(path.join(agentDir, "themes"), { recursive: true });
fs.copyFileSync(
  new URL("../../themes/metis-pi.json", import.meta.url).pathname,
  path.join(agentDir, "themes", "metis-pi.json"),
);
process.env.PI_CODING_AGENT_DIR = agentDir;
Core.initTheme("metis-pi", false);

test("real UserMessageComponent paints the gray surface from the native theme slot", () => {
  const text = "帮我看看这段很长的用户消息在终端宽度下如何折行，背景应当铺满每一行包括右侧内边距，并且不能泄漏到下一块。";
  const comp = new Core.UserMessageComponent(text);
  const width = 60;
  const rows = comp.render(width);
  assert.ok(rows.length > 2, "message wraps at this width");
  const surface = rows.filter((row) => /\x1b\[48;[0-9;]*m/.test(row));
  assert.equal(surface.length, rows.length, "every visual row carries the card background");
  // The bg reset must close each row — no surface leaks past the message.
  for (const row of rows) assert.ok(row.includes("\x1b[49m"), "bg reset closes the row");
  // The surface resolves the theme var #292929 (truecolor when the terminal
  // can carry it, nearest 256-color otherwise — never assert one encoding).
  assert.ok(
    rows.some((row) => /\x1b\[48;(?:2;41;41;41|5;\d+)m/.test(row)),
    "surface resolves the userMessageSurface var",
  );
  // Multiline input stays readable.
  const multi = new Core.UserMessageComponent("第一行\n\n第二行 also has content");
  const multiRows = multi.render(80).map((row) => strip(row));
  assert.ok(multiRows.some((row) => row.includes("第一行")));
  assert.ok(multiRows.some((row) => row.includes("第二行")));
});

function decorate(state) {
  const labels = [];
  const handle = installTranscriptDecorations({
    state,
    assistantPrototype: Core.AssistantMessageComponent.prototype,
    makeSeparator: () => new Tui.Text("─".repeat(40), 0, 0),
    makeSpacer: () => new Tui.Spacer(1),
    makeRail: undefined,
    thinkingPolicy: () => ({ streaming: "full", completed: "collapsed" }),
    makeThoughtSummary: (input) => {
      const label = new Tui.Text(thoughtSummaryText(input.durationMs), input.paddingX, 0);
      labels.push(label);
      return label;
    },
    isCollapsedLabel: (node) => node instanceof Tui.Text,
    enabled: () => true,
  });
  return { labels, handle };
}

test("real AssistantMessageComponent: auto-collapse fires once through the HOST override map", () => {
  let clock = 5_000;
  const state = new TranscriptState(() => clock);
  const { labels, handle } = decorate(state);
  try {
    const messageObj = { role: "assistant", content: [], stopReason: null };
    state.apply({ type: "message_start", message: { role: "assistant", content: [] } }, messageObj);
    const comp = new Core.AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, []);
    const regionOf = () => comp.contentContainer.children.find((c) => c instanceof Tui.MouseRegion);

    // Streaming: expanded (no override needed for the full policy).
    messageObj.content = [{ type: "thinking", thinking: "EXPANDED_THINKING_SENTINEL deep reasoning" }];
    state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
    comp.updateContent(messageObj, true);
    const streamingRegion = regionOf();
    assert.ok(streamingRegion, "thinking MouseRegion present");
    assert.ok(streamingRegion.child instanceof Tui.Markdown, "expanded while streaming");
    assert.equal(comp.thinkingVisibilityOverrides.size, 0, "host map untouched while active");

    // Transition: text after thinking → collapse ONCE (one extra rebuild).
    messageObj.content = [
      { type: "thinking", thinking: "EXPANDED_THINKING_SENTINEL deep reasoning" },
      { type: "text", text: "Answer." },
    ];
    clock = 12_000;
    state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
    comp.updateContent(messageObj, true);
    const collapsedRegion = regionOf();
    assert.ok(collapsedRegion.child instanceof Tui.Text, "host rebuilt the run collapsed");
    assert.equal(comp.thinkingVisibilityOverrides.get(0), true, "policy wrote the HOST map");
    assert.ok(labels.includes(collapsedRegion.child), "label swapped in inside the native MouseRegion");
    assert.equal(strip(collapsedRegion.child.render(80)[0]).trim(), "Thought for 7s");

    // Native click toggle: expand restores the full Markdown body.
    collapsedRegion.handleMouse({ type: "click", button: "left", x: 5, y: 0 });
    const expandedRegion = regionOf();
    assert.ok(expandedRegion.child instanceof Tui.Markdown, "click expanded via the native handler");
    assert.equal(comp.thinkingVisibilityOverrides.get(0), false);
    assert.ok(strip(expandedRegion.child.render(80).join("")).includes("EXPANDED_THINKING_SENTINEL"), "original body verbatim");
    // Click again → collapsed summary returns; policy never re-fights.
    expandedRegion.handleMouse({ type: "click", button: "left", x: 5, y: 0 });
    assert.ok(labels.includes(regionOf().child), "summary restored after second click");
    assert.equal(handle.thinkingAutoApplied(), 1, "exactly one applied transition");

    // Global Ctrl+T show: host clears the map; redraws stay expanded.
    comp.setHideThinkingBlock(false);
    assert.equal(comp.thinkingVisibilityOverrides.size, 0, "host cleared its map");
    assert.ok(regionOf().child instanceof Tui.Markdown, "expanded after global show");
    comp.updateContent(messageObj);
    assert.ok(regionOf().child instanceof Tui.Markdown, "redraw does not re-collapse");
  } finally {
    handle.dispose();
  }
});

test("real AssistantMessageComponent: history rebuild collapses without timing ('Thought')", () => {
  const { labels, handle } = decorate(new TranscriptState(() => 0));
  try {
    // Finalized message rendered straight from history: no transcript events.
    const messageObj = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "EXPANDED_THINKING_SENTINEL restored reasoning" },
        { type: "text", text: "restored answer" },
      ],
      stopReason: "stop",
    };
    const comp = new Core.AssistantMessageComponent(messageObj, false, undefined, "Thinking...", 1, []);
    const region = comp.contentContainer.children.find((c) => c instanceof Tui.MouseRegion);
    assert.ok(region, "thinking region present");
    assert.ok(labels.includes(region.child), "auto-collapsed on the history rebuild");
    assert.equal(strip(region.child.render(80)[0]).trim(), "Thought", "honest fallback, never fabricated 0s");
    region.handleMouse({ type: "click", button: "left", x: 5, y: 0 });
    const rebuilt = comp.contentContainer.children.find((c) => c instanceof Tui.MouseRegion);
    assert.ok(strip(rebuilt.child.render(80).join("")).includes("EXPANDED_THINKING_SENTINEL"), "click restores the full body");
  } finally {
    handle.dispose();
  }
});
