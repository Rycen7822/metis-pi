import test from "node:test";
import assert from "node:assert/strict";

import * as Tui from "@earendil-works/pi-tui";
import { createSelectionCopySystem, detectExternalSerializerPatch } from "../../src/selection-copy/index.ts";
import { stackComponents } from "../../src/selection-copy/stack.ts";
import { altScreen, copyFrame, installCopyPrototypes, markdownTheme, screenLines, select } from "../helpers/ui-fixtures.mjs";

const theme = {
  ...markdownTheme,
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
  italic: (t) => `\x1b[3m${t}\x1b[23m`,
  underline: (t) => `\x1b[4m${t}\x1b[24m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[29m`,
};

test("collected host tokens and a throttled stream rebuild exact fallback provenance", t => {
  const cases = [
    ["cjk", "**这是测试。**后面还有中文需要折行", "这是测试。后面还有中文需要折行", 16],
    ["ascii flanking", "**end.**Then next", "**end.**Then next", 40],
    ["strict del", "Use ~not struck~ and ~~struck~~", "Use ~not struck~ and struck", 40],
    ["pending math table", "Intro\n\n$$\nx = 1\n\n| A |\n:---:\n| 1 |\n\nAfter", undefined, 40],
    ["closed math", "$$\na + b\n$$", "a + b", 40],
    ["bracket table", "Intro\n\n\\[\nx^2\n\n| A |\n| --- |\n| 1 |\n\nAfter", undefined, 40],
  ];
  // Warm native rows before the process-owned wrappers exist. Dropping the
  // optional WeakRef simulates collected tokens without nondeterministic GC.
  const warmed = cases.map(([name, text, expected, width]) => {
    const component = new Tui.Markdown(text, 0, 0, theme);
    component.render(width);
    component.cachedTokens = undefined;
    return { name, component, expected, width };
  });
  const sys = installCopyPrototypes(t);
  for (const { name, component, expected, width } of warmed) {
    const copied = select(copyFrame(component, width));
    assert.equal(component.cachedTokens, undefined, `${name}: host reused rows; mirror had to lex`);
    assert.equal(sys.diagnostics().mirrors.markdownDegraded, 0, `${name}: ${sys.diagnostics().mirrors.lastDegradedReason}`);
    if (expected !== undefined) { assert.equal(copied.text, expected, name); assert.equal(copied.nativeRows, 0, name); }
    else {
      assert.match(copied.text, /Intro/); assert.match(copied.text, /After/);
      assert.match(copied.text, /│ A │/); assert.match(copied.text, /│ 1 │/);
    }
  }
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const stream = new Tui.Markdown("initial", 0, 0, theme);
  copyFrame(stream, 16);
  now += 10;
  const throttled = sys.diagnostics().mirrors.markdownThrottled;
  stream.setText("**新的中文。**后面还有中文");
  stream.render(16);
  assert.equal(sys.diagnostics().mirrors.markdownThrottled, throttled + 1);
  stream.cachedTokens = undefined;
  now += 10;
  const rebuilt = select(copyFrame(stream, 16));
  assert.equal(rebuilt.text, "新的中文。后面还有中文");
  assert.equal(rebuilt.nativeRows, 0);
  assert.equal(sys.diagnostics().mirrors.markdownDegraded, 0);
});

