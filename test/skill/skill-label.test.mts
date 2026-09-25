import assert from "node:assert/strict";
import test from "node:test";
import { installSkillLabelNames, joinSkillLabel, skillNames } from "../../src/skill-label.ts";

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

test("skill-label: the patch is idempotent, conservative and safe on anything else", () => {
  class Fresh { updateDisplay(): void {} }
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
  class OddEntry {
    skillBlock = { name: "alpha", content: nestedContent(["beta"]) };
    children: unknown[] = [];
    updateDisplay(): void {
      this.children = [{ text: "read-only" }, { text: 42, setText: () => {} }, null, "plain"];
    }
  }
  assert.equal(installSkillLabelNames(OddEntry), "patched");
  assert.doesNotThrow(() => new OddEntry().updateDisplay());
});
