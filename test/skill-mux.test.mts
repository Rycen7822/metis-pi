// skill-mux tests — tmpdir only, never a real HOME or real settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSkillMux, matchSkillContext, createSkillAutocompleteWrapper, type SkillMux } from "../src/skill-mux.ts";

const makeDir = () => mkdtempSync(join(tmpdir(), "pcx-skillmux-"));

const writeSkill = (root: string, dirName: string, name: string, body: string): string => {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  return file;
};

interface Fixture {
  root: string;
  agentDir: string;
  cwd: string;
  mux: SkillMux;
  files: Record<string, string>;
}

const makeFixture = (): Fixture => {
  const root = makeDir();
  const agentDir = join(root, "agent");
  const cwd = join(root, "proj");
  const fixtures = join(root, "skill-fixtures");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });

  const files: Record<string, string> = {};
  // Declared via settings (string + object forms; a disabled one is skipped).
  files.alpha = writeSkill(fixtures, "alpha-dir", "alpha", "Alpha body line one.\nAlpha body line two.");
  files.beta = writeSkill(fixtures, "beta-dir", "beta", "Beta body.");
  const disabled = writeSkill(fixtures, "off-dir", "offskill", "must not appear");
  // Default agent dir + project dir discoveries.
  files.gamma = writeSkill(join(agentDir, "skills"), "gamma-dir", "gamma", "Gamma body.");
  files.delta = writeSkill(join(cwd, ".pi", "skills"), "delta-dir", "delta", "Delta body.");
  // Declared only via an extension manifest (found on the miss-rebuild sweep).
  const extDir = join(agentDir, "extensions", "some-ext");
  mkdirSync(extDir, { recursive: true });
  const epsRoot = join(root, "ext-skills");
  files.epsilon = writeSkill(epsRoot, "epsilon-dir", "epsilon", "Epsilon body.");
  writeFileSync(join(extDir, "package.json"), JSON.stringify({ name: "some-ext", pi: { skills: [epsRoot] } }));

  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      skills: [files.alpha, { path: files.beta, enabled: true }, { path: disabled, enabled: false }, { nope: 1 }, 42],
    }),
  );
  writeFileSync(join(cwd, ".pi", "settings.local.json"), JSON.stringify({ skills: "not-an-array" }));

  return { root, agentDir, cwd, files, mux: createSkillMux({ agentDir, cwd }) };
};

const block = (name: string, file: string, body: string): string =>
  `<skill name="${name}" location="${file}">\nReferences are relative to ${resolve(file, "..")}.\n\n${body}\n</skill>`;

