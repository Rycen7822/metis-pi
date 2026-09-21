import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import * as host from "@earendil-works/pi-coding-agent";
import { installSkillLabelNames, skillNames } from "../../src/skill-label.ts";
import { installSkillFoldClick } from "../../src/skill-fold.ts";

// This suite deliberately drives the REAL host component. The unit suite
// (skill-label.test.mts) uses a direct-children fake, which is exactly the shape
// Pi 0.86 changed: the entry now renders `Box → MouseRegion → Container → Text/Markdown`.
// A fake with direct children would keep passing while the real label regressed.

host.initTheme("dark", false);

const entryClass = host.SkillInvocationMessageComponent as unknown as {
  prototype: { updateDisplay: (this: unknown) => void; handleMouse: (this: unknown, event?: unknown) => unknown };
  new (block: { name: string; location: string; content: string }): {
    children: unknown[];
    setExpanded(expanded: boolean): void;
    handleMouse(event: Record<string, unknown>): unknown;
    render(width: number): string[];
  };
};

// Capture the untouched host methods before any patch is installed, so the same
// suite can also show what the stock host renders.
const stockUpdateDisplay = entryClass.prototype.updateDisplay;
const stockHandleMouse = entryClass.prototype.handleMouse;

installSkillLabelNames(entryClass);
installSkillFoldClick(entryClass);

const nestedContent = (names: readonly string[]): string =>
  names
    .map((name) => `<skill name="${name}" location="/skills/${name}/SKILL.md">\nbody of ${name}\n</skill>`)
    .join("\n\n");

const block = { name: "alpha", location: "/skills/alpha/SKILL.md", content: nestedContent(["beta"]) };
const rendered = (entry: { render(width: number): string[] }): string => strip(entry.render(160).join("\n"));

/** A stand-in for the pre-patch host class: same class, original methods restored. */
function stockEntry(): InstanceType<typeof entryClass> {
  const entry = new entryClass(block);
  Object.defineProperty(entry, "updateDisplay", { value: stockUpdateDisplay, configurable: true });
  Object.defineProperty(entry, "handleMouse", { value: stockHandleMouse, configurable: true });
  entry.setExpanded(false);
  return entry;
}

test("skill-label: the real 0.86 host renders labels below MouseRegion → Container", () => {
  const entry = new entryClass(block);
  assert.equal(entry.children.length, 1, "0.86 wraps the entry content in one child");
  const region = entry.children[0] as { onMouse?: unknown; child?: unknown };
  assert.equal(typeof region.onMouse, "function", "that child is the host's MouseRegion");
  const container = region.child as { children?: unknown[] };
  assert.ok(Array.isArray(container?.children), "the MouseRegion holds the Container of label nodes");
  assert.equal(
    container.children?.some((child) => typeof (child as { text?: unknown }).text === "string"),
    true,
    "the label nodes live two levels below the entry",
  );
});

test("skill-label: the real host still lists only the first name without the patch", () => {
  const stock = rendered(stockEntry());
  assert.equal(stock.includes("alpha + beta"), false, "stock host renders the first name only");
  assert.equal(stock.includes("[skill] alpha"), true);
});

test("skill-label: collapsed label and expanded title list every name on the real host", () => {
  const entry = new entryClass(block);
  const collapsed = rendered(entry);
  assert.equal(collapsed.includes("[skill]"), true, "collapsed label keeps the host's token");
  assert.equal(collapsed.includes("alpha + beta"), true, `collapsed label must list every skill:\n${collapsed}`);
  assert.equal(collapsed.includes("body of beta"), false, "collapsed entries hide the body");

  entry.setExpanded(true);
  const expanded = rendered(entry);
  assert.equal(expanded.includes("alpha + beta"), true, `expanded title must list every skill:\n${expanded}`);
  assert.equal(expanded.includes("body of beta"), true, "skill bodies stay intact");
  assert.equal(skillNames({ name: "alpha", content: block.content }).join("+"), "alpha+beta", "names and order unchanged");

  entry.setExpanded(false);
  assert.equal(rendered(entry).includes("alpha + beta"), true, "collapsing rebuilds the joined label");
});

test("skill-fold: one left press+click toggles once on the real host component", () => {
  const entry = new entryClass(block);
  const region = entry.children[0] as { onMouse: (event: unknown) => unknown };
  let nativeHandlerCalls = 0;
  const nativeOnMouse = region.onMouse;
  region.onMouse = (event: unknown) => {
    if ((event as { type?: string }).type === "click") nativeHandlerCalls += 1;
    return nativeOnMouse(event);
  };

  assert.deepEqual(entry.handleMouse({ type: "press", button: "left" }), { handled: true });
  assert.equal(rendered(entry).includes("body of beta"), false, "the press alone never toggles");
  assert.deepEqual(entry.handleMouse({ type: "click", button: "left" }), { handled: true });
  assert.equal(rendered(entry).includes("body of beta"), true, "the synthesized click expands once");
  assert.equal(nativeHandlerCalls, 0, "the entry-level patch consumes the toggle; the embedded MouseRegion must not repeat it");

  entry.handleMouse({ type: "press", button: "left" });
  entry.handleMouse({ type: "click", button: "left" });
  assert.equal(rendered(entry).includes("body of beta"), false, "a second full gesture collapses again");
  assert.equal(nativeHandlerCalls, 0);
});

test("skill-fold: modified presses stay unclaimed so selection keeps the gesture", () => {
  const entry = new entryClass(block);
  for (const modifier of [{ shift: true }, { ctrl: true }, { alt: true }]) {
    assert.equal(
      entry.handleMouse({ type: "press", button: "left", ...modifier }),
      undefined,
      `a left press with ${Object.keys(modifier)[0]} must not claim the gesture`,
    );
  }
  assert.equal(rendered(entry).includes("body of beta"), false, "modified gestures never toggle");

  // Right/middle buttons and wheel events keep the base forwarding behavior.
  assert.equal(entry.handleMouse({ type: "press", button: "right" }), undefined);
  assert.equal(entry.handleMouse({ type: "wheel", button: "none" }), undefined);
  assert.equal(rendered(entry).includes("body of beta"), false);
});
