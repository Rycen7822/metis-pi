import test from "node:test";
import assert from "node:assert/strict";
import * as Tui from "@earendil-works/pi-tui";
import { productFor, publishedRowsOf } from "../../src/selection-copy/model.ts";
import { createSelectionCopySystem } from "../../src/selection-copy/index.ts";
import { container, copyFrame, installCopyPrototypes, markdownTheme as theme, select } from "../helpers/ui-fixtures.mjs";

test("stable degraded Markdown reuses its native-copy decision and rebuilds when actual rows change", t => {
  let drift = true, paints = 0;
  class FreshText extends Tui.Text { render(width) { return super.render(width); } }
  class DriftedMarkdown extends Tui.Markdown {
    render(width) {
      const rows = [...super.render(width)];
      if (drift) rows[rows.length - 1] = "VISIBLE_HOST_DRIFT".padEnd(width);
      return rows;
    }
  }
  const system = createSelectionCopySystem({
    prototypes: { Text: FreshText.prototype, Markdown: DriftedMarkdown.prototype, Box: Tui.Box.prototype, Container: Tui.Container.prototype },
    fns: { ...Tui, renderLatex: () => null },
  });
  t.after(() => system.dispose());
  assert.equal(system.wrapPrototypes().installed, true);
  const countingTheme = { ...theme, highlightCode(text) { paints++; return text.split("\n").map(line => `\x1b[31m${line}\x1b[39m`); } };
  const component = new DriftedMarkdown("```ts\nconst source = '原文🙂';\n```", 0, 0, countingTheme);
  let rows;
  for (let i = 0; i < 40; i++) rows = component.render(60);
  assert.equal(paints, 1, "display only runs the native highlighter");
  assert.equal(productFor(rows), undefined);
  for (let i = 0; i < 40; i++) assert.equal(productFor(component.render(60)), undefined);
  assert.equal(paints, 2, "stable host drift resolves to native only once");
  const rect = { x: 0, y: 0, width: 60, height: rows.length };
  const failedFrame = { root: { component, rect, clip: rect, children: [], lines: rows } };
  const native = select(failedFrame);
  assert.equal(native.text, "```ts\n  const source = '原文🙂';\nVISIBLE_HOST_DRIFT");
  assert.equal(native.nativeRows, 3);
  drift = false;
  const recovered = component.render(60);
  assert.ok(productFor(recovered), "same source/width, changed host rows allow exact copy again");
  assert.equal(paints, 3);
  assert.equal(select({ root: { ...failedFrame.root, lines: recovered } }).text, "```ts\nconst source = '原文🙂';\n```");
  assert.equal(select(failedFrame).text, native.text, "an older committed native frame keeps its own rows");
});

test("streaming text composes without a mirror and copies the requested frame after another update", (t) => {
  const system = installCopyPrototypes(t);
  const before = system.diagnostics().mirrors.textBuilt;
  const original = "alpha beta gamma delta epsilon zeta eta theta iota";
  const text = new Tui.Text(original, 0, 0);
  const chat = container(container(text));
  const first = copyFrame(chat, 16);
  assert.equal(publishedRowsOf(chat), first.root.lines);
  text.setText(original + " MORE");
  const next = copyFrame(chat, 24);
  assert.equal(system.diagnostics().mirrors.textBuilt, before, "composition does not build either mirror");
  assert.equal(select(first).text, original);
  assert.equal(select(next).text, original + " MORE");
  assert.equal(select(first).nativeRows, 0);
  assert.equal(system.diagnostics().mirrors.textBuilt, before + 2, "both committed snapshots are copied and reused");
});

test("container alignment resolves child products WITHOUT re-rendering children", (t) => {
  installCopyPrototypes(t);
  const chat = container(container(
    new Tui.Markdown("steady child content", 0, 0, theme, undefined, {}),
    new Tui.Text("a label", 1, 0),
  ));
  chat.render(60);

  // Observe both leaves in the same frame; node:test restores both prototype methods.
  const renders = [Tui.Markdown, Tui.Text].map((Component) => t.mock.method(Component.prototype, "render"));
  const rows = chat.render(60);
  for (const render of renders) assert.equal(render.mock.callCount(), 1, "alignment cannot re-render a leaf");
  const product = productFor(rows);
  assert.ok(product?.children, "container product registered");
  assert.ok(product.children.some((p) => p !== undefined), "placements resolve through the chain");
});
