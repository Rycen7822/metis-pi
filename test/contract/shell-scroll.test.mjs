import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import * as Core from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { createShellFactories } from "../../src/chrome/tool-components.ts";
import { makeRenderers } from "../../src/renderers.ts";
import { installAdapter } from "../../src/adapter.ts";
import { layout } from "../helpers/layout.mjs";
import { isolatedToolHost } from "../helpers/native-tool.mjs";
import { productFor, publishedRowsOf } from "../../src/selection-copy/model.ts";
import { altScreen, container, select, installCopyPrototypes } from "../helpers/ui-fixtures.mjs";

Core.initTheme("dark", false);
function shellFixture(t) {
  const Host = isolatedToolHost();
  const renderers = makeRenderers((text) => new Tui.Text(text, 0, 0), () => "expand",
    undefined, undefined, createShellFactories(layout));
  const adapter = installAdapter(Host.prototype, {
    getTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } }],
    enabled: () => true,
    renderers,
  });
  t.after(() => adapter.dispose());
  assert.equal(adapter.installed, true);
  installCopyPrototypes(t, ["Text", "Markdown", "Box", "Container", "MouseRegion"]);
  return (text = "first\nlast") => {
    const row = new Host("bash", Core.createBashToolDefinition(process.cwd()), { command: "printf old" });
    row.updateResult(payload(text));
    row.render(80); // Activate the adapter's deferred self-shell path.
    return row;
  };
}

const payload = (text) => ({ content: [{ type: "text", text }], isError: false });
const plain = (rows) => stripVTControlCharacters(rows.join("\n"));
function scrollScreen(children, width = 40, rows = 8) {
  const { tui } = altScreen(width, rows);
  tui.setLayoutRoot(new Tui.ScrollView(container(...children), { primary: true, follow: "end" }));
  return tui;
}

test("settled shell scroll frames render each leaf once and reuse its copy product", (t) => {
  const shell = shellFixture(t);
  const rows = Array.from({ length: 8 }, (_, i) => shell(`command ${i}\n${"long output words ".repeat(300)}\nlast`));
  const tui = scrollScreen(rows, 80, 12);
  tui.doRender();
  const leaves = rows.flatMap((row) => [row.callRendererComponent, row.resultRendererComponent]);
  const renders = leaves.map((leaf) => t.mock.method(leaf, "render").mock);
  const beforeScroll = tui.currentLayout.root.scrollView.scrollTop;
  for (let i = 0; i < 3; i++) {
    tui.handleViewportInput("\x1b[<64;10;5M");
    tui.doRender();
  }
  assert.ok(tui.currentLayout.root.scrollView.scrollTop < beforeScroll);
  for (const render of renders) {
    assert.equal(render.callCount(), 3, "one render per leaf and wheel frame, including offscreen rows");
    const first = render.calls[0].result;
    assert.ok(productFor(first));
    for (const { result } of render.calls) assert.equal(result, first, "warm frames reuse the cached product array");
  }
  for (const row of rows) assert.ok(publishedRowsOf(row), "self-shell publishes the host's actual rows");
});

test("native shell updates preserve committed copy, theme colors and image fallback", (t) => {
  const shell = shellFixture(t);
  const text = `${"甲乙丙丁".repeat(30)}\nMIDDLE\n${"甲乙丙丁".repeat(30)}`;
  const row = shell(text);
  row.setExpanded(true);
  const region = new Tui.MouseRegion(row, () => undefined);
  const tui = scrollScreen([region], 40, 24); // Exercise both native wrappers in one committed frame.
  const copy = (frame, startText, endRow = frame.root.scrollContentLines.length - 1) => {
    const startRow = frame.root.scrollContentLines.findIndex((line) => line.includes(startText));
    assert.ok(startRow >= 0);
    return select(frame, startRow, endRow);
  };
  for (let i = 0; i < 2; i++) {
    tui.doRender();
    const copied = copy(tui.currentLayout, "甲");
    assert.equal(copied.text, text, "copy through the whole tool drops gutters and joins soft wraps");
    assert.equal(copied.nativeRows, 0);
    assert.ok(productFor(publishedRowsOf(row)), "host-composed rows keep their child product");
    assert.equal(publishedRowsOf(region), publishedRowsOf(row), "MouseRegion publishes the cached host rows");
  }
  const committed = tui.currentLayout;
  row.setExpanded(false);
  assert.doesNotMatch(plain(row.render(40)), /MIDDLE/);
  row.setExpanded(true);
  for (const width of [80, 40]) {
    assert.ok(row.render(width).every((line) => Tui.visibleWidth(line) <= width));
  }
  row.updateArgs({ command: "printf new" });
  assert.match(plain(row.render(80)), /printf new/);
  row.updateResult(payload("stream tail one"), true);
  assert.match(plain(row.render(80)), /stream tail one/);
  row.updateResult(payload("stream tail two"), true);
  assert.match(plain(row.render(80)), /stream tail two/);
  assert.doesNotMatch(plain(row.render(80)), /stream tail one/);
  row.updateResult(payload("finished"), false);
  assert.match(plain(row.render(80)), /Ran printf new[\s\S]*finished/);
  const beforeThemeChange = row.render(80);
  try {
    Core.initTheme("light", false);
    row.invalidate();
    const light = row.render(80);
    assert.equal(plain(light), plain(beforeThemeChange), "changing theme preserves content");
    assert.notDeepEqual(light, beforeThemeChange, "changing theme refreshes visible colors");
  } finally {
    Core.initTheme("dark", false);
  }
  row.updateResult(payload("changed after selection"));
  row.imageComponents = [new Tui.Text("NATIVE IMAGE ROW", 0, 0)];
  tui.doRender();
  assert.equal(copy(committed, "甲").text, text, "new output cannot rewrite a committed frame's metadata");
  const mixed = copy(tui.currentLayout, "changed");
  assert.equal(mixed.text, "changed after selection\nNATIVE IMAGE ROW");
  assert.equal(mixed.nativeRows, 1, "images outside the known text subtree retain native extraction");
});
