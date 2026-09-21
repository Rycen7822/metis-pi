import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, writeFile, rename, rm, lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deserialize, serialize } from "node:v8";
import { checkpointSource } from "../vendor/pi-codex-conversion/dist/tools/notebook-mode/checkpoint-runtime.js";
import { projectStateCaptureSource } from "../vendor/pi-codex-conversion/dist/tools/notebook-mode/project-state-runtime.js";
import { hashStateBytes, readProjectStatePayload, hasPayloadLayout } from "../vendor/pi-codex-conversion/dist/tools/notebook-mode/project-state-format.js";
import { readProfileStatePayload } from "../vendor/pi-codex-conversion/dist/tools/notebook-mode/profile-state-format.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Execute the real generated kernel source with Node's v8 serializer and bounded file writes.
// This exercises lexical bindings, emitted code, payload bytes and manifests without installing Deno.
async function capture(scope, maxBytes = 1024, noProgress = false) {
  const dir = await mkdtemp(join(tmpdir(), "metis-notebook-capture-"));
  let closed = 0;
  try {
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
    return { manifest, payload };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("checkpoint and project capture preserve lexical values, functions, metadata and skip reasons", async () => {
  for (const scope of ["checkpoint", "project"]) {
    const { manifest, payload } = await capture(scope);
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
  }
});

test("capture preserves each protocol's byte-cap and zero-progress errors", async () => {
  for (const scope of ["checkpoint", "project"]) {
    const small = await capture(scope, 0);
    assert.equal(small.payload.length, 0);
    assert.match(small.manifest.skipped.find(e => e.name === "normal").reason, scope === "checkpoint" ? /per-variable checkpoint cap/ : /per-value checkpoint cap/);
    const total = await capture(scope, serialize({ answer: 42 }).length + serialize(new Map([["x", 3]])).length - 1);
    assert.equal(total.manifest.skipped.find(e => e.name === "map").reason, scope === "checkpoint" ? "exceeds total checkpoint cap" : "exceeds total project checkpoint cap");
    const stuck = await capture(scope, 1024, true);
    assert.equal(stuck.manifest.entries.length, 0);
    assert.equal(stuck.manifest.skipped.find(e => e.name === "normal").reason, `${scope === "checkpoint" ? "checkpoint" : "project"} payload write made no progress`);
  }
});

test("project/profile payload readers share integrity checks; layout-only reads retain their contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metis-notebook-payload-"));
  try {
    const path = join(dir, "payload.bin"), link = join(dir, "link.bin");
    const bytes = Buffer.from("abcdef");
    await writeFile(path, bytes); await symlink(path, link);
    const entries = [
      { name: "a", offset: 0, length: 3, hash: hashStateBytes(bytes.subarray(0, 3)) },
      { name: "b", offset: 3, length: 3, hash: hashStateBytes(bytes.subarray(3)) },
    ];
    for (const read of [readProjectStatePayload, readProfileStatePayload]) {
      assert.deepEqual(read({ entries }, path, 6), bytes);
      assert.equal(read({ entries }, path, 5), undefined);
      assert.equal(read({ entries }, link, 6), undefined);
      for (const invalid of [
        [entries[0]], [entries[0], { ...entries[1], name: "a" }],
        [entries[0], { ...entries[1], offset: 4 }], [{ ...entries[0], hash: "bad" }, entries[1]],
      ]) assert.equal(read({ entries: invalid }, path, 6), undefined);
    }
    assert.equal(hasPayloadLayout(entries, path, 6), true);
    assert.equal(hasPayloadLayout([{ ...entries[0], hash: "bad" }, entries[1]], path, 6), true, "metadata-only path does not read or hash bytes");
    assert.equal(hasPayloadLayout(entries, link, 6), false);
    assert.equal(hasPayloadLayout([entries[0]], path, 6), false);
    assert.equal(hasPayloadLayout([entries[0], { ...entries[1], name: "a" }], path, 6), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
