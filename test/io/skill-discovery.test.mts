// Skill discovery uses isolated directories, never the user's HOME or settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { createSkillMux } from "../../src/skill-mux.ts";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";

function writeSkill(root: string, dirName: string, name: string, body: string) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  return file;
}

test("one discovery cache resolves declared, default, project and extension skills with native expansion", (t) => {
  const root = temporaryDirectory(t);
  const agentDir = join(root, "agent");
  const cwd = join(root, "proj");
  const fixtures = join(root, "skill-fixtures");
  mkdirSync(agentDir, { recursive: true });
  const files: Record<string, string> = {
    alpha: writeSkill(fixtures, "alpha-dir", "alpha", "Alpha body line one.\nAlpha body line two."),
    beta: writeSkill(fixtures, "beta-dir", "beta", "Beta body."),
  };
  const declared: unknown[] = [files.alpha, { path: files.beta, enabled: true }];
  files.gamma = writeSkill(join(agentDir, "skills"), "gamma-dir", "gamma", "Gamma body.");
  files.delta = writeSkill(join(cwd, ".pi", "skills"), "delta-dir", "delta", "Delta body.");
  files.epsilon = writeSkill(join(root, "ext-skills"), "epsilon-dir", "epsilon", "Epsilon body.");
  declared.push({ path: writeSkill(fixtures, "off-dir", "offskill", "must not appear"), enabled: false }, { nope: 1 }, 42);
  const extDir = join(agentDir, "extensions", "some-ext");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "package.json"), JSON.stringify({ name: "some-ext", pi: { skills: [join(root, "ext-skills")] } }));
  writeFileSync(join(cwd, ".pi", "settings.local.json"), JSON.stringify({ skills: "not-an-array" }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: declared }));
  const mux = createSkillMux({ agentDir, cwd });
  const out = mux.expand("/skill:alpha /skill:beta do the thing");
  for (const [name, body] of [["alpha", "Alpha body line one.\nAlpha body line two."], ["beta", "Beta body."]]) {
    assert.ok(out!.includes(`<skill name="${name}" location="${files[name]}">\nReferences are relative to ${resolve(files[name], "..")}.\n\n${body}\n`));
  }
  assert.doesNotMatch(out!, /description:|---/);
  const parsed = parseSkillBlock(out!);
  assert.ok(parsed, "real Pi parser accepts one folded leading skill block");
  assert.equal(parsed.name, "alpha");
  assert.match(parsed.content, /<skill name="beta"/);
  assert.equal(parsed.userMessage, "do the thing");

  const local = mux.expand("/skill:delta /skill:gamma tail");
  for (const name of ["delta", "gamma"] as const) assert.ok(local!.includes(`<skill name="${name}" location="${files[name]}">`));
  assert.ok(local!.endsWith("\n\ntail"));
  assert.equal(mux.stats().builds, 1, "all known skills share the initial index");

  assert.ok(mux.expand("/skill:epsilon /skill:alpha")!.includes(`<skill name="epsilon" location="${files.epsilon}">`));
  assert.equal(mux.stats().builds, 2);
  for (let i = 0; i < 2; i++) {
    assert.match(mux.expand("/skill:nope2 /skill:beta")!, /^\/skill:nope2/);
    assert.equal(mux.stats().builds, 3, "one sweep for a new miss, none for a cached miss");
  }
  assert.equal(mux.stats().misses, 1);
  assert.match(mux.expand("/skill:offskill /skill:alpha")!, /^\/skill:offskill\n\n<skill name="alpha"/);
});
