import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { createSkillMux } from "../../src/skill-mux.ts";
import { DefaultResourceLoader, SettingsManager, loadSkills, parseSkillBlock, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function writeSkill(root: string, dirName: string, name: string, body: string) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  return file;
}

test("Pi-loaded skill resources drive expansion and stay current after resource reload", (t) => {
  const root = temporaryDirectory(t);
  const files: Record<string, string> = {
    alpha: writeSkill(root, "alpha-dir", "alpha", "Alpha body line one.\nAlpha body line two."),
    beta: writeSkill(root, "beta-dir", "beta", "Beta body."),
    gamma: writeSkill(root, "gamma-dir", "gamma", "Gamma body."),
    delta: writeSkill(root, "delta-dir", "delta", "Delta body."),
    epsilon: writeSkill(root, "epsilon-dir", "epsilon", "Epsilon body."),
  };
  type Command = ReturnType<ExtensionAPI["getCommands"]>[number];
  const loaded = loadSkills({ cwd: root, agentDir: join(root, "agent"), skillPaths: Object.values(files), includeDefaults: false }).skills;
  let commands = loaded.map<Command>(skill => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill",
    sourceInfo: { path: skill.filePath, source: "local", scope: "temporary", origin: "package", baseDir: root } }));
  let ready = false;
  const mux = createSkillMux({ getCommands: () => { assert.ok(ready, "core API must be read after binding"); return commands; } });
  assert.equal(mux.expand("plain message"), null);
  ready = true;
  const out = mux.expand("/skill:alpha /skill:beta do the thing");
  for (const [name, body] of [["alpha", "Alpha body line one.\nAlpha body line two."], ["beta", "Beta body."]]) {
    assert.ok(
      out!.includes(
        `<skill name="${name}" location="${files[name]}">\nReferences are relative to ${resolve(files[name], "..")}.\n\n${body}\n`,
      ),
    );
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
  assert.deepEqual(mux.listSkills().map(skill => skill.name), ["alpha", "beta", "delta", "epsilon", "gamma"]);
  assert.ok(mux.expand("/skill:epsilon /skill:alpha")!.includes(`<skill name="epsilon" location="${files.epsilon}">`));
  assert.match(mux.expand("/skill:nope2 /skill:beta")!, /^\/skill:nope2/);
  commands = commands.filter(command => command.name !== "skill:alpha");
  assert.ok(!mux.listSkills().some(skill => skill.name === "alpha"));
  assert.match(mux.expand("/skill:alpha /skill:beta")!, /^\/skill:alpha\n\n<skill name="beta"/);
  commands.push({ ...commands[0]!, name: "skill:offskill", source: "extension" });
  assert.match(mux.expand("/skill:offskill /skill:beta")!, /^\/skill:offskill\n\n<skill name="beta"/);
});

test("Metis package skills load with local references and obey Pi resource filters on reload", async (t) => {
  const root = temporaryDirectory(t);
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const entry = { source: packageRoot, extensions: [], prompts: [], themes: [] };
  const settingsManager = SettingsManager.inMemory({ packages: [entry] });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager,
    noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  assert.deepEqual(diagnostics, []);
  const skill = skills.find(skill => skill.name === "ast-grep");
  assert.ok(skill, "discover the declared package resource, not a user-directory copy");
  assert.equal(skill.filePath, join(packageRoot, "skills/ast-grep/SKILL.md"));
  assert.equal(skill.sourceInfo.origin, "package");
  assert.match(readFileSync(join(skill.baseDir, "references/rule_reference.md"), "utf8"), /Relational Rules/);
  const mux = createSkillMux({ getCommands: () => loader.getSkills().skills.map(skill => ({
    name: `skill:${skill.name}`, description: skill.description, source: "skill", sourceInfo: skill.sourceInfo,
  })) });
  assert.equal(mux.expand("/skill:ast-grep inspect calls"), null, "the host owns a lone native skill invocation");
  const expanded = mux.expand("￥ast-grep inspect calls");
  assert.ok(expanded);
  assert.match(expanded, /References are relative to .*skills[\\/]ast-grep/);
  assert.match(expanded, /Structural Search/);
  assert.ok(expanded.endsWith("\n\ninspect calls"));

  settingsManager.setPackages([{ ...entry, skills: ["-skills/ast-grep/SKILL.md"] }]);
  await loader.reload();
  assert.deepEqual(loader.getSkills().diagnostics, []);
  assert.ok(!mux.listSkills().some(skill => skill.name === "ast-grep"));
  assert.equal(mux.expand("￥ast-grep inspect calls"), null, "no private scan bypasses package filtering");

  settingsManager.setPackages([{ ...entry, skills: [] }]);
  await loader.reload();
  assert.ok(!loader.getSkills().skills.some(skill => skill.name === "ast-grep"));
  settingsManager.setPackages([entry]);
  await loader.reload();
  assert.ok(mux.expand("￥ast-grep inspect calls"));
});
