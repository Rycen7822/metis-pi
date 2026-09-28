import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile, lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { createHash } from "node:crypto";
import { checkpointSource } from "../../vendor/pi-codex-conversion/src/tools/notebook-mode/checkpoint-runtime.ts";
import { projectStateCaptureSource } from "../../vendor/pi-codex-conversion/src/tools/notebook-mode/project-state-runtime.ts";
import { readProjectStatePayload, hasPayloadLayout, readProjectStateManifest, projectStatePaths } from "../../vendor/pi-codex-conversion/src/tools/notebook-mode/project-state-format.ts";
import { profileStatePaths } from "../../vendor/pi-codex-conversion/src/tools/notebook-mode/profile-state-format.ts";
import { assertCandidateNames, captureNotebookCandidate, publishNotebookManifest } from "../../vendor/pi-codex-conversion/src/tools/notebook-mode/candidate-transaction.ts";
import { mergeProjectState } from "../../vendor/pi-codex-conversion/src/tools/notebook-mode/project-state-merge.ts";
import { writeProjectState } from "../../vendor/pi-codex-conversion/src/tools/notebook-mode/project-state.ts";
import { saveNotebookProfile, loadNotebookProfile, listNotebookProfiles } from "../../vendor/pi-codex-conversion/src/tools/notebook-mode/profile-state.ts";
import { sessionCheckpointProjectExclusions } from "../../vendor/pi-codex-conversion/src/tools/notebook-mode/checkpoint.ts";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { captureStandIn, runCaptureSource } from "../helpers/vendor-notebook-capture.mjs";

// Execute the real generated kernel source with Node's v8 serializer and bounded file writes.
// This exercises lexical bindings, emitted code, payload bytes and manifests without installing Deno.
async function capture(t, scope, maxBytes = 1024, noProgress = false) {
  const dir = temporaryDirectory(t, "metis-notebook-capture-");
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
  const Deno = captureStandIn({
    write: noProgress ? () => 0 : async (file, bytes) => (await file.write(bytes.subarray(0, 3))).bytesWritten,
    close: () => { closed += 1; },
  });
  const fn = Object.assign(function twice(x) { return x * 2; }, { description: "double a value", usage: "twice(3)" });
  const source = scope === "checkpoint" ? checkpointSource(options) : projectStateCaptureSource(options);
  const bindings = { normal: { answer: 42 }, map: new Map([["x", 3]]), fn, pending: Promise.resolve(1), weak: new WeakMap(), native: Math.max };
  await runCaptureSource(source, bindings, Deno, Object.keys(bindings));
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
    assert.equal(stuck.manifest.skipped.find(e => e.name === "normal").reason, `${scope} payload write made no progress`);
  }
});

// ── Store transactions ──────────────────────────────────────────────────────
// The kernel boundary runs the real capture sources in-process (as above) and only
// records the injected restore/marker sources; the stores' Node-side transaction
// machinery (candidate allocation, verification, cleanup, atomic publish) is real.