test("real Markdown copies prose, formatted blocks and hard breaks without mirror degradation", (t) => {
  const sys = installCopyPrototypes(t);
  // Code fences, table fallback and partial list selection have exact oracles in copy-text.
  const cases = [
    ["soft-wrapped prose", 40,
      "alpha beta中文词语\nsee https://example.com/very/long/path/that/exceeds/the/terminal/width for details\n\ngamma"],
    ["formatted blocks", 24,
      "# Heading\n\n> a **bold** and *italic* `code` ~~struck~~ statement\n> next line\n\n- parent\n  - nested\n\n3. ordered",
      "Heading\n\n│ a bold and italic code struck statement\nnext line\n\n- parent\n    - nested\n\n3. ordered"],
    ["hard breaks", 24, "first line  \nsecond line after a hard break\\\nthird line",
      "first line\nsecond line after a hard break\nthird line"],
  ];
  for (const [name, width, text, expected = text] of cases) {
    const frame = copyFrame(new Tui.Markdown(text, 1, 1, theme, undefined, {}), width);
    const result = select(frame, 1, frame.root.lines.length - 2);
    assert.equal(result.text, expected, name);
    assert.equal(result.nativeRows, 0, `${name}: provenance owns every selected content row`);
    const { markdownDegraded, lastDegradedReason } = sys.diagnostics().mirrors;
    assert.equal(markdownDegraded, 0, `${name}: ${lastDegradedReason}`);
  }
  let transformed = "alpha";
  const changing = new Tui.Markdown("stable source", 0, 0, theme, undefined, { transform: () => transformed });
  const committed = copyFrame(changing, 40);
  assert.equal(select(committed).text, "alpha");
  transformed = "bravo";
  changing.invalidate();
  assert.equal(select(copyFrame(changing, 40)).text, "bravo", "copy follows native transform invalidation");
  assert.equal(select(committed).text, "alpha", "previously committed selection keeps its own frame");
});

test("stack copy uses the displayed render pass without rerendering dynamic children", (t) => {
  installCopyPrototypes(t, ["Text", "Markdown", "Container", "Box", "MouseRegion"]);
  for (const composition of ["flat-rows", "child-placements"]) {
    let renders = 0;
    const changing = {
      render: width => new Tui.Text(`frame ${++renders}`, 0, 0).render(width),
      invalidate() {},
    };
    const stack = stackComponents([changing, new Tui.Text("following block", 0, 0)], composition);
    const first = copyFrame(stack, 40);
    assert.equal(select(first).text, "frame 1\nfollowing block", `${composition}: copy matches the displayed frame`);
    assert.equal(renders, 1, "copy alignment consumes published rows from the existing render pass");
    stack.invalidate();
    const next = copyFrame(stack, 40);
    assert.equal(select(next).text, "frame 2\nfollowing block");
    assert.equal(renders, 2);
    assert.equal(select(first).text, "frame 1\nfollowing block", "a committed earlier frame retains its own provenance");
  }
});

test("flat-rows keeps later rows aligned after a container child", (t) => {
  installCopyPrototypes(t, ["Text", "Markdown", "Container", "Box", "MouseRegion"]);
  // Fusion stacks a mutation result, a shell call and a shell result; any of them
  // may be a Box/Container, whose product is a placement chain with no flat rows.
  const boxed = new Tui.Box(1, 0);
  boxed.addChild(new Tui.Text("BOX-A", 0, 0));
  boxed.addChild(new Tui.Text("BOX-B", 0, 0));
  const stack = stackComponents([boxed, new Tui.Text("TAIL", 0, 0)], "flat-rows");
  const frame = copyFrame(stack, 20);
  const displayed = frame.root.lines.map((line) => Tui.stripTerminalSequences(line).trimEnd());
  assert.deepEqual(displayed, [" BOX-A", " BOX-B", "TAIL"]);
  assert.equal(select(frame, 0, 0).text, " BOX-A", "the first row is the container child, not a later sibling");
  assert.equal(select(frame, 2, 2).text, "TAIL", "the last row is the last displayed line");
});

