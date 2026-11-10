import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { digest, readDistribution, sdkPackages, sdkVersion, sdkUpstreamCommit, sdkPatchCount,
  verifiedArchive } from "../src/pi-sdk/artifact.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const patches = path.join(root, "sdk-patches", `pi-${sdkVersion}`);
async function patchIdentity() {
  const entries = [];
  for (const name of (await readdir(patches)).filter(name => name.endsWith(".patch")).sort())
    entries.push({ file: name, sha256: digest(await readFile(path.join(patches, name))) });
  return { patches: entries, patchSet: digest(JSON.stringify(entries)) };
}
async function unpackedBytes(directory) {
  let bytes = 0;
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`SDK artifacts must be physical: ${file}`);
    bytes += stat.isDirectory() ? await unpackedBytes(file) : stat.size;
  }
  return bytes;
}
async function verifySource(sdk) {
  const baseline = sdkUpstreamCommit;
  const git = args => execFileSync("git", ["-C", sdk, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(git(["rev-parse", "HEAD"]).trim(), baseline, `SDK source must start at the pinned Pi v${sdkVersion} commit`);
  await mkdir(path.join(root, ".work"), { recursive: true });
  const temporary = await mkdtemp(path.join(root, ".work/pi-sdk-source-"));
  try {
    const archive = path.join(temporary, "upstream.tar"), expected = path.join(temporary, "source");
    await mkdir(expected);
    await writeFile(archive, execFileSync("git", ["-C", sdk, "archive", baseline], { maxBuffer: 64 * 1024 * 1024 }));
    await tar.x({ file: archive, cwd: expected, strict: true });
    execFileSync("git", ["init", "-q", expected]);
    const changed = new Set();
    for (const file of (await readdir(patches)).filter(file => file.endsWith(".patch")).sort()) {
      const patch = path.join(patches, file), body = await readFile(patch, "utf8");
      execFileSync("git", ["-C", expected, "apply", "--check", patch]);
      execFileSync("git", ["-C", expected, "apply", patch]);
      for (const match of body.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) changed.add(match[2]);
    }
    for (const file of changed) {
      const actual = await readFile(path.join(sdk, file)), patched = await readFile(path.join(expected, file));
      if (!actual.equals(patched)) throw new Error(`SDK source does not match applied patches: ${file}`);
    }
    for (const file of git(["diff", "HEAD", "--name-only", "--", "packages", "scripts"]).trim().split("\n")) {
      if ((/^packages\/[^/]+\/src\//.test(file) || file.startsWith("scripts/")) && !changed.has(file))
        throw new Error(`Unreviewed SDK source change: ${file}`);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function packageSDK(sdk) {
  if (process.platform === "win32") throw new Error("Build the Pi SDK with the documented Linux/WSL recipe");
  await verifySource(sdk);
  const version = sdkVersion, identity = await patchIdentity();
  assert.equal(identity.patches.length, sdkPatchCount);
  for (const name of sdkPackages)
    assert.equal(JSON.parse(await readFile(path.join(sdk, "packages", name, "package.json"), "utf8")).version, version);
  const build = (name, script) => execFileSync("npm", ["--prefix", `packages/${name}`, "run", script], { cwd: sdk, stdio: "inherit" });
  build("ai", "build:offline");
  await cp(path.join(sdk, "packages/ai/dist"), path.join(sdk, "node_modules/@earendil-works/pi-ai/dist"), { recursive: true });
  build("tui", "build");
  await cp(path.join(sdk, "packages/tui/dist"), path.join(sdk, "node_modules/@earendil-works/pi-tui/dist"), { recursive: true });
  build("coding-agent", "build");
  const assets = path.join(root, "assets/pi-sdk");
  await mkdir(assets, { recursive: true });
  const staging = await mkdtemp(path.join(root, ".work/pi-sdk-build-"));
  try {
    for (const name of sdkPackages)
      await cp(path.join(sdk, "packages", name, "dist"), path.join(staging, name, "dist"), { recursive: true });
    const bytes = await unpackedBytes(staging);
    const file = `pi-${version}.tgz`, temporary = path.join(staging, file);
    await tar.c({ cwd: staging, file: temporary, gzip: true, portable: true, noMtime: true }, sdkPackages.map(name => `${name}/dist`));
    const archive = await readFile(temporary);
    await writeFile(path.join(assets, file), archive);
    await writeFile(path.join(root, "src/pi-sdk/distribution.json"), JSON.stringify({ schemaVersion: 1, piVersion: version,
      upstreamCommit: sdkUpstreamCommit, ...identity,
      archive: { file, sha256: digest(archive), bytes: archive.length, unpackedBytes: bytes } }, null, 2) + "\n");
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[2] === "package" && process.argv[3]) await packageSDK(path.resolve(process.argv[3]));
else if (process.argv[2] !== "verify") throw new Error("Usage: node scripts/pi-sdk.mjs package <patched-sdk> | verify");
const distribution = await readDistribution(), identity = await patchIdentity();
assert.deepEqual({ patches: distribution.patches, patchSet: distribution.patchSet }, identity, "SDK archive is stale; rebuild after patch changes");
await verifiedArchive(distribution);
console.log(`Pi ${distribution.piVersion}: ${distribution.patches.length} SDK patches, archive verified`);
