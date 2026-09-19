// skill-mux tests — tmpdir only, never a real HOME or real settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSkillMux, type SkillMux } from "../src/skill-mux.ts";

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
    const out = f.mux.expand("/skill:alpha /skill:beta/skill:gamma tail");
    assert.ok(out!.includes("/skill:beta/skill:gamma"), "glued second token stays literal");
    assert.ok(out!.startsWith(`<skill name="alpha" location="${f.files.alpha}">`));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
