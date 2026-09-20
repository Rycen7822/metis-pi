import assert from "node:assert/strict";
import test from "node:test";
import { installSkillLabelNames, joinSkillLabel, skillNames } from "../../src/skill-label.ts";

/** Stand-in for the pi-tui Text/Markdown children the patch rewrites. */
class FakeText {
  text: string;
  writes: string[] = [];
  constructor(text: string) {
    this.text = text;
  }
  setText(text: string): void {
    this.text = text;
    this.writes.push(text);
  }
}

/** Stand-in for the host component: its updateDisplay builds fresh children. */
class FakeSkillEntry {
  skillBlock: { name: string; content: string };
  expanded = false;
  children: unknown[] = [];
  constructor(name: string, content = "") {
    this.skillBlock = { name, content };
  }
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.updateDisplay();
  }
  updateDisplay(): void {
    this.children = [];
    if (this.expanded) {
      this.children.push(new FakeText("\u001b[1m[skill]\u001b[22m"));
      this.children.push(new FakeText(`**${this.skillBlock.name}**\n\n${this.skillBlock.content}`));
    } else {
      this.children.push(new FakeText(`\u001b[1m[skill]\u001b[22m ${this.skillBlock.name}\u001b[2m (ctrl+o to expand)\u001b[22m`));
    }
  }
}

/** The exact shape skill-mux produces: later blocks nested in the first content. */
const nestedContent = (names: readonly string[]): string =>
  names.map((name) => `<skill name="${name}" location="/skills/${name}/SKILL.md">\nbody of ${name}\n</skill>`).join("\n\n");

test("skill-label: names come from the block itself plus every nested block", () => {
  assert.deepEqual(skillNames({ name: "alpha", content: "plain body" }), ["alpha"]);
  assert.deepEqual(skillNames({ name: "alpha", content: nestedContent(["beta"]) }), ["alpha", "beta"]);
  assert.deepEqual(skillNames({ name: "alpha", content: nestedContent(["beta", "gamma"]) }), ["alpha", "beta", "gamma"]);
  assert.deepEqual(
    skillNames({ name: "alpha", content: `x\n${nestedContent(["beta"])}\n${nestedContent(["alpha"])}` }),
    ["alpha", "beta"],
    "a repeated name is listed once",
  );
  assert.deepEqual(skillNames({ name: "  alpha  ", content: "" }), ["alpha"], "names are trimmed");
  assert.deepEqual(skillNames({ name: 42, content: null }), [], "non-string fields are ignored");
});

test("skill-label: the join swaps only the first rendered name after the token", () => {
  const label = "\u001b[1m[skill]\u001b[22m alpha\u001b[2m (ctrl+o to expand)\u001b[22m";
  assert.equal(
    joinSkillLabel(label, "alpha", ["alpha", "beta"]),
    "\u001b[1m[skill]\u001b[22m alpha + beta\u001b[2m (ctrl+o to expand)\u001b[22m",
    "styling and the keybinding hint survive untouched",
  );
  assert.equal(joinSkillLabel(label, "alpha", ["alpha"]), label, "a single skill renders as before");
  assert.equal(joinSkillLabel(label, "missing", ["alpha", "beta"]), label, "an unknown name is left alone");
  // The `[skill]` token itself must never be treated as the name.
  const trap = "[skill] skill (ctrl+o to expand)";
  assert.equal(joinSkillLabel(trap, "skill", ["skill", "other"]), "[skill] skill + other (ctrl+o to expand)");
  assert.equal(joinSkillLabel("no token here: alpha", "alpha", ["alpha", "beta"]), "no token here: alpha + beta");
});

test("skill-label: the entry's rendered labels list every name", () => {
  assert.equal(installSkillLabelNames(FakeSkillEntry), "patched");
  const entry = new FakeSkillEntry("alpha", nestedContent(["beta"]));
  entry.updateDisplay();
  assert.equal(
    (entry.children[0] as FakeText).text,
    "\u001b[1m[skill]\u001b[22m alpha + beta\u001b[2m (ctrl+o to expand)\u001b[22m",
  );

  // Expanded: the `**name**` header is joined as well, the body stays as sent.
  entry.setExpanded(true);
  assert.equal((entry.children[1] as FakeText).text, `**alpha + beta**\n\n${nestedContent(["beta"])}`);
  entry.setExpanded(false);
  assert.equal(
    (entry.children[0] as FakeText).text.includes("alpha + beta"),
    true,
    "collapsing rebuilds the joined label (the host regenerates from the plain name)",
  );

  const single = new FakeSkillEntry("solo", "just me");
  single.updateDisplay();
  assert.equal((single.children[0] as FakeText).writes.length, 0, "a single skill is never rewritten");
});

test("skill-label: the patch is idempotent, conservative and safe on anything else", () => {
  class Fresh extends FakeSkillEntry {}
  assert.equal(installSkillLabelNames(Fresh), "patched");
  const before = Fresh.prototype.updateDisplay;
  assert.equal(installSkillLabelNames(Fresh), "already");
  assert.equal(Fresh.prototype.updateDisplay, before, "updateDisplay is not wrapped twice");

  assert.equal(installSkillLabelNames(undefined), "missing");
  assert.equal(installSkillLabelNames({}), "missing");
  assert.equal(installSkillLabelNames({ prototype: "nope" }), "missing");
  class NoDisplay {}
  assert.equal(installSkillLabelNames(NoDisplay), "missing", "a class without updateDisplay is not patched");

  // Children the host may add later (no text, or no setter) are skipped, and an
  // entry with a single skill is never touched.
  class OddEntry extends FakeSkillEntry {
    updateDisplay(): void {
      this.children = [{ text: "read-only" }, { text: 42, setText: () => {} }, null, "plain"];
    }
  }
  assert.equal(installSkillLabelNames(OddEntry), "patched");
  assert.doesNotThrow(() => new OddEntry("alpha", nestedContent(["beta"])).updateDisplay());
});

test("skill-label: the real host class is patchable and keeps its own surface", async () => {
  const host = await import("@earendil-works/pi-coding-agent");
  const prototype = host.SkillInvocationMessageComponent.prototype as unknown as {
    updateDisplay: (this: unknown) => void;
  };
  const before = prototype.updateDisplay;
  // No instance is built here: the real updateDisplay renders through the host's
  // global theme, which a bare node process has not bootstrapped. The pty stage
  // asserts the rendered frame; this covers the prototype contract.
  assert.equal(installSkillLabelNames(host.SkillInvocationMessageComponent), "patched");
  assert.notEqual(prototype.updateDisplay, before, "the host's updateDisplay is wrapped");
  assert.equal(installSkillLabelNames(host.SkillInvocationMessageComponent), "already");
  assert.equal(typeof prototype.updateDisplay, "function");
});
