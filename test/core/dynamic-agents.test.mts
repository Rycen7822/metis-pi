import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadPolicy, matches, parseConfig, projectMessages, replaceGlobal } from "../../src/dynamic-agents.ts";

test("provider globs, literal punctuation and cross-provider terminal IDs", () => {
  const flash = { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" };
  for (const pattern of ["commandcode/*", "commandcode/deepseek/*", "*/deepseek/*", "deepseek-v4.1-flash", "*flash"])
    assert.ok(matches(pattern, flash), pattern);
  for (const pattern of [
    "openai-codex/*",
    "deepseek-v4X1-flash",
    "Deepseek-v4.1-flash",
    "commandcode/deepseek/*-deepseek-v4.1-flash",
  ])
    assert.equal(matches(pattern, flash), false, pattern);
  assert.ok(matches("deepseek-v4.1-flash", { provider: "another", id: "deepseek-v4.1-flash" }));
  assert.ok(matches("a+b(1)", { provider: "p", id: "a+b(1)" }));
  assert.equal(matches("a+b(1)", { provider: "p", id: "aaab1" }), false);
});

test("first matching group with local exclusions, atomic fallback and relative paths", t => {
  const work = fileURLToPath(new URL("../../.work/", import.meta.url)); mkdirSync(work, { recursive: true });
  const dir = mkdtempSync(join(work, "dynamic-config-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "dynamic-agents.json");
  const config = { version: 1, notify: false, groups: [
    { id: "ordinary", file: "ordinary.md", include: ["commandcode/*"], exclude: ["deepseek-v4.1-flash"] },
    { id: "flash", file: "flash.md", include: ["deepseek-v4.1-flash"] },
    { id: "fallback", file: "missing.md", include: ["*"] },
  ] };
  writeFileSync(path, JSON.stringify(config)); writeFileSync(join(dir, "flash.md"), "FLASH"); writeFileSync(join(dir, "ordinary.md"), "ORDINARY");
  const flash = { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" };
  assert.deepEqual(loadPolicy(path, flash), { group: "flash", file: { path: join(dir, "flash.md"), content: "FLASH" }, notify: false });
  assert.equal(loadPolicy(path, { ...flash, id: "other" }).group, "ordinary");
  assert.ok(loadPolicy(path, { provider: "other", id: "other" }).error);
  writeFileSync(join(dir, "flash.md"), " "); assert.match(loadPolicy(path, flash).error!, /Empty policy/);
  writeFileSync(path, "{"); assert.ok(loadPolicy(path, flash).error); assert.equal(loadPolicy(path, flash).file, undefined);
  writeFileSync(path, JSON.stringify({ ...config, enabled: false })); assert.equal(loadPolicy(path, flash).file, undefined);
  assert.equal(loadPolicy(join(dir, "missing.json"), flash).file, undefined);
  assert.throws(() => parseConfig({ version: 1, groups: [config.groups[0], config.groups[0]] }), /unique/);
  assert.throws(() => parseConfig({ version: 1, groups: [], enabled: "false" }), /boolean/);
});

test("request projection replaces only source-labelled globals without rewriting session objects", () => {
  const global = { path: "/agent/AGENTS.md", content: "OLD_GLOBAL" };
  const project = { path: "/repo/AGENTS.md", content: "PROJECT_KEEP" };
  const policy = { path: "/agent/B.md", content: "NEW_POLICY" };
  const sources = new Set([global.path, policy.path]);
  const files = [global, project];
  assert.deepEqual(replaceGlobal(files, sources, policy), [policy, project]);
  const section =
    "<project_context>\nProject-specific instructions and guidelines:\n\n" +
    `${files.map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`).join("\n\n")}` +
    "\n</project_context>";
  const messages = [
    {
      role: "system",
      content: "",
      sections: { project_context: section, skills: "SKILL_KEEP" },
      toolsAdded: ["TOOL_KEEP"],
    },
    { role: "user", content: "OLD_GLOBAL is quoted user data" },
  ];
  const original = JSON.stringify(messages);
  const projected = projectMessages(messages, sources, policy);
  assert.doesNotMatch(projected[0]!.sections!.project_context, /OLD_GLOBAL/);
  assert.match(projected[0]!.sections!.project_context, /NEW_POLICY/);
  assert.match(projected[0]!.sections!.project_context, /PROJECT_KEEP/);
  assert.equal(projected[1], messages[1]); assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(projectMessages(projected, sources, policy), projected);
  assert.deepEqual(projected[0]!.toolsAdded, ["TOOL_KEEP"]);
  assert.equal(projected[0]!.sections!.skills, "SKILL_KEEP");
  const restored = projectMessages(projected, sources, global);
  assert.doesNotMatch(restored[0]!.sections!.project_context, /NEW_POLICY/);
  assert.match(restored[0]!.sections!.project_context, /OLD_GLOBAL/);
});
