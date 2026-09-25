// Skill discovery uses isolated directories, never the user's HOME or settings.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { createSkillMux, createSkillAutocompleteWrapper } from "../../src/skill-mux.ts";

function writeSkill(root: string, dirName: string, name: string, body: string) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  return file;
}

function fixture(t: TestContext) {
  const root = temporaryDirectory(t);
  const agentDir = join(root, "agent");
  const cwd = join(root, "proj");
  const fixtures = join(root, "skill-fixtures");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const files = {
    alpha: writeSkill(fixtures, "alpha-dir", "alpha", "Alpha body line one.\nAlpha body line two."),
    beta: writeSkill(fixtures, "beta-dir", "beta", "Beta body."),
    gamma: writeSkill(join(agentDir, "skills"), "gamma-dir", "gamma", "Gamma body."),
    delta: writeSkill(join(cwd, ".pi", "skills"), "delta-dir", "delta", "Delta body."),
    epsilon: writeSkill(join(root, "ext-skills"), "epsilon-dir", "epsilon", "Epsilon body."),
  };
  const disabled = writeSkill(fixtures, "off-dir", "offskill", "must not appear");
  const extDir = join(agentDir, "extensions", "some-ext");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "package.json"), JSON.stringify({ name: "some-ext", pi: { skills: [join(root, "ext-skills")] } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    skills: [files.alpha, { path: files.beta, enabled: true }, { path: disabled, enabled: false }, { nope: 1 }, 42],
  }));
  writeFileSync(join(cwd, ".pi", "settings.local.json"), JSON.stringify({ skills: "not-an-array" }));
  return { files, mux: createSkillMux({ agentDir, cwd }) };
}

const block = (name: string, file: string, body: string) =>
  `<skill name="${name}" location="${file}">\nReferences are relative to ${resolve(file, "..")}.\n\n${body}\n</skill>`;

test("non-skill and single-skill inputs remain the host's job", (t) => {
  const { mux } = fixture(t);
  for (const input of ["hello world", "/skill:alpha hello", " /skill:alpha /skill:beta", "$alpha rest", "plain"]) {
    assert.equal(mux.expand(input), null, input);
  }
  assert.equal(mux.onInput({ text: "plain" }).action, "continue");
});

test("two skills expand to nested host-format blocks with trailing text", (t) => {
  const { mux, files } = fixture(t);
  const out = mux.expand("/skill:alpha /skill:beta do the thing");
  const a = block("alpha", files.alpha, "Alpha body line one.\nAlpha body line two.");
  const b = block("beta", files.beta, "Beta body.");
  // Host parsing stops at the first closing tag; sibling blocks would render raw.
  assert.equal(out, `${a.slice(0, -"</skill>".length)}\n\n${b}\n</skill>\n\ndo the thing`);
  assert.doesNotMatch(out!, /<\/skill>\n\n<skill|description:|---/);
  assert.equal((out!.match(/<skill name=/g) ?? []).length, 2);
});

test("settings-declared, default-dir, and project-dir skills all resolve", (t) => {
  const { mux, files } = fixture(t);
  const out = mux.expand("/skill:delta /skill:gamma tail");
  for (const name of ["delta", "gamma"] as const) assert.ok(out!.includes(`<skill name="${name}" location="${files[name]}">`));
  assert.ok(out!.endsWith("\n\ntail"));
});

test("unknown skill remains literal while known skills expand", (t) => {
  const { mux } = fixture(t);
  const out = mux.expand("/skill:nope /skill:beta");
  assert.match(out!, /^\/skill:nope\n\n<skill name="beta"/);
  assert.doesNotMatch(out!, /<skill name="nope"/);
});

test("extension skills resolve on miss-rebuild; repeated misses are cached", (t) => {
  const { mux, files } = fixture(t);
  assert.ok(mux.expand("/skill:epsilon /skill:alpha")!.includes(`<skill name="epsilon" location="${files.epsilon}">`));
  assert.equal(mux.stats().builds, 2);
  for (let i = 0; i < 2; i++) {
    assert.match(mux.expand("/skill:nope2 /skill:beta")!, /^\/skill:nope2/);
    assert.equal(mux.stats().builds, 3, "one sweep for a new miss, none for a cached miss");
  }
  assert.equal(mux.stats().misses, 1);
});

