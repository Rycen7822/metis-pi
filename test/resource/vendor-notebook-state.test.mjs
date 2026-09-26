import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, writeFile, rename, rm, lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deserialize, serialize } from "node:v8";
import { createHash } from "node:crypto";
import { checkpointSource } from "../../vendor/pi-codex-conversion/dist/tools/notebook-mode/checkpoint-runtime.js";
import { projectStateCaptureSource } from "../../vendor/pi-codex-conversion/dist/tools/notebook-mode/project-state-runtime.js";
import { readProjectStatePayload, hasPayloadLayout } from "../../vendor/pi-codex-conversion/dist/tools/notebook-mode/project-state-format.js";
import { readProfileStatePayload } from "../../vendor/pi-codex-conversion/dist/tools/notebook-mode/profile-state-format.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Execute the real generated kernel source with Node's v8 serializer and bounded file writes.
// This exercises lexical bindings, emitted code, payload bytes and manifests without installing Deno.
async function capture(t, scope, maxBytes = 1024, noProgress = false) {
  const dir = await mkdtemp(join(tmpdir(), "metis-notebook-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let closed = 0;
  const payloadPath = join(dir, "payload.bin");
  const manifestPath = join(dir, "manifest.json");
  const options = {
    candidates: ["normal", "map", "fn", "pending", "weak", "native", "missing"],
    payloadPath, manifestPath, maxBytes,
    directory: dir, identity: { project: "/project", session: "s" }, projectGeneration: "g",
    projectNames: ["normal"], payload: "payload.bin", previousPayload: "old.bin",
    skippedInvalid: [{ name: "not-valid", reason: "invalid identifier" }],
  };
  await writeFile(join(dir, "old.bin"), "previous");
  const Deno = {
    version: { deno: "test-deno", v8: process.versions.v8 },
    async open(path) {
      const file = await open(path, "w", 0o600);
      return {
        async write(bytes) { return noProgress ? 0 : (await file.write(bytes.subarray(0, 3))).bytesWritten; },
        close() { closed++; return file.close(); },
      };
    },
    writeTextFile: (path, text) => writeFile(path, text, { mode: 0o600 }),
    rename,
    remove: (path) => rm(path),
  };
  const fn = Object.assign(function twice(x) { return x * 2; }, { description: "double a value", usage: "twice(3)" });
  const source = scope === "checkpoint" ? checkpointSource(options) : projectStateCaptureSource(options);
  await new AsyncFunction("Deno", "normal", "map", "fn", "pending", "weak", "native", source)(
    Deno, { answer: 42 }, new Map([["x", 3]]), fn, Promise.resolve(1), new WeakMap(), Math.max,
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const payload = await readFile(payloadPath);
  assert.equal(closed, 1, "payload handle closes before committing a manifest");
  assert.equal((await lstat(payloadPath)).mode & 0o777, 0o600);
  if (scope === "checkpoint") {
    assert.equal(manifest.session, "s");
    assert.equal(manifest.projectGeneration, "g");
    await assert.rejects(lstat(join(dir, "old.bin")), { code: "ENOENT" });
  }
  return { manifest, payload, payloadPath };
}

test("checkpoint and project payloads restore lexical values and reject corrupt storage", async (t) => {
  for (const scope of ["checkpoint", "project"]) {
    const { manifest, payload, payloadPath } = await capture(t, scope);
    assert.deepEqual(manifest.entries.map(e => e.name), ["normal", "map", "fn"]);
    let offset = 0;
    const values = manifest.entries.map(entry => {
      assert.equal(entry.offset, offset);
      offset += entry.length;
      return deserialize(payload.subarray(entry.offset, offset));
    });
    assert.equal(offset, payload.length);
    assert.deepEqual(values.slice(0, 2), [{ answer: 42 }, new Map([["x", 3]])]);
    assert.equal((0, eval)(`(${values[2]})`)(4), 8);
    assert.equal(manifest.entries[2].description, "double a value");
    assert.equal(manifest.entries[2].usage, "twice(3)");
    assert.deepEqual(manifest.skipped.filter(e => e.name !== "not-valid"), [
      { name: "pending", reason: "promise" }, { name: "weak", reason: "weak collection" },
      { name: "native", reason: "native or bound function" }, { name: "missing", reason: "missing is not defined" },
    ]);
    assert.equal(manifest.skipped.some(e => e.name === "not-valid"), scope === "checkpoint");
    const entries = manifest.entries.map(entry => ({ ...entry,
      hash: createHash("sha256").update(payload.subarray(entry.offset, entry.offset + entry.length)).digest("hex"),
    }));
    assert.deepEqual(readProjectStatePayload({ entries }, payloadPath, payload.length), payload);
    assert.deepEqual(readProfileStatePayload({ entries }, payloadPath, payload.length), payload);
    const link = `${payloadPath}.link`;
    await symlink(payloadPath, link);
    assert.equal(readProjectStatePayload({ entries }, payloadPath, payload.length - 1), undefined);
    for (const [candidate, path, layout] of [
      [entries, link, false], [entries.slice(0, -1), payloadPath, false],
      [[entries[0], { ...entries[1], name: entries[0].name }, entries[2]], payloadPath, false],
      [[entries[0], { ...entries[1], offset: entries[1].offset + 1 }, entries[2]], payloadPath, false],
      [[{ ...entries[0], hash: "bad" }, ...entries.slice(1)], payloadPath, true],
    ]) {
      assert.equal(readProjectStatePayload({ entries: candidate }, path, payload.length), undefined);
      assert.equal(hasPayloadLayout(candidate, path, payload.length), layout, "layout checking intentionally ignores hashes");
    }
  }
});

test("capture preserves each protocol's byte-cap and zero-progress errors", async (t) => {
  for (const scope of ["checkpoint", "project"]) {
    const small = await capture(t, scope, 0);
    assert.equal(small.payload.length, 0);
    assert.match(small.manifest.skipped.find(e => e.name === "normal").reason, scope === "checkpoint" ? /per-variable checkpoint cap/ : /per-value checkpoint cap/);
    const total = await capture(t, scope, serialize({ answer: 42 }).length + serialize(new Map([["x", 3]])).length - 1);
    assert.equal(total.manifest.skipped.find(e => e.name === "map").reason, scope === "checkpoint" ? "exceeds total checkpoint cap" : "exceeds total project checkpoint cap");
    const stuck = await capture(t, scope, 1024, true);
    assert.equal(stuck.manifest.entries.length, 0);
    assert.equal(stuck.manifest.skipped.find(e => e.name === "normal").reason, `${scope === "checkpoint" ? "checkpoint" : "project"} payload write made no progress`);
  }
});
