import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import * as tar from "tar";
import { readDistribution, sdkPackages, sdkFiles, verifiedArchive } from "./artifact.mjs";

const run = promisify(execFile);
const packageDir = (release, name) => path.join(release, "node_modules", "@earendil-works", `pi-${name}`);
const validRelease = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(value);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};

async function regularJSON(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
  return JSON.parse(await readFile(file, "utf8"));
}

async function sourceRelease(root, version) {
  const pointer = path.join(root, "current-version"), stat = await lstat(pointer);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 129) throw new Error("Invalid managed Pi version pointer");
  const name = (await readFile(pointer, "utf8")).trim();
  if (!validRelease(name)) throw new Error("Invalid managed Pi release name");
  const directory = path.join(root, "releases", name);
  if (await realpath(directory) !== directory) throw new Error("Managed Pi releases must use physical directories");
  for (const pkg of sdkPackages) {
    const manifest = await regularJSON(path.join(packageDir(directory, pkg), "package.json"));
    if (manifest.name !== `@earendil-works/pi-${pkg}` || manifest.version !== version)
      throw new Error(`Metis SDK requires Pi ${version}; found ${manifest.name} ${manifest.version}`);
  }
  return { name, directory };
}

async function unpack(archive, destination, budget) {
  let problem, bytes = 0;
  const seen = new Set();
  await tar.x({ file: archive, cwd: destination, strict: true, filter(name, entry) {
    if (problem) return false;
    const normalized = name.replace(/\/$/, "");
    const allowed = sdkPackages.some(pkg => normalized === `${pkg}/dist` || normalized.startsWith(`${pkg}/dist/`))
      || sdkFiles.includes(normalized);
    const valid = allowed
      && !normalized.split("/").some(part => ["", ".", ".."].includes(part) || /[\\:*?"<>|]/.test(part)
        || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
    const portableName = normalized.toLowerCase();
    if (!valid || !["File", "Directory"].includes(entry.type) || seen.has(portableName)) {
      problem = new Error(`Unsafe or duplicate Metis SDK archive entry: ${name}`);
      return false;
    }
    seen.add(portableName);
    if (entry.type === "File") bytes += entry.size;
    if (bytes > budget) { problem = new Error("Metis SDK archive exceeds its declared size"); return false; }
    return true;
  } });
  if (problem) throw problem;
  if (bytes !== budget) throw new Error("Metis SDK archive content size mismatch");
  for (const pkg of sdkPackages) {
    const stat = await lstat(path.join(destination, pkg, "dist"));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Missing SDK distribution: ${pkg}`);
  }
  for (const file of sdkFiles) {
    const stat = await lstat(path.join(destination, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Missing SDK resource: ${file}`);
  }
}

async function copyRelease(source, target) {
  const bins = [];
  await cp(source, target, { recursive: true, dereference: true, async filter(file) {
    if ((await lstat(file)).isSymbolicLink()) {
      const resolved = await realpath(file);
      if (!inside(source, resolved)) throw new Error(`Pi dependency link leaves the managed release: ${file}`);
      if (path.basename(path.dirname(file)) === ".bin")
        bins.push({ alias: path.relative(source, file), target: path.relative(source, resolved) });
    }
    return true;
  } });
  // Preserve every npm bin's relative imports, including nested bins. Never freeze a copied JS launcher.
  for (const entry of bins) {
    const alias = path.join(target, entry.alias), directory = path.dirname(alias);
    const relative = path.relative(directory, path.join(target, entry.target)).split(path.sep).join("/");
    const quoted = "'" + relative.replaceAll("'", "'\\''") + "'";
    await writeFile(alias, `#!/bin/sh\nexec "$(dirname "$0")"/${quoted} "$@"\n`, { mode: 0o755 });
  }
  const bin = path.join(target, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "pi"), '#!/bin/sh\nexec node "$(dirname "$0")/../@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n',
    { mode: 0o755 });
  await writeFile(path.join(bin, "pi.cmd"), '@echo off\r\nnode "%~dp0..\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n');
}

