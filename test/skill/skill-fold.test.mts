import assert from "node:assert/strict";
import test from "node:test";
import { installSkillFoldClick } from "../../src/skill-fold.ts";

/** Stand-in for the host component: Box-like base + the fields the patch uses. */
class FakeBox {
  childHandled: string | undefined;
  handleMouse(event?: { type?: string; button?: string; shift?: boolean; ctrl?: boolean; alt?: boolean }): { handled: true } | undefined {
    // Box forwards to its children; the host's children (Text/Markdown) never
    // claim, but keep one child that does so delegation can be observed.
    if (this.childHandled && event?.type === this.childHandled) return { handled: true };
    return undefined;
  }
}

class FakeSkillEntry extends FakeBox {
  expanded = false;
  invalidations = 0;
  states: boolean[] = [];
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.states.push(expanded);
  }
  invalidate(): void {
    this.invalidations += 1;
  }
}

test("skill-fold: left click toggles the entry and claims the gesture", () => {
  assert.equal(installSkillFoldClick(FakeSkillEntry), "patched");
  const entry = new FakeSkillEntry();

  // A plain left press is claimed so pi-tui records the gesture target...
  assert.deepEqual(entry.handleMouse({ type: "press", button: "left" }), { handled: true });
  assert.deepEqual(entry.states, [], "the press alone never toggles");
  // ...and the synthesized click flips the state (expand, then collapse).
  assert.deepEqual(entry.handleMouse({ type: "click", button: "left" }), { handled: true });
  assert.deepEqual(entry.states, [true]);
  assert.equal(entry.invalidations, 1, "cached render is dropped");
  entry.handleMouse({ type: "click", button: "left" });
  assert.deepEqual(entry.states, [true, false]);
  assert.equal(entry.expanded, false, "second click collapses again");
});

test("skill-fold: modified clicks, other buttons and non-click events stay with the base", () => {
  installSkillFoldClick(FakeSkillEntry);
  const entry = new FakeSkillEntry();
  entry.childHandled = "release"; // the base claims this one

  entry.handleMouse({ type: "press", button: "left", shift: true });
  entry.handleMouse({ type: "click", button: "left", ctrl: true });
  entry.handleMouse({ type: "click", button: "left", alt: true });
  assert.deepEqual(entry.states, [], "modified clicks select text instead of toggling");
  assert.equal(entry.handleMouse({ type: "press", button: "right" }), undefined);
  assert.equal(entry.handleMouse({ type: "wheel", button: "none" }), undefined);
  assert.deepEqual(entry.handleMouse({ type: "release", button: "left" }), { handled: true },
    "unhandled events still reach Box's child forwarding");
  assert.equal(entry.invalidations, 0);
});

test("skill-fold: install is idempotent and safe on anything else", () => {
  class Fresh extends FakeBox {
    expanded = false;
    setExpanded(expanded: boolean): void {
      this.expanded = expanded;
    }
  }
  assert.equal(installSkillFoldClick(Fresh), "patched");
  const first = Fresh.prototype.handleMouse;
  assert.equal(installSkillFoldClick(Fresh), "already");
  assert.equal(Fresh.prototype.handleMouse, first, "the handler is not wrapped twice");

  assert.equal(installSkillFoldClick(undefined), "missing");
  assert.equal(installSkillFoldClick({}), "missing");
  assert.equal(installSkillFoldClick({ prototype: "nope" }), "missing");
  // A host class without setExpanded still toggles nothing but must not throw
  // on unrelated events.
  class NoSetter { declare handleMouse: (event: { type: string }) => unknown; }
  assert.equal(installSkillFoldClick(NoSetter), "patched");
  assert.equal(new NoSetter().handleMouse({ type: "wheel" }), undefined);
});
