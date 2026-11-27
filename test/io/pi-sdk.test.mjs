import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import * as tar from "tar";
import { digest, sdkPackages, sdkRuntimePackages, sdkFiles, sdkPatchCount } from "../../src/pi-sdk/artifact.mjs";
import { mockWindowsSdkProcessList } from "../helpers/windows-sdk-process-list.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);
const releaseVersion = "1.6.1", releaseCommit = "ef4a1cfcca62b77ad3558337ff3e1c7f6beeadfe";
const futureVersion = "1.6.2", legacyVersion = "1.5.2", archiveName = `pi-${releaseVersion}.tgz`;
const managedMarker = { kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" };

async function fixture(t, { version = releaseVersion, cliVersion = releaseVersion, windowsProcesses } = {}) {
  const work = path.join(root, ".work");
  await mkdir(work, { recursive: true });
  const dir = await mkdtemp(path.join(work, "sdk-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, "metis"), managedRoot = path.join(dir, "agent/install");
  const source = path.join(managedRoot, "releases", version);
  const sdkDir = (release, name) => path.join(release, "node_modules/@earendil-works", `pi-${name}`);
  await cp(path.join(root, "src/pi-sdk"), path.join(pkg, "src/pi-sdk"), { recursive: true });
  for (const name of sdkRuntimePackages) {
    await mkdir(path.join(sdkDir(source, name), "dist/bundle"), { recursive: true });
    await writeFile(path.join(sdkDir(source, name), "package.json"),
      JSON.stringify({ name: `@earendil-works/pi-${name}`, version }));
    await writeFile(path.join(sdkDir(source, name), "dist/owner.txt"), "original");
  }
  const markerPath = path.join(managedRoot, "managed-install.json");
  await writeFile(markerPath, JSON.stringify(managedMarker));
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
    for (const file of sdkFiles) {
      await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
      await writeFile(path.join(staging, file), label);
    }
    let unpackedBytes = sdkFiles.length * Buffer.byteLength(label);
    for (const name of sdkPackages) unpackedBytes += Buffer.byteLength(label);
    unpackedBytes += Buffer.byteLength(`console.log(${JSON.stringify(cliVersion)});\n`);
    const archive = path.join(pkg, "assets/pi-sdk", archiveName);
    await mkdir(path.dirname(archive), { recursive: true });
    await tar.c({ file: archive, cwd: staging, gzip: true, portable: true },
      [...sdkPackages.map(name => `${name}/dist`), ...sdkFiles]);
    const bytes = await readFile(archive);
    const manifest = { schemaVersion: 1, piVersion: releaseVersion, upstreamCommit: releaseCommit,
      patchSet: digest(label), patches: Array.from({ length: sdkPatchCount }, (_, index) => ({
        file: `${index}.patch`, sha256: "0".repeat(64) })),
      archive: { file: archiveName, sha256: digest(bytes), bytes: bytes.length, unpackedBytes } };
    await writeFile(path.join(pkg, "src/pi-sdk/distribution.json"), JSON.stringify(manifest));
    return { archive, manifest };
  }
  await payload();
  const restore = process.platform === "win32" && windowsProcesses ? mockWindowsSdkProcessList(windowsProcesses) : undefined;
  const { ensureSDK } = await import(pathToFileURL(path.join(pkg, "src/pi-sdk/install.mjs"))).finally(() => restore?.());
  const active = async () => (await readFile(path.join(managedRoot, "current-version"), "utf8")).trim();
  const preserved = async () => {
    assert.deepEqual(await Promise.all([readFile(settings), readFile(auth)]), saved);
    for (const name of sdkPackages) assert.equal(await readFile(path.join(sdkDir(source, name), "dist/owner.txt"), "utf8"), "original");
  };
  // The root listing covers the update lock and activation temporaries; releases covers staging and new releases.
  const snapshot = async () => ({
    pointer: await readFile(path.join(managedRoot, "current-version"), "utf8"),
    root: (await readdir(managedRoot)).sort(),
    releases: (await readdir(path.join(managedRoot, "releases"))).sort(),
  });
  return { dir, pkg, managedRoot, source, sdkDir, ensureSDK, active, preserved, payload, markerPath, snapshot };
}

test("normal SDK install activates all packages together and retains source and user data", async t => {
  const h = await fixture(t);
  const installed = await h.ensureSDK({ managedRoot: h.managedRoot, runningPackageDir: h.sdkDir(h.source, "coding-agent") });
  assert.equal(installed.status, "installed");
  assert.equal(installed.restartRequired, true);
  assert.equal(installed.patches, sdkPatchCount);
  const active = await h.active(), directory = path.join(h.managedRoot, "releases", active);
  for (const name of sdkPackages) assert.equal(await readFile(path.join(h.sdkDir(directory, name), "dist/owner.txt"), "utf8"), "new-sdk");
  for (const file of sdkFiles)
    assert.equal(await readFile(path.join(directory, "node_modules/@earendil-works", `pi-${file}`), "utf8"), "new-sdk");
  assert.equal(JSON.parse(await readFile(path.join(directory, "metis-sdk.json"), "utf8")).previousRelease, releaseVersion);
  if (process.platform !== "win32") assert.equal((await run(path.join(directory, "node_modules/.bin/pi"), ["--version"]))
    .stdout.trim(), releaseVersion);
  const again = await h.ensureSDK({ managedRoot: h.managedRoot, runningPackageDir: installed.packageDir });
  assert.equal(again.status, "current");
  assert.equal(again.restartRequired, false);
  assert.equal(await h.active(), active);
  await h.preserved();
});

test("project SDK preparation replaces all verified payloads and rejects mixed versions before changing dependencies", async t => {
  const h = await fixture(t);
  await mkdir(path.join(h.pkg, "scripts"));
  await cp(path.join(root, "scripts/pi-sdk.mjs"), path.join(h.pkg, "scripts/pi-sdk.mjs"));
  const patches = path.join(h.pkg, `sdk-patches/pi-${releaseVersion}`);
  await mkdir(patches, { recursive: true });
  const { manifest } = await h.payload();
  manifest.patches = await Promise.all(Array.from({ length: sdkPatchCount }, async (_, index) => {
    const file = `${String(index).padStart(4, "0")}.patch`, body = `offline-patch-${index}\n`;
    await writeFile(path.join(patches, file), body);
    return { file, sha256: digest(body) };
  }));
  manifest.patchSet = digest(JSON.stringify(manifest.patches));
  await writeFile(path.join(h.pkg, "src/pi-sdk/distribution.json"), JSON.stringify(manifest));
  for (const name of sdkRuntimePackages) {
    const target = h.sdkDir(h.pkg, name);
    await cp(h.sdkDir(h.source, name), target, { recursive: true });
    await writeFile(path.join(target, "dist/stale.txt"), "not-in-new-payload");
  }
  const prepare = () => run(process.execPath, [path.join(h.pkg, "scripts/pi-sdk.mjs"), "prepare"], { timeout: 30_000 });
  assert.match((await prepare()).stdout, /project dependencies prepared/);
  for (const name of sdkPackages) {
    const target = h.sdkDir(h.pkg, name);
    assert.equal(await readFile(path.join(target, "dist/owner.txt"), "utf8"), "new-sdk");
    await assert.rejects(readFile(path.join(target, "dist/stale.txt")), { code: "ENOENT" });
    await writeFile(path.join(target, "dist/owner.txt"), "before-rejected-prepare");
  }
  for (const file of sdkFiles)
    assert.equal(await readFile(path.join(h.pkg, "node_modules/@earendil-works", `pi-${file}`), "utf8"), "new-sdk");
  const core = h.sdkDir(h.pkg, "agent-core");
  await writeFile(path.join(core, "package.json"), JSON.stringify({ name: "@earendil-works/pi-agent-core", version: legacyVersion }));
  await assert.rejects(prepare(), new RegExp(`SDK preparation requires Pi ${releaseVersion.replaceAll(".", "\\.")}`));
  for (const name of sdkPackages)
    assert.equal(await readFile(path.join(h.sdkDir(h.pkg, name), "dist/owner.txt"), "utf8"), "before-rejected-prepare");
  await h.preserved();
});

test("package postinstall keeps only the immediate Metis rollback and leaves other directories alone", async t => {
  const h = await fixture(t);
  const releases = path.dirname(h.source);
  await h.ensureSDK({ managedRoot: h.managedRoot });
  await h.payload("previous-sdk");
  await h.ensureSDK({ managedRoot: h.managedRoot });
  const previous = await h.active();
  const unrelated = `metis-${releaseVersion}-ffffffffffff-ffffffff`;
  await mkdir(path.join(releases, unrelated));
  await writeFile(path.join(releases, unrelated, "metis-sdk.json"), '{"schemaVersion":1}');
  await h.payload("updated-sdk");
  await cp(path.join(root, "src/neural-search/runtime"), path.join(h.pkg, "src/neural-search/runtime"), { recursive: true });
  await mkdir(path.join(h.pkg, "src/condense"), { recursive: true });
  await cp(path.join(root, "src/condense/refresh-prices.mjs"), path.join(h.pkg, "src/condense/refresh-prices.mjs"));
  await cp(path.join(root, "package.json"), path.join(h.pkg, "package.json"));
  const command = "npm run postinstall --ignore-scripts";
  const processListPreload = new URL("../helpers/windows-sdk-process-list.mjs", import.meta.url);
  const windowsEnv = process.platform === "win32" ? {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${processListPreload.href}`].filter(Boolean).join(" "),
    METIS_TEST_WINDOWS_SDK_PROCESS_LIST: "empty",
  } : {};
  await run(process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm",
    process.platform === "win32" ? ["/d", "/s", "/c", command] : ["run", "postinstall", "--ignore-scripts"], {
      cwd: h.pkg, timeout: 30_000, windowsHide: true,
      // Semantic setup is separately tested; its supported external override prevents downloads here.
      env: { ...process.env, ...windowsEnv, PI_MANAGED_INSTALL_ROOT: h.managedRoot, SGREP_RUNTIME_DIR: h.dir,
        PI_CODING_AGENT_DIR: path.dirname(h.managedRoot) },
    });
  assert.notEqual(await h.active(), previous);
  assert.ok((await readFile(path.join(path.dirname(h.managedRoot), "cache/metis-model-prices.refresh"), "utf8")).length > 0);
  const active = path.join(h.managedRoot, "releases", await h.active());
  for (const name of sdkPackages) assert.equal(await readFile(path.join(h.sdkDir(active, name), "dist/owner.txt"), "utf8"), "updated-sdk");
  assert.equal(await readFile(path.join(h.sdkDir(path.join(releases, previous), "ai"), "dist/owner.txt"), "utf8"), "previous-sdk");
  assert.equal(JSON.parse(await readFile(path.join(active, "metis-sdk.json"), "utf8")).previousRelease, previous);
  assert.deepEqual((await readdir(releases)).sort(), [releaseVersion, await h.active(), previous, unrelated].sort());
  await h.preserved();
});

test("a running older release survives an upgrade and is retired on the next idle startup", async t => {
  const h = await fixture(t);
  const releases = path.dirname(h.source);
  await h.ensureSDK({ managedRoot: h.managedRoot });
  const oldest = await h.active();
  await h.payload("previous");
  await h.ensureSDK({ managedRoot: h.managedRoot });
  const previous = await h.active();
  await h.payload("current");
  const installed = await h.ensureSDK({ managedRoot: h.managedRoot,
    runningPackageDir: h.sdkDir(path.join(releases, oldest), "coding-agent") });
  const current = await h.active();
  assert.equal(installed.restartRequired, true);
  assert.deepEqual((await readdir(releases)).sort(), [releaseVersion, current, previous, oldest].sort());

  if (process.platform === "linux" || process.platform === "win32") {
    const worker = path.join(releases, oldest, "live.mjs");
    await writeFile(worker, 'process.title = "pi-rpc"; process.stdout.write("ready\\n"); setInterval(() => {}, 60_000);');
    const child = spawn(process.execPath, [worker], {
      env: { ...process.env, PI_MANAGED_INSTALL_ROOT: h.managedRoot }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    const closed = once(child, "close");
    try {
      const [ready] = await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
      assert.equal(ready.toString().trim(), "ready");
      await h.ensureSDK({ managedRoot: h.managedRoot, runningPackageDir: installed.packageDir });
      assert.equal(await readFile(path.join(h.sdkDir(path.join(releases, oldest), "ai"), "dist/owner.txt"), "utf8"), "new-sdk");
    } finally {
      child.kill();
      await closed;
    }
  }
  const restarted = await h.ensureSDK({ managedRoot: h.managedRoot, runningPackageDir: installed.packageDir });
  assert.equal(restarted.status, "current");
  assert.equal(restarted.cleanupWarning, undefined);
  assert.deepEqual((await readdir(releases)).sort(), [releaseVersion, current, previous].sort());
  await h.preserved();
});

for (const failure of [
  "legacy-version", "future-version", "mixed-agent-core", "corrupt-archive", "bad-size", "bad-cli", "symlink-entry", "reserved-entry",
]) {
  test(`SDK installation failure (${failure}) leaves the previous runtime active`, async t => {
    const version = failure === "legacy-version" ? legacyVersion : failure === "future-version" ? futureVersion : releaseVersion;
    const h = await fixture(t, { version, cliVersion: failure === "bad-cli" ? "wrong-version" : releaseVersion });
    const before = await h.active();
    if (failure === "mixed-agent-core") {
      const core = h.sdkDir(h.source, "agent-core");
      await writeFile(path.join(core, "package.json"), JSON.stringify({ name: "@earendil-works/pi-agent-core", version: legacyVersion }));
    }
    if (failure === "corrupt-archive" || failure === "bad-size") {
      const archive = path.join(h.pkg, "assets/pi-sdk", archiveName), bytes = await readFile(archive);
      if (failure === "corrupt-archive") bytes[0] ^= 0xff;
      await writeFile(archive, failure === "bad-size" ? Buffer.concat([bytes, Buffer.from("extra")]) : bytes);
    } else if (failure === "symlink-entry" || failure === "reserved-entry") {
      const header = new tar.Header({ path: failure === "symlink-entry" ? "ai/dist/escape" : "ai/dist/AUX",
        type: failure === "symlink-entry" ? "SymbolicLink" : "File",
        ...(failure === "symlink-entry" ? { linkpath: "../../outside" } : {}), size: 0 });
      header.encode();
      const archive = Buffer.concat([header.block, Buffer.alloc(1024)]);
      const { manifest } = await h.payload();
      await writeFile(path.join(h.pkg, "assets/pi-sdk", archiveName), archive);
      manifest.archive = { ...manifest.archive, bytes: archive.length, sha256: digest(archive) };
      await writeFile(path.join(h.pkg, "src/pi-sdk/distribution.json"), JSON.stringify(manifest));
    }
    await assert.rejects(h.ensureSDK({ managedRoot: h.managedRoot }),
      /requires Pi|checksum mismatch|size\/type mismatch|version verification failed|Unsafe or duplicate/);
    assert.equal(await h.active(), before);
    assert.deepEqual(await readdir(path.join(h.managedRoot, "releases")), [before]);
    await h.preserved();
  });
}

test("activation failure removes only its candidate and preserves pre-existing temporary files", async t => {
  const h = await fixture(t), uuid = "00000000-0000-4000-8000-000000000000";
  await h.ensureSDK({ managedRoot: h.managedRoot });
  await h.payload("before-failure");
  await h.ensureSDK({ managedRoot: h.managedRoot });
  const before = await h.active();
  const releases = (await readdir(path.dirname(h.source))).sort();
  await h.payload("must-not-activate");
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
  assert.equal(await h.active(), before);
  assert.deepEqual((await readdir(path.dirname(h.source))).sort(), releases);
  assert.equal(await readFile(sentinel, "utf8"), "not-owned-by-installer");
  await h.preserved();
});

test("cleanup failure leaves the verified update active and can be retried", async t => {
  let windowsProcesses = [];
  const h = await fixture(t, { windowsProcesses: () => windowsProcesses });
  await h.ensureSDK({ managedRoot: h.managedRoot });
  const oldest = path.join(path.dirname(h.source), await h.active());
  await h.payload("rollback");
  await h.ensureSDK({ managedRoot: h.managedRoot });
  const rollback = await h.active();
  await h.payload("updated");

  const remove = fs.rm;
  fs.rm = async (target, options) => {
    if (path.dirname(target) === oldest) throw new Error("release file busy");
    return remove(target, options);
  };
  syncBuiltinESMExports();
  try {
    const update = await h.ensureSDK({ managedRoot: h.managedRoot });
    assert.equal(update.status, "installed");
    assert.match(update.cleanupWarning, /release file busy/);
    assert.equal(path.basename(path.join(update.packageDir, "../../..")), await h.active());
    assert.notEqual(await h.active(), rollback);
  } finally {
    fs.rm = remove;
    syncBuiltinESMExports();
  }
  assert.ok((await readdir(oldest)).includes("metis-sdk.json"));
  if (process.platform === "win32") {
    windowsProcesses = [{ ProcessId: process.pid + 1, CommandLine: null }];
    const deferred = await h.ensureSDK({ managedRoot: h.managedRoot });
    assert.equal(deferred.status, "current");
    assert.equal(deferred.cleanupWarning, undefined);
    assert.ok((await readdir(oldest)).includes("metis-sdk.json"));
    windowsProcesses = [];
  }
  const retry = await h.ensureSDK({ managedRoot: h.managedRoot });
  assert.equal(retry.status, "current");
  assert.equal(retry.cleanupWarning, undefined);
  assert.deepEqual((await readdir(path.dirname(h.source))).sort(), [releaseVersion, await h.active(), rollback].sort());
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
  await writeFile(h.markerPath, JSON.stringify({ ...managedMarker, entrypoint: { path: String.raw`C:\pi\pi.cmd` } }));
  const before = await h.snapshot();
  const result = await h.ensureSDK({ managedRoot: h.managedRoot, runningPackageDir: foreign });
  assert.equal(result.status, "unmanaged");
  assert.deepEqual(await h.snapshot(), before);
  await h.preserved();
});

test("Windows launcher markers prevent install and cleanup outside Windows", { skip: process.platform === "win32" }, async t => {
  const h = await fixture(t);
  const oldest = await h.ensureSDK({ managedRoot: h.managedRoot });
  const obsolete = await h.active();
  await h.payload("rollback");
  await h.ensureSDK({ managedRoot: h.managedRoot });
  await h.payload("current");
  await h.ensureSDK({ managedRoot: h.managedRoot, runningPackageDir: oldest.packageDir });
  const before = await h.snapshot();
  assert.ok(before.releases.includes(obsolete), "a running release is retained on upgrade");
  const drive = String.raw`C:\pi\pi.cmd`, unc = String.raw`\\server\share\pi.cmd`;

  for (const [launcher, bom] of [[drive, ""], [unc, "\uFEFF"]]) {
    await writeFile(h.markerPath, bom + JSON.stringify({ ...managedMarker, entrypoint: { path: launcher } }));
    await assert.rejects(h.ensureSDK({ managedRoot: h.managedRoot }), /belongs to Windows.*update it from Windows/);
    assert.deepEqual(await h.snapshot(), before, "even an already-current installation must skip cleanup");
  }

  await h.payload("pending");
  await assert.rejects(h.ensureSDK({ managedRoot: h.managedRoot }), /belongs to Windows/);
  assert.deepEqual(await h.snapshot(), before);
  await h.preserved();

  await writeFile(h.markerPath, JSON.stringify(managedMarker));
  assert.equal((await h.ensureSDK({ managedRoot: h.managedRoot })).status, "installed");
  if (process.platform === "linux") {
    assert.ok(!(await h.snapshot()).releases.includes(obsolete), "the same release is pruned by a valid update");
  }
});

test("BOM-prefixed CRLF markers are accepted, including a native Windows launcher", async t => {
  const h = await fixture(t);
  const marker = process.platform === "win32"
    ? { ...managedMarker, entrypoint: { path: String.raw`C:\pi\pi.cmd` } } : managedMarker;
  await writeFile(h.markerPath, `\uFEFF${JSON.stringify(marker, null, 2).replaceAll("\n", "\r\n")}\r\n`);
  assert.equal((await h.ensureSDK({ managedRoot: h.managedRoot })).status, "installed");
  await h.preserved();
});

test("invalid or non-regular managed markers leave the managed installation untouched", async t => {
  const h = await fixture(t);
  const before = await h.snapshot();
  const unsupported = /Unsupported Pi managed installation layout/;
  for (const [body, expected] of [
    ['{"kind":', SyntaxError],
    [`\uFEFF\uFEFF${JSON.stringify(managedMarker)}`, SyntaxError],
    ["\uFEFFnull", unsupported],
    [JSON.stringify({ ...managedMarker, kind: "other" }), unsupported],
    [JSON.stringify({ ...managedMarker, schemaVersion: 2 }), unsupported],
    [JSON.stringify({ ...managedMarker, layout: "releases-v2" }), unsupported],
  ]) {
    await writeFile(h.markerPath, body);
    await assert.rejects(h.ensureSDK({ managedRoot: h.managedRoot }), expected);
    assert.deepEqual(await h.snapshot(), before);
  }
  await rm(h.markerPath);
  await mkdir(h.markerPath);
  await assert.rejects(h.ensureSDK({ managedRoot: h.managedRoot }), /Expected a regular file/);
  assert.deepEqual(await h.snapshot(), before);
  await h.preserved();
});

test("BOM tolerance stays limited to the managed-install marker", async t => {
  const h = await fixture(t);
  const manifest = path.join(h.sdkDir(h.source, "coding-agent"), "package.json");
  await writeFile(manifest, `\uFEFF${await readFile(manifest, "utf8")}`);
  const before = await h.snapshot();
  await assert.rejects(h.ensureSDK({ managedRoot: h.managedRoot }), SyntaxError);
  assert.deepEqual(await h.snapshot(), before);
  await h.preserved();
});