test("non-skill input and single-skill input are left for the host", () => {
  const f = makeFixture();
  try {
    assert.equal(f.mux.expand("hello world"), null);
    assert.equal(f.mux.expand("/skill:alpha hello"), null, "one skill + args is the host's native job");
    assert.equal(f.mux.expand(" /skill:alpha /skill:beta"), null, "leading space: not the host syntax");
    assert.equal(f.mux.expand("$alpha rest"), null, "$ is NOT a skill trigger");
    assert.equal(f.mux.expand("plain"), null);
    assert.equal(f.mux.onInput({ text: "plain" }).action, "continue");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("two skills expand to host-format blocks with the trailing text", () => {
  const f = makeFixture();
  try {
    const out = f.mux.expand("/skill:alpha /skill:beta do the thing");
    const a = block("alpha", f.files.alpha, "Alpha body line one.\nAlpha body line two.");
    const b = block("beta", f.files.beta, "Beta body.");
    assert.equal(out, `${a}\n\n${b}\n\ndo the thing`);
    assert.ok(!out!.includes("description:"), "frontmatter is stripped");
    assert.ok(!out!.includes("---"), "frontmatter markers are stripped");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("N skills work; no trailing text yields blocks only", () => {
  const f = makeFixture();
  try {
    const out = f.mux.expand("/skill:alpha /skill:beta /skill:gamma");
    assert.ok(out!.startsWith(`<skill name="alpha" location="${f.files.alpha}">`));
    assert.equal((out!.match(/<skill name=/g) ?? []).length, 3);
    assert.ok(out!.endsWith("</skill>"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("settings-declared, default-dir, and project-dir skills all resolve", () => {
  const f = makeFixture();
  try {
    const out = f.mux.expand("/skill:delta /skill:gamma tail");
    assert.ok(out!.includes(`<skill name="delta" location="${f.files.delta}">`));
    assert.ok(out!.includes(`<skill name="gamma" location="${f.files.gamma}">`));
    assert.ok(out!.endsWith("\n\ntail"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unknown skill stays a literal token, known ones still expand", () => {
  const f = makeFixture();
  try {
    const out = f.mux.expand("/skill:nope /skill:beta");
    assert.ok(out!.startsWith("/skill:nope\n\n<skill name=\"beta\""));
    assert.ok(!out!.includes("<skill name=\"nope\""));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("extension-manifest skill resolves on the miss-rebuild; misses are cached", () => {
  const f = makeFixture();
  try {
    const out = f.mux.expand("/skill:epsilon /skill:alpha");
    assert.ok(out!.includes(`<skill name="epsilon" location="${f.files.epsilon}">`));
    assert.equal(f.mux.stats().builds, 2, "initial build + one miss-rebuild with the manifest sweep");
    // The same unknown name again: negative cache, no third build.
    const again = f.mux.expand("/skill:nope2 /skill:beta");
    assert.ok(again!.startsWith("/skill:nope2"));
    assert.equal(f.mux.stats().builds, 3, "a NEW miss costs exactly one sweep rebuild");
    const cached = f.mux.expand("/skill:nope2 /skill:beta");
    assert.ok(cached!.startsWith("/skill:nope2"));
    assert.equal(f.mux.stats().builds, 3, "remembered miss: no re-scan");
    assert.equal(f.mux.stats().misses, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("index is built once and reused across expansions", () => {
  const f = makeFixture();
  try {
    f.mux.expand("/skill:alpha /skill:beta");
    f.mux.expand("/skill:gamma /skill:delta");
    assert.equal(f.mux.stats().builds, 1, "no rebuild when every name resolves");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("onInput transforms with images passed through", () => {
  const f = makeFixture();
  try {
    const images = [{ type: "image", url: "file:///x.png" }];
    const result = f.mux.onInput({ text: "/skill:alpha /skill:beta go", images });
    assert.equal(result.action, "transform");
    if (result.action === "transform") {
      assert.equal(result.images, images);
      assert.ok(result.text.includes("go"));
    }
    const noImages = f.mux.onInput({ text: "/skill:alpha /skill:beta go" });
    assert.equal(noImages.action, "transform");
    if (noImages.action === "transform") assert.equal(noImages.images, undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("adjacent tokens without whitespace parse as one (host-consistent)", () => {
  const f = makeFixture();
  try {
    assert.equal(f.mux.expand("/skill:alpha/skill:beta"), null, "single unknown-ish token → host");
    assert.equal(f.mux.expand("￥alpha￥beta rest"), null, "glued ￥ token: unresolvable, pass through untouched");
    const out = f.mux.expand("/skill:alpha /skill:beta/skill:gamma tail");
    assert.ok(out!.includes("/skill:beta/skill:gamma"), "glued second token stays literal");
    assert.ok(out!.startsWith(`<skill name="alpha" location="${f.files.alpha}">`));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("￥ trigger: a lone ￥ token expands here (the host would send it literally)", () => {
  const f = makeFixture();
  try {
    const out = f.mux.expand("￥alpha just do it");
    const a = block("alpha", f.files.alpha, "Alpha body line one.\nAlpha body line two.");
    assert.equal(out, `${a}\n\njust do it`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("￥ trigger: multiple ￥ tokens and mixing with /skill: both work", () => {
  const f = makeFixture();
  try {
    const yen = f.mux.expand("￥alpha ￥beta tail");
    const a = block("alpha", f.files.alpha, "Alpha body line one.\nAlpha body line two.");
    const b = block("beta", f.files.beta, "Beta body.");
    assert.equal(yen, `${a}\n\n${b}\n\ntail`);
    const mixed = f.mux.expand("/skill:alpha ￥beta ￥gamma");
    assert.ok(mixed!.includes(`<skill name="alpha" location="${f.files.alpha}">`));
    assert.ok(mixed!.includes(`<skill name="beta" location="${f.files.beta}">`));
    assert.ok(mixed!.includes(`<skill name="gamma" location="${f.files.gamma}">`));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("￥ trigger: unresolvable tokens keep their ORIGINAL form", () => {
  const f = makeFixture();
  try {
    assert.equal(f.mux.expand("￥nope stuff"), null, "lone unresolvable ￥ token: text passes through untouched");
    const out = f.mux.expand("￥nope /skill:beta");
    assert.ok(out!.startsWith("￥nope\n\n<skill name=\"beta\""), "￥ token stays ￥, not rewritten to /skill:");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ---- autocomplete wrapper ---------------------------------------------------

test("matchSkillContext: only multi-skill positions qualify", () => {
  // First-token "/" is the host's job — never ours.
  assert.equal(matchSkillContext("/skill:co"), null);
  assert.equal(matchSkillContext("/anything"), null);
  assert.equal(matchSkillContext(""), null);
  // ￥ first token IS ours.
  assert.deepEqual(matchSkillContext("￥"), { partial: "￥", trigger: "￥", needle: "" });
  assert.deepEqual(matchSkillContext("￥co"), { partial: "￥co", trigger: "￥", needle: "co" });
  // After a complete skill token, "/" and "￥" partials are ours.
  assert.deepEqual(matchSkillContext("/skill:alpha /"), { partial: "/", trigger: "/", needle: "" });
  assert.deepEqual(matchSkillContext("/skill:alpha /b"), { partial: "/b", trigger: "/", needle: "b" });
  assert.deepEqual(matchSkillContext("/skill:alpha /skill:co"), { partial: "/skill:co", trigger: "/", needle: "co" });
  assert.deepEqual(matchSkillContext("￥alpha ￥"), { partial: "￥", trigger: "￥", needle: "" });
  assert.deepEqual(matchSkillContext("/skill:alpha ￥ga"), { partial: "￥ga", trigger: "￥", needle: "ga" });
  assert.deepEqual(matchSkillContext("/skill:alpha ￥beta /ga"), { partial: "/ga", trigger: "/", needle: "ga" });
  // Non-skill heads and mid-word slashes do not qualify.
  assert.equal(matchSkillContext("/todos /"), null);
  assert.equal(matchSkillContext("/skill:alpha mid/"), null);
  assert.equal(matchSkillContext("plain /"), null);
  assert.equal(matchSkillContext("/skill:alpha "), null, "no trigger typed after the space yet");
});

test("autocomplete wrapper: built-in wins; ours fills the multi-skill gap", async () => {
  const skills = [
    { name: "alpha", description: "the alpha skill" },
    { name: "beta", description: "the beta skill" },
    { name: "alphabet", description: "longer" },
  ];
  const baseResult = { items: [{ value: "builtin", label: "builtin" }], prefix: "/skill:a" };
  const current = {
    async getSuggestions() {
      return null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? "";
      const start = cursorCol - prefix.length;
      const next = [...lines];
      next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
      return { lines: next, cursorLine, cursorCol: start + item.value.length };
    },
  };
  const wrapped = createSkillAutocompleteWrapper(() => skills)(current);

  // ￥ first token: items carry the ￥ trigger, label mirrors the host form.
  const yen = await wrapped.getSuggestions(["￥al"], 0, 3, {});
  assert.ok(yen && "items" in yen);
  if (yen && "items" in yen) {
    assert.equal(yen.prefix, "￥al");
    assert.deepEqual(yen.items.map((i) => i.value), ["￥alpha ", "￥alphabet "]);
    assert.equal(yen.items[0].label, "skill:alpha");
    assert.equal(yen.items[0].description, "the alpha skill");
  }

  // Second token after "/skill:alpha ": "/" trigger normalizes to /skill:.
  const second = await wrapped.getSuggestions(["/skill:alpha /ta"], 0, 16, {});
  assert.ok(second && "items" in second);
  if (second && "items" in second) {
    assert.deepEqual(second.items.map((i) => i.value), ["/skill:beta "]);
    assert.equal(second.prefix, "/ta");
  }

  // No match → null (editor shows no menu, nothing breaks).
  assert.equal(await wrapped.getSuggestions(["/skill:alpha /zzz"], 0, 17, {}), null);
  // No context → null.
  assert.equal(await wrapped.getSuggestions(["hello /"], 0, 7, {}), null);

  // applyCompletion replaces exactly the partial token, preserving the rest.
  const applied = wrapped.applyCompletion(["/skill:alpha /b tail"], 0, 15, { value: "/skill:beta " }, "/b");
  assert.equal(applied.lines[0], "/skill:alpha /skill:beta  tail");
  assert.equal(applied.cursorCol, 25);

  // The built-in provider's answer always wins.
  const withBase = createSkillAutocompleteWrapper(() => skills)({
    async getSuggestions() {
      return baseResult;
    },
  });
  assert.equal(await withBase.getSuggestions(["/skill:a"], 0, 8, {}), baseResult);
});

test("autocomplete wrapper: Tab-force reaches the skill menu at a bare second '/'; ￥ triggers immediately", async () => {
  const skills = [
    { name: "alpha", description: "the alpha skill" },
    { name: "beta", description: "the beta skill" },
  ];
  const fileResult = { items: [{ value: "./file.txt", label: "./file.txt" }], prefix: "/" };
  const baseResult = { items: [{ value: "builtin", label: "builtin" }], prefix: "/skill:a" };
  const current = {
    async getSuggestions(_lines, _line, _col, options) {
      return options?.force ? fileResult : null; // built-in serves files on force
    },
    applyCompletion() {
      throw new Error("not reached in this test");
    },
    shouldTriggerFileCompletion() {
      return false; // built-in gate: plain text is not a file context
    },
  };
  const wrapped = createSkillAutocompleteWrapper(() => skills)(current);

  // The editor gates forced (Tab) queries behind shouldTriggerFileCompletion:
  // a multi-skill context must let them through even though nothing is file-like.
  assert.equal(wrapped.shouldTriggerFileCompletion?.(["/skill:alpha /"], 0, 14), true);
  assert.equal(wrapped.shouldTriggerFileCompletion?.(["/skill:alpha ￥"], 0, 15), true);
  assert.equal(wrapped.shouldTriggerFileCompletion?.(["￥alpha /"], 0, 9), true);
  // Outside our context the built-in gate decides unchanged.
  assert.equal(wrapped.shouldTriggerFileCompletion?.(["plain text"], 0, 10), false);

  // Force + multi-skill context: OUR items win over the built-in's file items
  // (a Tab at a bare second "/" means "show skills", not "show files").
  const forced = await wrapped.getSuggestions(["/skill:alpha /"], 0, 14, { force: true });
  assert.ok(forced && "items" in forced);
  if (forced && "items" in forced) {
    assert.deepEqual(forced.items.map((i) => i.value), ["/skill:alpha ", "/skill:beta "]);
    assert.equal(forced.prefix, "/");
  }
  // Force with a needle that matches no skill falls back to the built-in files.
  assert.equal(await wrapped.getSuggestions(["/skill:alpha /zzz"], 0, 17, { force: true }), fileResult);
  // Force outside our context: built-in unchanged.
  assert.equal(await wrapped.getSuggestions(["/etc/"], 0, 5, { force: true }), fileResult);
  // Regular (non-force) queries keep built-in precedence even in our context.
  const current2 = {
    async getSuggestions() {
      return baseResult;
    },
  };
  const wrapped2 = createSkillAutocompleteWrapper(() => skills)(current2);
  assert.equal(await wrapped2.getSuggestions(["/skill:alpha /a"], 0, 15, {}), baseResult);
});