/** Kernel boundary for the store transactions: `mode` corrupts or fails the capture. */
function storeKernel(bindings, { mode = "ok" } = {}) {
  return {
    calls: [],
    bindings,
    async complete() { return Object.keys(this.bindings); },
    async execute(source, options = {}) {
      this.calls.push({ source, options });
      if (mode === "error" && source.includes("__writeAll")) return { status: "error", errorText: "kernel exploded", items: [] };
      const marker = source.match(/console\.log\("([^"]+)"/)?.[1];
      if (marker) return { status: "ok", items: [{ type: "input_text", text: `${marker}${JSON.stringify(Object.keys(this.bindings))}` }] };
      if (source.includes("__writeAll")) {
        await runCaptureSource(source, this.bindings);
        if (mode === "truncate") await writeFile(source.match(/Deno\.open\("([^"]+)"/)[1], "x");
      }
      return { status: "ok", items: [{ type: "input_text", text: "ok" }] };
    },
  };
}

const baselineEntry = (name, payload) => ({
  name,
  hash: createHash("sha256").update(payload).digest("hex"),
});

const candidateEntry = (name, payload) => ({ name, kind: "value", offset: 0, length: payload.length });

test("the shared candidate transaction cleans up its files and classifies failures", async (t) => {
  const dir = temporaryDirectory(t, "metis-notebook-candidate-");
  const candidate = (mode) => ({
    directory: dir, kernel: storeKernel({ alpha: "value" }, { mode }), names: ["alpha"], maxBytes: 1024,
    failureMessage: "test capture failed", invalidMessage: "test capture did not produce valid state",
  });

  const captured = await captureNotebookCandidate(candidate());
  assert.deepEqual(captured.candidate.entries.map(({ name }) => name), ["alpha"]);
  assert.equal(deserialize(captured.payload.subarray(0, captured.candidate.entries[0].length)), "value");
  assert.deepEqual(await readdir(dir), [], "candidate files are removed after a successful capture");

  await assert.rejects(captureNotebookCandidate(candidate("truncate")), /^Error: test capture did not produce valid state$/);
  assert.deepEqual(await readdir(dir), [], "a truncated payload still removes its candidate files");

  await assert.rejects(captureNotebookCandidate(candidate("error")), /^Error: test capture failed: kernel exploded$/);
  assert.deepEqual(await readdir(dir), [], "a failed kernel capture removes its candidate files");

  assert.throws(() => assertCandidateNames(["a".repeat(4097)], "Notebook profile"), /Notebook profile name exceeds 4096 bytes/);
  assert.throws(() => assertCandidateNames(Array.from({ length: 10001 }, (_, index) => `n${index}`), "Project notebook state"), /Project notebook state exceeds 10000 top-level values/);
  assert.doesNotThrow(() => assertCandidateNames(["alpha", "beta"], "Notebook profile"));
});

test("publishing a manifest is atomic, reports the superseded payload and refuses oversized text", async (t) => {
  const dir = temporaryDirectory(t, "metis-notebook-publish-");
  await writeFile(join(dir, "old.bin"), "old payload");

  const manifest = { schema: "test", entries: [{ name: "alpha" }] };
  const superseded = publishNotebookManifest({
    directory: dir, manifestPath: join(dir, "state.json"), manifest,
    payloadName: "state-new.bin", payload: Buffer.from("new payload"),
    previousPayload: "old.bin", label: "Project",
  });
  assert.equal(superseded, join(dir, "old.bin"));
  assert.equal(await readFile(join(dir, "state-new.bin"), "utf8"), "new payload");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "state.json"), "utf8")), manifest);
  assert.deepEqual((await readdir(dir)).sort(), ["old.bin", "state-new.bin", "state.json"], "no temporary manifest survives the rename");

  const before = await readFile(join(dir, "state.json"), "utf8");
  const oversized = { schema: "test", padding: "x".repeat(9 * 1024 * 1024) };
  assert.throws(() => publishNotebookManifest({
    directory: dir, manifestPath: join(dir, "state.json"), manifest: oversized,
    payloadName: "state-huge.bin", payload: Buffer.from("x"), previousPayload: "state-new.bin", label: "Notebook profile",
  }), /Notebook profile manifest exceeds \d+ bytes/);
  assert.equal(await readFile(join(dir, "state.json"), "utf8"), before, "an oversized manifest leaves the published state untouched");
  await assert.rejects(readFile(join(dir, "state-huge.bin")), { code: "ENOENT" });
});

test("the project merge keeps concurrent generations, pinned deletions and pin requests apart", () => {
  const baseline = { generation: "g1", entries: [baselineEntry("alpha", Buffer.from("base"))] };
  const currentPayload = Buffer.from("current");
  const current = {
    schema: "project-state", project: "/project", generation: "g2", deno: "test-deno", v8: "test-v8",
    payload: "project-g2.bin", createdAt: new Date().toISOString(), sourceSession: "other",
    entries: [{ ...candidateEntry("alpha", currentPayload), hash: baselineEntry("alpha", currentPayload).hash }], skipped: [],
  };
  const candidatePayload = Buffer.from("candidate");
  const candidate = { deno: "test-deno", v8: "test-v8", entries: [candidateEntry("alpha", candidatePayload)], skipped: [] };
  const noEntries = { deno: "test-deno", v8: "test-v8", entries: [], skipped: [] };
  const rootMerge = { baseline: { generation: "root", entries: [] }, candidate, candidatePayload, currentPayload: Buffer.alloc(0) };

  const diverged = mergeProjectState({
    baseline, current, candidate, candidatePayload, currentPayload,
  });
  assert.deepEqual(diverged.conflicts, ["alpha"]);
  assert.deepEqual(diverged.conflictEntries.map(({ name }) => name), ["alpha"]);
  assert.deepEqual(diverged.payload, currentPayload, "the concurrently changed value wins in the store");
  assert.deepEqual(diverged.entries.map(({ hash }) => hash), [baselineEntry("alpha", currentPayload).hash]);

  const pinnedDelete = mergeProjectState({
    baseline,
    current: { ...current, entries: [{ ...current.entries[0], pinned: true }] },
    candidate: noEntries,
    candidatePayload: Buffer.alloc(0), currentPayload,
  });
  assert.deepEqual(pinnedDelete.conflicts, ["alpha"], "a pinned entry deleted by the session is preserved");
  assert.deepEqual(pinnedDelete.conflictDeletions, [], "the pinned value is kept, not recorded as a deletion");
  assert.deepEqual(pinnedDelete.entries.map(({ name, pinned }) => [name, pinned]), [["alpha", true]]);

  const applied = mergeProjectState({ ...rootMerge, pins: { names: ["alpha"], pinned: true } });
  assert.deepEqual(applied.conflicts, []);
  assert.deepEqual(applied.appliedNames, ["alpha"]);
  assert.equal(applied.entries[0].pinned, true);
  assert.throws(() => mergeProjectState({ ...rootMerge, pins: { names: ["missing"], pinned: true } }), /Durable notebook bindings not found: missing/);
});