test("exact card copy omits background and bypasses a foreign serializer wrapper", (t) => {
  const text = "一行中文软折行复制测试内容需要足够长才能在窄宽度下折行成多行屏幕显示验证精确复制。";
  const sys = installCopyPrototypes(t);
  const { tui } = altScreen(60);
  const box = new Tui.Box(1, 1, (line) => `\x1b[48;2;41;41;41m${line}\x1b[49m`);
  box.addChild(new Tui.Markdown(text, 0, 0, theme));
  tui.setLayoutRoot(box);
  tui.doRender();
  assert.ok(tui.previousScreen.some((line) => line.includes("\x1b[48;2;41;41;41m")));
  // Install a foreign prototype serializer before our receiver lease.
  // normalizer (adds markers around every newline it sees).
  const proto = Object.getPrototypeOf(tui);
  const original = proto.getActiveSelectionText;
  t.after(() => { proto.getActiveSelectionText = original; });
  proto.getActiveSelectionText = function (...args) {
    const value = original.apply(this, args);
    return value === undefined ? undefined : value.split("\n").join("<<HEURISTIC>>");
  };
  // The test wrapper is an unknown foreign owner (the real plugin names
  // itself via its normalizer source); both must be detected as foreign.
  assert.ok(detectExternalSerializerPatch(proto) !== undefined, "foreign wrapper detected");
  assert.ok(sys.installOnTui(tui));
  const screen = screenLines(tui);
  const first = screen.findIndex((line) => line.includes("一行中文"));
  const last = screen.findIndex((line) => line.includes("精确复制"));
  assert.ok(first >= 0 && last > first, "wrapped rows present");
  tui.selectionAnchor = { row: first, col: 0, scrollView: undefined, boundary: false };
  tui.selectionFocus = { row: last, col: Tui.visibleWidth(screen[last]), scrollView: undefined, boundary: false };
  const copied = tui.getActiveSelectionText();
  assert.ok(!copied.includes("<<HEURISTIC>>"), "receiver lease bypasses the prototype wrapper");
  assert.equal(copied, text, "exact text despite foreign prototype wrapper");
});

// Prototype wrappers are process-owned; disposing a session only releases its instance resources.
test("repeated selection-copy setup does not stack render wrappers", (t) => {
  const names = ["Text", "Markdown", "Container", "Box", "MouseRegion"];
  const system = installCopyPrototypes(t, names);
  const installed = names.map((name) => Tui[name].prototype.render);
  assert.equal(system.wrapPrototypes().installed, true);
  assert.deepEqual(names.map((name) => Tui[name].prototype.render), installed);

  const sibling = installCopyPrototypes(t, names);
  let current = altScreen().tui;
  const live = new Proxy({}, {
    getPrototypeOf: () => Object.getPrototypeOf(current),
    get: (_target, key) => typeof current[key] === "function" ? current[key].bind(current) : current[key],
  });
  const other = altScreen().tui;
  assert.ok(system.installOnTui(live));
  assert.ok(sibling.installOnTui(other));
  live.getActiveSelectionText();
  other.getActiveSelectionText();
  assert.equal(system.diagnostics().telemetry.calls, 1);
  assert.equal(sibling.diagnostics().telemetry.calls, 1);
  system.dispose();
  other.getActiveSelectionText();
  assert.equal(system.diagnostics().telemetry.calls, 1, "released TUI no longer calls its former controller");
  assert.equal(sibling.diagnostics().telemetry.calls, 2, "concurrent TUI keeps its lease");
  current = altScreen().tui;
  assert.ok(sibling.installOnTui(live), "same live facade can switch its native receiver");
  other.getActiveSelectionText();
  live.getActiveSelectionText();
  assert.equal(sibling.diagnostics().telemetry.calls, 3, "only the new receiver is active");
  sibling.dispose();
  live.getActiveSelectionText();
  assert.equal(sibling.diagnostics().telemetry.calls, 3, "final release restores native extraction");
  const retained = sibling.wrapPrototypes();
  assert.equal(retained.installed, true, "a later session adopts the process-owned wrappers");
  assert.match(retained.details, /markdown=self/, "self-owned entries are not blocked");
  assert.deepEqual(names.map((name) => Tui[name].prototype.render), installed);
  assert.equal(select(copyFrame(new Tui.Text("still copyable", 0, 0), 40)).text, "still copyable");

  const sealed = Object.fromEntries(names.map((name) => [name, Object.preventExtensions({ render() { return []; } })]));
  const original = Object.values(sealed).map((prototype) => prototype.render);
  const blocked = createSelectionCopySystem({ prototypes: sealed, fns: Tui });
  t.after(() => blocked.dispose());
  assert.equal(blocked.wrapPrototypes().installed, false);
  assert.deepEqual(Object.values(sealed).map((prototype) => prototype.render), original, "sealed prototypes stay unchanged");
});
