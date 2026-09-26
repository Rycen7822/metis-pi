import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { SkillInvocationMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { MouseRegion, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { installSkillLabelNames } from "../../src/skill-label.ts";
import { installSkillFoldClick } from "../../src/skill-fold.ts";

initTheme("dark", false);
const block = {
  name: "skill", location: "/skills/skill/SKILL.md", userMessage: undefined,
  content: `<skill name=" other " location="/skills/other/SKILL.md">
body of other
</skill>
<skill name="skill" location="/skills/skill/SKILL.md">
repeated body
</skill>`,
};
const rendered = (entry: SkillInvocationMessageComponent) => strip(entry.render(160).join("\n"));
const mouse = (type: TuiMouseEvent["type"], extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type, button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 160, height: 10,
  shift: false, alt: false, ctrl: false, ...extra,
});

test("native skill labels and gestures survive rebuilds without stealing selection", (t) => {
  class Entry extends SkillInvocationMessageComponent {}
  const forwarded = { handled: true as const };
  // A prior plugin owns unclaimed events; native construction and toggles stay real.
  const prior = t.mock.method(Entry.prototype, "handleMouse", () => forwarded);
  assert.equal(installSkillLabelNames(Entry), "patched");
  assert.equal(installSkillFoldClick(Entry), "patched");
  const display = Reflect.get(Entry.prototype, "updateDisplay");
  const handler = Entry.prototype.handleMouse;
  assert.equal(installSkillLabelNames(Entry), "already");
  assert.equal(installSkillFoldClick(Entry), "already");
  assert.equal(Reflect.get(Entry.prototype, "updateDisplay"), display);
  assert.equal(Entry.prototype.handleMouse, handler);
  // Only Entry is patched; the native class renders the literal expected name.
  const baseline = new SkillInvocationMessageComponent({ ...block, name: "skill + other" });
  const entry = new Entry(block);
  assert.deepEqual(entry.render(160), baseline.render(160), "names join without changing native ANSI or hints");
  assert.deepEqual(new Entry({ ...block, name: " skill " }).render(160), baseline.render(160), "outer names are trimmed");
  const single = { ...block, content: "single skill body" };
  assert.deepEqual(new Entry(single).render(160), new SkillInvocationMessageComponent(single).render(160), "single skills stay native");
  assert.doesNotMatch(rendered(entry), /body of other/);
  const invalidation = t.mock.method(entry, "invalidate");
  for (const expanded of [true, false]) {
    const region = entry.children[0];
    assert.ok(region instanceof MouseRegion);
    const nativeHandler = t.mock.method(region, "handleMouse");
    assert.deepEqual(entry.handleMouse(mouse("press")), { handled: true });
    assert.equal(rendered(entry).includes("body of other"), !expanded, "press never toggles");
    const before = invalidation.mock.callCount();
    assert.deepEqual(entry.handleMouse(mouse("click")), { handled: true });
    baseline.setExpanded(expanded);
    assert.deepEqual(entry.render(160), baseline.render(160), "rebuilt labels and the entire body retain native rendering");
    assert.equal(rendered(entry).includes("body of other"), expanded);
    assert.equal(invalidation.mock.callCount() - before, 1, "one click invalidates one cached frame");
    assert.equal(nativeHandler.mock.callCount(), 0, "the nested native handler must not toggle again");
  }
  assert.equal(prior.mock.callCount(), 0, "accepted gestures never reach the prior handler");
  const before = invalidation.mock.callCount();
  const events = [
    mouse("press", { shift: true }), mouse("click", { ctrl: true }), mouse("click", { alt: true }),
    mouse("press", { button: "right" }), mouse("wheel", { button: "none" }), mouse("release"), undefined,
  ];
  for (const event of events) {
    assert.equal(Reflect.apply(entry.handleMouse, entry, [event]), forwarded, "prior return identity survives");
    assert.equal(prior.mock.calls.at(-1)?.this, entry, "prior handler keeps its receiver");
  }
  assert.deepEqual(prior.mock.calls.map((call) => call.arguments), events.map((event) => [event]));
  assert.doesNotMatch(rendered(entry), /body of other/);
  assert.equal(invalidation.mock.callCount(), before, "selection and delegated events leave the cached frame intact");
});