test("a stale-generation pin request is refused without overwriting the concurrent value", async (t) => {
  const dir = temporaryDirectory(t, "metis-notebook-project-");
  const identity = { project: dir, session: "session-1", agentDir: dir };
  const empty = { generation: "root", entries: [] };
  const kernel = storeKernel({ alpha: "first" });

  const first = await writeProjectState(kernel, identity, empty, new Set(), 4096);
  assert.deepEqual(first.restored.map(({ name }) => name), ["alpha"]);
  // Another session changed the value while this session still holds the root baseline.
  kernel.bindings = { alpha: "second" };
  await assert.rejects(
    writeProjectState(kernel, identity, empty, new Set(), 4096, new Set(), { names: ["alpha"], pinned: true }),
    /Notebook bindings changed concurrently and were not pinned: alpha/,
  );
  const paths = projectStatePaths(dir, dir);
  const manifest = readProjectStateManifest(paths.manifest);
  const payload = readProjectStatePayload(manifest, join(paths.directory, manifest.payload), 4096);
  assert.equal(deserialize(payload.subarray(0, manifest.entries[0].length)), "first", "the concurrent value is preserved");
});

test("saving a profile leaves no candidates and loading rejects binding collisions", async (t) => {
  const dir = temporaryDirectory(t, "metis-notebook-profile-");
  const summary = await saveNotebookProfile({
    name: "snapshot", kernel: storeKernel({ alpha: "value" }), project: dir, agentDir: dir, baselineNames: new Set(), maxBytes: 4096,
  });
  assert.equal(summary.name, "snapshot");
  assert.equal(summary.values, 1);
  assert.deepEqual(listNotebookProfiles(dir).map(({ name }) => name), ["snapshot"]);
  assert.deepEqual(await readdir(profileStatePaths("snapshot", dir).directory).then((names) => names.filter((name) => name.startsWith("candidate-"))), []);

  const colliding = storeKernel({ alpha: "existing" });
  const load = (kernel) => loadNotebookProfile({ name: "snapshot", kernel, agentDir: dir, baselineNames: new Set(), maxBytes: 4096 });
  const collision = await load(colliding);
  assert.deepEqual(collision, { summary: collision.summary, loaded: [], collisions: ["alpha"] });
  assert.equal(colliding.calls.some(({ source }) => source.includes("deserialize")), false, "a colliding profile is never restored");

  const clean = storeKernel({ other: "unrelated" });
  const loaded = await load(clean);
  assert.deepEqual(loaded.loaded, ["alpha"]);
  assert.deepEqual(loaded.collisions, []);
  assert.equal(clean.calls.filter(({ source }) => source.includes("deserialize")).length, 1, "a clear profile restores exactly once");
});

test("an older session checkpoint yields its project names to the current project generation", () => {
  const baseline = { generation: "new", entries: [{ name: "beta", hash: "h" }] };
  const exclusions = (checkpoint) => [...sessionCheckpointProjectExclusions(checkpoint, baseline)];
  assert.deepEqual(exclusions({ projectGeneration: "old", projectNames: ["alpha"] }).sort(), ["alpha", "beta"]);
  assert.deepEqual(exclusions({ projectGeneration: "new", projectNames: ["alpha"] }), []);
  assert.deepEqual(exclusions({ projectNames: ["legacy-without-generation"] }), []);
});