async function activate(root, name) {
  const temporary = path.join(root, `.metis-current-${randomUUID()}`);
  let owned = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    owned = true;
    let failure;
    try { await file.writeFile(`${name}\n`); await file.sync(); } catch (error) { failure = error; }
    try { await file.close(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], `${failure.message}; close: ${error.message}`) : error; }
    if (failure) throw failure;
    await rename(temporary, path.join(root, "current-version"));
  } catch (error) {
    try { if (owned) await rm(temporary, { force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${error.message}; temporary pointer cleanup: ${cleanup.message}`); }
    throw error;
  }
}

/** Install all matching patches as one managed release. Never edits the running release or user data. */
export async function ensureSDK({ managedRoot, runningPackageDir } = {}) {
  const inferredRoot = runningPackageDir ? path.resolve(runningPackageDir, "../../../../..") : undefined;
  const root = path.resolve(managedRoot ?? process.env.PI_MANAGED_INSTALL_ROOT ?? inferredRoot
    ?? path.join(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), "install"));
  let marker;
  try { marker = await regularJSON(path.join(root, "managed-install.json")); }
  catch (error) { if (error.code === "ENOENT" && !managedRoot && !process.env.PI_MANAGED_INSTALL_ROOT)
    return { status: "unmanaged", restartRequired: false }; throw error; }
  if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1")
    throw new Error("Unsupported Pi managed installation layout");
  const canonical = await realpath(root);
  const running = runningPackageDir ? await realpath(runningPackageDir) : undefined;
  if (running && !inside(path.join(canonical, "releases"), running))
    return { status: "unmanaged", restartRequired: false };
  const distribution = await readDistribution();
  // Same lock as Pi's native self-updater; re-read the active release only after acquiring it.
  const releaseLock = await lockfile.lock(path.join(canonical, "update"), {
    realpath: false, retries: { retries: 60, minTimeout: 500, maxTimeout: 1000 },
  });
  let staging, created, failure, activated = false;
  try {
    const source = await sourceRelease(canonical, distribution.piVersion);
    let installed;
    try { installed = await regularJSON(path.join(source.directory, "metis-sdk.json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let active = source.directory, status = "current";
    if (installed?.schemaVersion !== 1 || installed.piVersion !== distribution.piVersion
      || installed.patchSet !== distribution.patchSet || installed.archiveHash !== distribution.archive.sha256) {
      const archive = await verifiedArchive(distribution);
      const releases = path.join(canonical, "releases");
      staging = await mkdtemp(path.join(releases, ".metis-stage-"));
      const payload = path.join(staging, "payload"), candidate = path.join(staging, "release");
      await mkdir(payload);
      await unpack(archive, payload, distribution.archive.unpackedBytes);
      await copyRelease(source.directory, candidate);
      for (const pkg of sdkPackages) {
        const target = path.join(packageDir(candidate, pkg), "dist");
        await rm(target, { recursive: true, force: true });
        await cp(path.join(payload, pkg, "dist"), target, { recursive: true });
      }
      for (const file of sdkFiles) {
        const [pkg, ...parts] = file.split("/");
        const target = path.join(packageDir(candidate, pkg), ...parts);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(payload, file), target);
      }
      const cli = path.join(packageDir(candidate, "coding-agent"), "dist", "bundle", "cli.js");
      const result = await run(process.execPath, [cli, "--version"], { timeout: 30_000, windowsHide: true });
      if (result.stdout.trim() !== distribution.piVersion) throw new Error("Patched Pi CLI version verification failed");
      await writeFile(path.join(candidate, "metis-sdk.json"), JSON.stringify({ schemaVersion: 1,
        piVersion: distribution.piVersion, patchSet: distribution.patchSet, archiveHash: distribution.archive.sha256,
        previousRelease: source.name }, null, 2) + "\n");
      const name = `metis-${distribution.piVersion}-${distribution.patchSet.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
      active = path.join(releases, name);
      await rename(candidate, active);
      created = active;
      await rm(staging, { recursive: true, force: true });
      staging = undefined;
      await activate(canonical, name);
      activated = true;
      status = "installed";
    }
    const currentPackage = packageDir(active, "coding-agent");
    const comparable = value => process.platform === "win32" ? value.toLowerCase() : value;
    return { status, restartRequired: Boolean(running && comparable(running) !== comparable(currentPackage)),
      packageDir: currentPackage, patches: distribution.patches.length };
  } catch (error) { failure = error; throw error; }
  finally {
    const errors = [];
    for (const directory of [staging, !activated && created].filter(Boolean)) {
      try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    }
    try { await releaseLock(); } catch (error) { errors.push(error); }
    if (errors.length) {
      const state = activated ? "SDK activated; cleanup failed" : "SDK installation aborted; cleanup failed";
      throw new AggregateError([failure, ...errors].filter(Boolean),
        `${state}: ${[failure, ...errors].filter(Boolean).map(error => error.message).join("; ")}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await ensureSDK();
    if (result.status === "unmanaged") console.warn("Metis SDK: no managed Pi installation found; SDK patches were not installed.");
    else console.log(`Metis SDK: ${result.patches} patches ${result.status}; new Pi processes use the patched SDK.`);
  } catch (error) { console.error(`Metis SDK installation failed: ${error.message}`); process.exitCode = 1; }
}
