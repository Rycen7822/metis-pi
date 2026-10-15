import test from "node:test";
import assert from "node:assert/strict";
import * as Tui from "@earendil-works/pi-tui";
import { initTheme, UserMessageComponent, SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent";
import { createFullscreenLayout } from "../../src/chrome/fullscreen-layout.ts";
import { altScreen, container, screenLines, installCopyPrototypes, select, drag } from "../helpers/ui-fixtures.mjs";
import { sgr } from "../helpers.mjs";

initTheme("dark", false);
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const PROMPT_BG = "\x1b[48;2;41;41;41m";
const host = {
  ...Tui, UserMessageComponent, SkillInvocationMessageComponent,
  promptRow(summary, width) {
    const row = Tui.truncateToWidth(`↑ ${summary}`, width);
    return row + " ".repeat(Math.max(0, width - Tui.visibleWidth(row)));
  },
  promptTheme: () => ({ fg: (_key, row) => row, bg: (_key, row) => `${PROMPT_BG}${row}\x1b[49m` }),
};
const body = (name, count = 100) => new Tui.Text(Array.from({ length: count }, (_, i) => `${name}_${i}`).join("\n"), 0, 0);
function scrollBox(root, scroll) {
  if (root.scrollView === scroll) return root;
  for (const child of root.children) { const found = scrollBox(child, scroll); if (found) return found; }
}
function setup(t, children, { width = 60, rows = 24, margin = 2, prepareScroll = () => {} } = {}) {
  const source = container(...children);
  const scroll = new Tui.ScrollView(source, { primary: true, follow: "end" });
  prepareScroll(scroll);
  const { tui, terminal } = altScreen(width, rows);
  const root = new Tui.VStack([
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 0 },
    { component: new Tui.Text("EDITOR_DOCK", 0, 0), basis: 2, shrink: 0 },
  ]);
  const layout = createFullscreenLayout(host, { margin, minWidth: 40 });
  t.after(() => { layout.dispose(); scroll.hideTransientScrollbar(); });
  layout.installOnTui(tui);
  tui.setLayoutRoot(root);
  const box = () => scrollBox(tui.currentLayout.root, scroll);
  const render = () => { tui.doRender(); assert.ok(box().scrollContentLines.length <= 5000); };
  const lines = () => box().scrollContentLines;
  const pin = () => screenLines(tui).find(line => line.trimStart().startsWith("↑ "));
  const clickPin = (button = 0) => {
    const screen = screenLines(tui), y = screen.findIndex(line => line.trimStart().startsWith("↑ "));
    assert.ok(y >= 0, "pin visible before clicking");
    const x = screen[y].indexOf("↑") + 1;
    tui.handleTerminalInput(sgr(button, x, y + 1));
    tui.handleTerminalInput(sgr(button, x, y + 1, true));
    render();
  };
  render();
  return { source, scroll, tui, terminal, layout, root, box, render, lines, pin, clickPin };
}

