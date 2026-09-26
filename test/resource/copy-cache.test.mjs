// Copy resource contracts: rebuild budgets and no additional native render pass.
import test from "node:test";
import assert from "node:assert/strict";
import * as Tui from "@earendil-works/pi-tui";
import { productFor, publishedRowsOf } from "../../src/selection-copy/model.ts";
import { createSelectionCopySystem } from "../../src/selection-copy/index.ts";
import { container, installCopyPrototypes, markdownTheme as theme } from "../helpers/ui-fixtures.mjs";

test("throttle: changing text at one width rebuilds at most once per interval; stable text rebuilds immediately", (t) => {
  let fakeNow = 10_000;
  t.mock.method(Date, "now", () => fakeNow);
  class FreshText extends Tui.Text {
    render(width) { return [...super.render(width)]; }
  }
  const system = createSelectionCopySystem({
    prototypes: { Text: FreshText.prototype, Markdown: Tui.Markdown.prototype, Box: Tui.Box.prototype, Container: Tui.Container.prototype },
    fns: { ...Tui, renderLatex: () => null },
  });
  t.after(() => system.dispose());
  assert.equal(system.wrapPrototypes().installed, true, "fresh native subclass wraps");
  const line = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
  const comp = new FreshText(line, 0, 0);

  // One stream: settling bypasses the interval; changing again starts a new
  // throttle window, while elapsed time or a new width always permits rebuild.
  for (const [name, suffix, elapsed, width, built, throttled, mapped] of [
    ["first render", "", 0, 60, 1, 0, true],
    ["fresh-array cache hit", "", 0, 60, 1, 0, true],
    ["changing text", " STREAMING", 50, 60, 1, 1, false],
    ["settled text", " STREAMING", 50, 60, 2, 1, true],
    ["second throttle window", " STREAMING MORE", 50, 60, 2, 2, false],
    ["interval expired", " STREAMING MORE AND MORE", 250, 60, 3, 2, true],
    ["resize", " WIDTH CHANGED", 10, 80, 4, 2, true],
  ]) {
    comp.setText(line + suffix);
    fakeNow += elapsed;
    const rows = comp.render(width);
    assert.equal(system.diagnostics().mirrors.textBuilt, built, name);
    assert.equal(system.diagnostics().mirrors.textThrottled, throttled, name);
    assert.equal(Boolean(productFor(rows)), mapped, name);
    assert.equal(publishedRowsOf(comp), rows, `${name}: rows published for alignment`);
  }
});

test("container alignment resolves child products WITHOUT re-rendering children", (t) => {
  installCopyPrototypes(t);
  const chat = container(container(
    new Tui.Markdown("steady child content", 0, 0, theme, undefined, {}),
    new Tui.Text("a label", 1, 0),
  ));
  chat.render(60); // first pass: builds products

  // Observe both leaves in the same frame; node:test restores both prototype methods.
  const renders = [Tui.Markdown, Tui.Text].map((Component) => t.mock.method(Component.prototype, "render"));
  const rows = chat.render(60);
  for (const render of renders) assert.equal(render.mock.callCount(), 1, "alignment cannot re-render a leaf");
  const product = productFor(rows);
  assert.ok(product?.children, "container product registered");
  assert.ok(product.children.some((p) => p !== undefined), "placements resolve through the chain");
});