test("onInput transforms and passes images through by identity", (t) => {
  const { mux } = fixture(t);
  for (const images of [[{ type: "image", url: "file:///x.png" }], undefined]) {
    const result = mux.onInput({ text: "/skill:alpha /skill:beta go", images });
    assert.ok(result.action === "transform");
    assert.equal(result.images, images);
    assert.ok(result.text.includes("go"));
  }
});

test("a lone ￥ trigger expands here instead of passing through the host", (t) => {
  const { mux, files } = fixture(t);
  assert.equal(mux.expand("￥alpha just do it"), `${block("alpha", files.alpha, "Alpha body line one.\nAlpha body line two.")}\n\njust do it`);
});

const skills = [
  { name: "alpha", description: "the alpha skill" },
  { name: "beta", description: "the beta skill" },
  { name: "alphabet", description: "longer" },
];
const baseResult = { items: [{ value: "builtin", label: "builtin" }], prefix: "/skill:a" };

test("autocomplete preserves native precedence, matches partial skills and replaces only that token", async () => {
  const wrapped = createSkillAutocompleteWrapper(() => skills)({
    async getSuggestions() { return null; },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const start = cursorCol - prefix.length;
      const next = [...lines];
      next[cursorLine] = next[cursorLine].slice(0, start) + item.value + next[cursorLine].slice(cursorCol);
      return { lines: next, cursorLine, cursorCol: start + item.value.length };
    },
  });
  const yen = await wrapped.getSuggestions(["￥al"], 0, 3, {});
  assert.ok(yen && "items" in yen);
  assert.equal(yen.prefix, "￥al");
  assert.deepEqual(yen.items.map((item) => item.value), ["￥alpha ", "￥alphabet "]);
  assert.equal(yen.items[0].label, "skill:alpha");
  assert.equal(yen.items[0].description, "the alpha skill");
  const second = await wrapped.getSuggestions(["/skill:alpha /ta"], 0, 16, {});
  assert.ok(second && "items" in second);
  assert.deepEqual(second.items.map((item) => item.value), ["/skill:beta "]);
  assert.equal(second.prefix, "/ta");
  for (const [text, column] of [["/skill:alpha /zzz", 17], ["hello /", 7]] as const) {
    assert.equal(await wrapped.getSuggestions([text], 0, column, {}), null);
  }
  const applied = wrapped.applyCompletion(["/skill:alpha /b tail"], 0, 15, { value: "/skill:beta " }, "/b");
  assert.equal(applied.lines[0], "/skill:alpha /skill:beta  tail");
  assert.equal(applied.cursorCol, 25);
  const native = createSkillAutocompleteWrapper(() => skills)({ async getSuggestions() { return baseResult; } });
  assert.equal(await native.getSuggestions(["/skill:a"], 0, 8, {}), baseResult);
});

test("Tab-force reaches skills at a bare second token, otherwise preserves the native file menu", async () => {
  const fileResult = { items: [{ value: "./file.txt", label: "./file.txt" }], prefix: "/" };
  const getSkills = () => skills.slice(0, 2);
  const wrapped = createSkillAutocompleteWrapper(getSkills)({
    async getSuggestions(_lines, _line, _col, options) { return options?.force ? fileResult : null; },
    applyCompletion() { throw new Error("not reached"); },
    shouldTriggerFileCompletion() { return false; },
  });
  for (const [text, column, trigger] of [
    ["/skill:alpha /", 14, true], ["/skill:alpha ￥", 15, true], ["￥alpha /", 9, true], ["plain text", 10, false],
  ] as const) assert.equal(wrapped.shouldTriggerFileCompletion?.([text], 0, column), trigger);
  const forced = await wrapped.getSuggestions(["/skill:alpha /"], 0, 14, { force: true });
  assert.ok(forced && "items" in forced);
  assert.deepEqual(forced.items.map((item) => item.value), ["/skill:alpha ", "/skill:beta "]);
  assert.equal(forced.prefix, "/");
  for (const [text, column] of [["/skill:alpha /zzz", 17], ["/etc/", 5]] as const) {
    assert.equal(await wrapped.getSuggestions([text], 0, column, { force: true }), fileResult);
  }
  const native = createSkillAutocompleteWrapper(getSkills)({ async getSuggestions() { return baseResult; } });
  assert.equal(await native.getSuggestions(["/skill:alpha /a"], 0, 15, {}), baseResult);
});