function assertPromptBackground(view) {
  // The fixture emits one background color; resets end each painted span.
  // Sum all spans so resetting and then reapplying the background is valid too.
  const paintedWidth = view.tui.previousScreen[0].split(PROMPT_BG).slice(1)
    .reduce((width, span) => width + Tui.visibleWidth(span.split(/\x1b\[(?:0|49)m/, 1)[0]), 0);
  assert.equal(paintedWidth, view.box().rect.width,
    "every pin cell, including the ellipsis and right padding, keeps its background");
}

test("first committed frame pins the offscreen user input; clicking goes to the original without moving the dock", t => {
  const view = setup(t, [new UserMessageComponent("ORIGINAL_PROMPT"), body("REPLY")]);
  assert.match(view.pin(), /ORIGINAL_PROMPT/);
  assertPromptBackground(view);
  assert.equal(view.tui.getPrimaryScrollView(), view.scroll);
  assert.equal(view.tui.hasOverlay(), false, "chrome must not disable native selection/scrollbars as an overlay would");
  assert.ok(view.lines().every(line => !line.includes("↑")), "pin is outside transcript/copy rows");
  const dock = screenLines(view.tui).findIndex(line => line.includes("EDITOR_DOCK"));
  view.clickPin(2);
  assert.match(view.pin(), /ORIGINAL_PROMPT/, "right click does not navigate");
  view.clickPin();
  assert.equal(view.pin(), undefined);
  assert.ok(screenLines(view.tui).some(line => line.includes("ORIGINAL_PROMPT")));
  assert.equal(view.scroll.isFollowingEnd, false);
  assert.equal(screenLines(view.tui).findIndex(line => line.includes("EDITOR_DOCK")), dock);
});

test("a partly visible multiline prompt stays unpinned and crossing its final row pins it", t => {
  const prompt = new UserMessageComponent("MULTILINE_PROMPT\nsecond line\nthird line");
  const view = setup(t, [prompt, body("REPLY")], { margin: 0 });
  const height = prompt.render(60).length;
  for (const top of [0, height - 1]) {
    view.scroll.scrollTo(top, { disableFollow: true }); view.render();
    assert.equal(view.pin(), undefined, `original still visible at source row ${top}`);
  }
  view.scroll.scrollTo(height, { disableFollow: true }); view.render();
  assert.match(view.pin(), /MULTILINE_PROMPT/);
});

test("reading previous turns pins that turn's prompt rather than the latest submitted one", t => {
  const view = setup(t, [new UserMessageComponent("FIRST_CONTEXT"), body("FIRST_REPLY", 60),
    new UserMessageComponent("SECOND_CONTEXT"), body("SECOND_REPLY", 60)]);
  assert.match(view.pin(), /SECOND_CONTEXT/);
  const row = view.lines().findIndex(line => line.includes("FIRST_REPLY_10"));
  view.scroll.scrollTo(row, { disableFollow: true }); view.render();
  assert.match(view.pin(), /FIRST_CONTEXT/);
  assert.doesNotMatch(view.pin(), /SECOND_CONTEXT/);
  const user = view.lines().findIndex(line => Tui.stripTerminalSequences(line).trim() === "SECOND_CONTEXT");
  view.scroll.scrollTo(user, { disableFollow: true }); view.render();
  assert.equal(view.pin(), undefined);
});

test("an evicted prompt jumps across the 5000-row pager, skipping the Earlier notice; warm scroll does not reformat it", t => {
  const prompt = new UserMessageComponent("COLD_TARGET");
  const rendered = t.mock.method(prompt, "render");
  const blocks = Array.from({ length: 120 }, (_, i) => body(`BLOCK${i}`));
  const early = t.mock.method(blocks[0], "render");
  const view = setup(t, [new Tui.Text("WELCOME", 0, 0), prompt, ...blocks]);
  assert.match(view.pin(), /COLD_TARGET/);
  assert.equal(early.mock.callCount(), 0, "unrelated old history is never rendered for the label");
  assert.equal(rendered.mock.callCount(), 1, "only the chosen off-window prompt renders on demand");
  assert.ok(!prompt.children[0].cachedLines, "off-window prompt's full native cache is released");
  for (let i = 0; i < 3; i++) { view.scroll.scrollBy(-1); view.render(); }
  assert.equal(rendered.mock.callCount(), 1, "short preview cache, not full user rendering, handles warm frames");
  view.clickPin();
  assert.equal(view.pin(), undefined);
  assert.match(view.lines()[0], /Earlier history/);
  assert.equal(view.scroll.scrollTop, 1, "position is resolved after the new bounded page is measured");
  assert.ok(screenLines(view.tui).some(line => line.includes("COLD_TARGET")));
  assert.equal(view.layout.status().history.newer, true);
  assert.equal(view.scroll.isFollowingEnd, false);
});

test("native visible prompt content respects Markdown transforms and column-safe resize", t => {
  const prompt = new UserMessageComponent("PRIVATE_TOKEN", undefined, 1, [() => "VISIBLE_漢字🙂_" + "长提示".repeat(60)]);
  const view = setup(t, [prompt, body("OUTPUT")]);
  assert.match(view.pin(), /VISIBLE_漢字🙂/);
  assert.doesNotMatch(view.pin(), /PRIVATE_TOKEN/);
  for (const width of [30, 31, 72, 73]) {
    view.terminal.columns = width; view.render();
    const pin = view.pin();
    assert.match(pin, /VISIBLE_漢字🙂/);
    assert.ok(Tui.visibleWidth(pin) <= width);
    assert.match(pin, /\.\.\.$/);
    assertPromptBackground(view);
  }
  view.clickPin();
  assert.ok(screenLines(view.tui).some(line => line.includes("VISIBLE_漢字🙂")));
});

test("an evicted prompt's invalidation also refreshes its transformed preview", t => {
  let redacted = false;
  const prompt = new UserMessageComponent("SOURCE", undefined, 1, [() => redacted ? "REDACTED" : "VISIBLE_BEFORE_REDACTION"]);
  const view = setup(t, [prompt, body("REPLY", 6000)]);
  assert.match(view.pin(), /VISIBLE_BEFORE_REDACTION/);
  redacted = true; prompt.invalidate(); view.render();
  assert.match(view.pin(), /REDACTED/);
  assert.doesNotMatch(view.pin(), /VISIBLE_BEFORE_REDACTION/);
  view.layout.dispose();
  assert.equal(Object.hasOwn(prompt, "invalidate"), false, "preview invalidation observer is released with its owner");
});

test("release at a different cell without a drag packet does not trap later wheel events", t => {
  const view = setup(t, [new UserMessageComponent("SCROLLABLE_CONTEXT"), body("BODY")]);
  const before = view.scroll.scrollTop;
  view.tui.handleTerminalInput(sgr(0, 3, 1));
  view.tui.handleTerminalInput(sgr(0, 4, 1, true));
  view.tui.handleTerminalInput(sgr(64, 3, 1)); view.render();
  assert.ok(view.scroll.scrollTop < before, "wheel over the bar still reaches the primary scroll view");
});

test("selection keeps its committed context and transcript copy excludes the pinned chrome", t => {
  installCopyPrototypes(t);
  const view = setup(t, [new UserMessageComponent("SELECTED_CONTEXT"), body("BODY")]);
  const frame = { root: view.box() }, top = view.scroll.scrollTop;
  const copied = select(frame, top, top + view.scroll.viewportHeight - 1).text;
  assert.doesNotMatch(copied, /↑|SELECTED_CONTEXT/);
  const visible = screenLines(view.tui), y = visible.findIndex(line => line.includes("BODY_90"));
  assert.ok(y >= 0);
  drag(view.tui, 4, y + 1, 10, y + 1);
  assert.ok(view.tui.getSelectionBounds());
  const held = view.lines();
  view.source.addChild(new UserMessageComponent("NEXT_CONTEXT")); view.source.addChild(body("NEXT_BODY"));
  view.render();
  assert.equal(view.lines(), held);
  assert.match(view.pin(), /SELECTED_CONTEXT/);
  assert.equal(select(frame, top, top + view.scroll.viewportHeight - 1).text, copied, "old frame products stay immutable");
  view.tui.clearTextSelection(); view.render();
  assert.match(view.pin(), /NEXT_CONTEXT/);
  assert.equal(view.scroll.isFollowingEnd, true);
});

test("press/release retains prompt identity across streaming changes and dragging the pin does not jump", t => {
  const view = setup(t, [new UserMessageComponent("PRESSED_CONTEXT"), body("BODY")]);
  view.tui.handleTerminalInput(sgr(0, 3, 1));
  view.source.addChild(new UserMessageComponent("NEW_CONTEXT")); view.source.addChild(body("NEW_BODY"));
  view.render();
  assert.match(view.pin(), /NEW_CONTEXT/);
  view.tui.handleTerminalInput(sgr(0, 3, 1, true)); view.render();
  assert.equal(view.pin(), undefined);
  assert.ok(screenLines(view.tui).some(line => line.includes("PRESSED_CONTEXT")), "release navigates the pressed target, not a newer prompt");
  view.tui.scrollToBottom(); view.render();
  assert.match(view.pin(), /NEW_CONTEXT/);
  drag(view.tui, 3, 1, 12, 1); view.render();
  assert.match(view.pin(), /NEW_CONTEXT/);
  assert.equal(view.scroll.isFollowingEnd, true);
});

test("an off-window prompt rendering error cannot break the current transcript", t => {
  const prompt = new UserMessageComponent("OFFSCREEN_BROKEN_PROMPT");
  t.mock.method(prompt, "render", () => { throw new Error("native preview unavailable"); });
  const view = setup(t, [prompt, body("STILL_USABLE", 6000)]);
  assert.match(view.pin(), /\[User input\]/);
  assert.ok(screenLines(view.tui).some(line => line.includes("STILL_USABLE_5999")));
});

test("a non-configurable native layout node keeps its owner and disables only the optional bar", t => {
  const view = setup(t, [new UserMessageComponent("UNCHANGED_LAYOUT"), body("BODY")], {
    prepareScroll(scroll) {
      const native = scroll[LAYOUT_NODE];
      Object.defineProperty(scroll, LAYOUT_NODE, { value: native, configurable: false });
    },
  });
  assert.equal(view.pin(), undefined);
  assert.equal(view.layout.status().history.installed, true);
  assert.equal(view.scroll[LAYOUT_NODE]().type, "scroll");
});

test("replacement removes stale pins and disposal restores the native layout node even under a later wrapper", t => {
  const view = setup(t, [new UserMessageComponent("OLD_CONTEXT"), body("BODY")]);
  const captured = view.scroll[LAYOUT_NODE];
  const later = () => captured();
  Object.defineProperty(view.scroll, LAYOUT_NODE, { value: later, writable: true, configurable: true });
  view.source.clear(); view.source.addChild(body("NO_USER")); view.render();
  assert.equal(view.pin(), undefined);
  view.layout.dispose();
  assert.equal(view.tui.layoutRoot, view.root);
  assert.equal(view.scroll.child, view.source);
  assert.equal(view.scroll[LAYOUT_NODE], later);
  assert.equal(view.scroll[LAYOUT_NODE]().type, "scroll", "captured disposed adapter is inert");
  assert.equal(view.scroll[LAYOUT_NODE]().component, view.source);
});
