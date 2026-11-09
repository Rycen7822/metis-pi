import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import * as tar from "tar";
import { digest, sdkPackages } from "../../src/pi-sdk/artifact.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);
async function fixture(t, { version = "1.5.0", cliVersion = "1.5.0" } = {}) {
  const work = path.join(root, ".work");
  await mkdir(work, { recursive: true });
  const dir = await mkdtemp(path.join(work, "sdk-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, "metis"), managedRoot = path.join(dir, "agent/install");
  const source = path.join(managedRoot, "releases", version);
  const sdkDir = (release, name) => path.join(release, "node_modules/@earendil-works", `pi-${name}`);
  await mkdir(path.join(pkg, "src/pi-sdk"), { recursive: true });
  for (const file of ["install.mjs", "artifact.mjs"])
    await cp(path.join(root, "src/pi-sdk", file), path.join(pkg, "src/pi-sdk", file));
  for (const name of sdkPackages) {
    await mkdir(path.join(sdkDir(source, name), "dist/bundle"), { recursive: true });
    await writeFile(path.join(sdkDir(source, name), "package.json"),
      JSON.stringify({ name: `@earendil-works/pi-${name}`, version }));
    await writeFile(path.join(sdkDir(source, name), "dist/owner.txt"), "original");
  }
  await writeFile(path.join(managedRoot, "managed-install.json"),
    JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
  await writeFile(path.join(managedRoot, "current-version"), `${version}\n`);
  const settings = path.join(dir, "agent/settings.json"), auth = path.join(dir, "agent/auth.json");
  await writeFile(settings, '{"model":"keep-model","packages":["keep-package"]}\n');
  await writeFile(auth, '{"offline-secret":"unchanged"}\n');
  const saved = await Promise.all([readFile(settings), readFile(auth)]);
  async function payload(label = "new-sdk") {
    const staging = path.join(dir, "payload");
    await rm(staging, { recursive: true, force: true });
    for (const name of sdkPackages) {
      await mkdir(path.join(staging, name, "dist/bundle"), { recursive: true });
      await writeFile(path.join(staging, name, "dist/owner.txt"), label);
    }
    await writeFile(path.join(staging, "coding-agent/dist/bundle/cli.js"), `console.log(${JSON.stringify(cliVersion)});\n`);
    let unpackedBytes = 0;
    for (const name of sdkPackages) unpackedBytes += Buffer.byteLength(label);
    unpackedBytes += Buffer.byteLength(`console.log(${JSON.stringify(cliVersion)});\n`);
    const archive = path.join(pkg, "assets/pi-sdk/pi-1.5.0.tgz");
    await mkdir(path.dirname(archive), { recursive: true });
    await tar.c({ file: archive, cwd: staging, gzip: true, portable: true }, sdkPackages.map(name => `${name}/dist`));
    const bytes = await readFile(archive);
    const manifest = { schemaVersion: 1, piVersion: "1.5.0", patchSet: digest(label),
      patches: Array.from({ length: 6 }, (_, index) => ({ file: `${index}.patch`, sha256: "0".repeat(64) })),
      archive: { file: "pi-1.5.0.tgz", sha256: digest(bytes), bytes: bytes.length, unpackedBytes } };
    await writeFile(path.join(pkg, "src/pi-sdk/distribution.json"), JSON.stringify(manifest));
    return { archive, manifest };
  }
  await payload();
  const { ensureSDK } = await import(pathToFileURL(path.join(pkg, "src/pi-sdk/install.mjs")));
  const active = async () => (await readFile(path.join(managedRoot, "current-version"), "utf8")).trim();
  const preserved = async () => {
    assert.deepEqual(await Promise.all([readFile(settings), readFile(auth)]), saved);
    for (const name of sdkPackages) assert.equal(await readFile(path.join(sdkDir(source, name), "dist/owner.txt"), "utf8"), "original");
  };
  return { dir, pkg, managedRoot, source, sdkDir, ensureSDK, active, preserved, payload };
}

test("normal SDK install activates all packages together and retains source and user data", async t => {
  const h = await fixture(t);
  const installed = await h.ensureSDK({ managedRoot: h.managedRoot, runningPackageDir: h.sdkDir(h.source, "coding-agent") });
  assert.equal(installed.status, "installed");
  assert.equal(installed.restartRequired, true);
  assert.equal(installed.patches, 6);
  const active = await h.active(), directory = path.join(h.managedRoot, "releases", active);
  for (const name of sdkPackages) assert.equal(await readFile(path.join(h.sdkDir(directory, name), "dist/owner.txt"), "utf8"), "new-sdk");
  assert.equal(JSON.parse(await readFile(path.join(directory, "metis-sdk.json"), "utf8")).previousRelease, "1.5.0");
  if (process.platform !== "win32") assert.equal((await run(path.join(directory, "node_modules/.bin/pi"), ["--version"])).stdout.trim(), "1.5.0");
  const again = await h.ensureSDK({ managedRoot: h.managedRoot, runningPackageDir: installed.packageDir });
  assert.equal(again.status, "current");
  assert.equal(again.restartRequired, false);
  assert.equal(await h.active(), active);
  await h.preserved();
});

test("updated package replaces the snapshot while preserving both previous runtimes", async t => {
  const h = await fixture(t);
  await h.ensureSDK({ managedRoot: h.managedRoot });
  const previous = await h.active();
  await h.payload("updated-sdk");
  await h.ensureSDK({ managedRoot: h.managedRoot });
  assert.notEqual(await h.active(), previous);
  const active = path.join(h.managedRoot, "releases", await h.active());
  for (const name of sdkPackages) assert.equal(await readFile(path.join(h.sdkDir(active, name), "dist/owner.txt"), "utf8"), "updated-sdk");
  assert.equal(await readFile(path.join(h.sdkDir(path.join(h.managedRoot, "releases", previous), "ai"), "dist/owner.txt"), "utf8"), "new-sdk");
  await h.preserved();
});

for (const failure of ["unsupported-version", "corrupt-archive", "bad-cli", "symlink-entry", "reserved-entry"]) {
  test(`SDK installation failure (${failure}) leaves the previous runtime active`, async t => {
    const h = await fixture(t, { version: failure === "unsupported-version" ? "1.6.0" : "1.5.0",
      cliVersion: failure === "bad-cli" ? "wrong-version" : "1.5.0" });
    const before = await h.active();
    if (failure === "corrupt-archive") {
      const archive = path.join(h.pkg, "assets/pi-sdk/pi-1.5.0.tgz"), bytes = await readFile(archive);
      bytes[0] ^= 0xff;
      await writeFile(archive, bytes);
    } else if (failure === "symlink-entry" || failure === "reserved-entry") {
      const header = new tar.Header({ path: failure === "symlink-entry" ? "ai/dist/escape" : "ai/dist/AUX",
        type: failure === "symlink-entry" ? "SymbolicLink" : "File",
        ...(failure === "symlink-entry" ? { linkpath: "../../outside" } : {}), size: 0 });
      header.encode();
      const archive = Buffer.concat([header.block, Buffer.alloc(1024)]);
      const { manifest } = await h.payload();
      await writeFile(path.join(h.pkg, "assets/pi-sdk/pi-1.5.0.tgz"), archive);
      manifest.archive = { ...manifest.archive, bytes: archive.length, sha256: digest(archive) };
      await writeFile(path.join(h.pkg, "src/pi-sdk/distribution.json"), JSON.stringify(manifest));
    }
    await assert.rejects(h.ensureSDK({ managedRoot: h.managedRoot }),
      /requires Pi|checksum mismatch|version verification failed|Unsafe or duplicate/);
    assert.equal(await h.active(), before);
    assert.deepEqual(await readdir(path.join(h.managedRoot, "releases")), [before]);
    await h.preserved();
  });
}

test("activation failure removes only its candidate and preserves pre-existing temporary files", async t => {
  const h = await fixture(t), uuid = "00000000-0000-4000-8000-000000000000";
  const sentinel = path.join(h.managedRoot, `.metis-current-${uuid}`);
  await writeFile(sentinel, "not-owned-by-installer");
  const original = crypto.randomUUID;
  crypto.randomUUID = () => uuid;
  syncBuiltinESMExports();
  try {
    await assert.rejects(h.ensureSDK({ managedRoot: h.managedRoot }), { code: "EEXIST" });
  } finally {
    crypto.randomUUID = original;
    syncBuiltinESMExports();
  }
  assert.equal(await h.active(), "1.5.0");
  assert.deepEqual(await readdir(path.join(h.managedRoot, "releases")), ["1.5.0"]);
  assert.equal(await readFile(sentinel, "utf8"), "not-owned-by-installer");
  await h.preserved();
});

test("rebuilt SDK bytes are adopted even when the source patch identity is unchanged", async t => {
  const h = await fixture(t);
  const original = (await h.payload()).manifest;
  await h.ensureSDK({ managedRoot: h.managedRoot });
  const before = await h.active();
  const rebuilt = (await h.payload("rebuilt-resources")).manifest;
  rebuilt.patchSet = original.patchSet;
  await writeFile(path.join(h.pkg, "src/pi-sdk/distribution.json"), JSON.stringify(rebuilt));
  await h.ensureSDK({ managedRoot: h.managedRoot });
  assert.notEqual(await h.active(), before);
  const current = path.join(h.managedRoot, "releases", await h.active());
  assert.equal(await readFile(path.join(h.sdkDir(current, "ai"), "dist/owner.txt"), "utf8"), "rebuilt-resources");
  assert.equal(JSON.parse(await readFile(path.join(current, "metis-sdk.json"), "utf8")).archiveHash, rebuilt.archive.sha256);
  await h.preserved();
});

test("concurrent SDK installers serialize and use one complete snapshot", async t => {
  const h = await fixture(t);
  const results = await Promise.all([h.ensureSDK({ managedRoot: h.managedRoot }), h.ensureSDK({ managedRoot: h.managedRoot })]);
  assert.deepEqual(results.map(result => result.status).sort(), ["current", "installed"]);
  assert.equal((await readdir(path.join(h.managedRoot, "releases"))).length, 2);
  await h.preserved();
});

test("embedded SDK sessions cannot patch an unrelated managed installation", async t => {
  const h = await fixture(t);
  const foreign = path.join(h.dir, "embedded-sdk");
  await mkdir(foreign);
  const result = await h.ensureSDK({ managedRoot: h.managedRoot, runningPackageDir: foreign });
  assert.equal(result.status, "unmanaged");
  assert.equal(await h.active(), "1.5.0");
  await h.preserved();
});
