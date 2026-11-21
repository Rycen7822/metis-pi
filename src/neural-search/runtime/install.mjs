import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readJSON, selectedRuntime, SEMANTIC_RUNTIME_PATH } from "./catalog.mts";

const DOWNLOAD_TIMEOUT_MS = 180_000;
const INSTALL_WAIT_MS = 600_000;
const checkedAgents = new Set();
const distribution = JSON.parse(fs.readFileSync(new URL("./distribution.json", import.meta.url), "utf8"));

function unsupportedPlatform() {
  if (process.platform !== "linux" || process.arch !== "x64") return "the semantic CPU backend requires Linux x64";
  const required = distribution.minimum_glibc;
  if (!required) return;
  const actual = process.report.getReport().header.glibcVersionRuntime;
  const [major, minor] = (actual ?? "0.0").split(".").map(Number);
  const [requiredMajor, requiredMinor] = required.split(".").map(Number);
  if (major < requiredMajor || (major === requiredMajor && minor < requiredMinor)) {
    return `the prepared semantic engine requires glibc ${required}+ (found ${actual ?? "a non-glibc runtime"})`;
  }
}

function agentDirectory() {
  const directory = process.env.METIS_SEMANTIC_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi/agent");
  return path.resolve(directory === "~" ? homedir() : directory.startsWith("~/") ? path.join(homedir(), directory.slice(2)) : directory);
}

function filesFor(asset) {
  return asset.catalog ? Object.fromEntries(Object.entries(asset.catalog.files).map(([name, file]) => [name, file.bytes])) : asset.files;
}

function archiveFiles(asset) { return { ...filesFor(asset), ...asset.notices }; }

function physicalFiles(directory, asset) {
  if (!directory) return false;
  try {
    return Object.entries(filesFor(asset)).every(([name, bytes]) => {
      const stat = fs.lstatSync(path.join(directory, name));
      return stat.isFile() && stat.size === bytes;
    });
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function readyRuntime(directory) {
  if (!directory) return;
  const record = await readJSON(path.join(directory, "installation.json"));
  if (record?.distribution !== distribution.id || record.engine !== distribution.engine.id) return;
  const catalog = await readJSON(path.join(directory, "assets.json"));
  return physicalFiles(directory, distribution.engine) && Object.entries(distribution.models).every(([name, asset]) =>
    record.models?.[name] === asset.id && physicalFiles(catalog?.models?.[name]?.directory, asset));
}

function sync(file) {
  const descriptor = fs.openSync(file, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function publish(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    sync(temporary);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function syncPayload(directory, asset) {
  const directories = new Set([directory]);
  for (const name of Object.keys(filesFor(asset))) {
    const file = path.join(directory, name);
    sync(file);
    for (let parent = path.dirname(file); parent !== directory; parent = path.dirname(parent)) directories.add(parent);
  }
  for (const parent of [...directories].sort((a, b) => b.length - a.length)) sync(parent);
}

function copyPayload(source, target, asset) {
  for (const name of Object.keys(filesFor(asset))) {
    const destination = path.join(target, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(source, name), destination);
  }
  syncPayload(target, asset);
}

function validateDistribution() {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]+$/;
  if (distribution.format_version !== 1 || !identifier.test(distribution.id)
    || Object.keys(distribution.models).sort().join(",") !== "bekko128,lateon-edge") throw new Error("Invalid semantic distribution.");
  for (const asset of [distribution.engine, ...Object.values(distribution.models)]) {
    const url = new URL(asset.url);
    const transport = url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
    if (!identifier.test(asset.id) || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !transport) throw new Error("Invalid semantic release asset.");
    for (const [name, size] of Object.entries(archiveFiles(asset))) {
      if (path.isAbsolute(name) || name.split("/").some(part => !part || part === "." || part === "..")
        || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid semantic release file.");
    }
  }
}

async function installationLock(base, signal) {
  const { default: lockfile } = await import("proper-lockfile");
  const until = performance.now() + INSTALL_WAIT_MS;
  let wait = 100;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await lockfile.lock(base, { realpath: false, lockfilePath: path.join(base, ".install.lock"), stale: 300_000 });
    } catch (error) {
      if (error.code !== "ELOCKED") throw error;
      if (performance.now() >= until) throw new Error("Timed out waiting for another semantic installation.");
      await delay(wait, undefined, { signal });
      wait = Math.min(wait * 2, 1000);
    }
  }
}

async function download(asset, directory, context) {
  if ([process.env.PI_OFFLINE, process.env.HF_HUB_OFFLINE].some(value => /^(1|true|yes|on)$/i.test(value ?? ""))) {
    throw new Error("Required semantic assets are not cached and offline mode prohibits automatic download.");
  }
  const { fetch, EnvHttpProxyAgent, RetryAgent } = await import("undici");
  // At most two transient GET retries (delays in milliseconds), never checksum/ABI failures or completed objects.
  context.agent ??= new RetryAgent(new EnvHttpProxyAgent(), { maxRetries: 2, minTimeout: 250, maxTimeout: 1000 });
  const signal = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(context.signal ? [context.signal] : [])]);
  const response = await fetch(asset.url, { dispatcher: context.agent, signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Semantic asset download failed: HTTP ${response.status} (${asset.url}).`);
  }
  const archive = path.join(directory, ".download.tar.gz");
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(response.body, async function* (source) {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > asset.bytes) throw new Error("Semantic download exceeds its published size.");
      hash.update(chunk);
      yield chunk;
    }
  }, fs.createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal });
  if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error("Semantic download integrity check failed.");
  const { x } = await import("tar");
  const expected = archiveFiles(asset);
  const seen = new Set();
  let invalid;
  await x({ file: archive, cwd: directory, strict: true, preservePaths: false, filter(name, entry) {
    const safe = !path.isAbsolute(name) && !name.split("/").includes("..");
    if (safe && entry.type === "Directory") return true;
    if (!safe || entry.type !== "File" || !Object.hasOwn(expected, name) || seen.has(name) || entry.size !== expected[name]) {
      invalid = name;
      return false;
    }
    seen.add(name);
    return true;
  } });
  fs.rmSync(archive);
  if (invalid !== undefined || seen.size !== Object.keys(expected).length || !physicalFiles(directory, asset)) {
    throw new Error(`Invalid semantic release archive: ${invalid ?? "missing files"}.`);
  }
  syncPayload(directory, { files: expected });
}

function objectIndex(objects, asset) { return path.join(objects, `${asset.id}.json`); }
function publishObject(objects, asset, directory) {
  publish(objectIndex(objects, asset), JSON.stringify({ sha256: asset.sha256, directory: path.basename(directory) }) + "\n");
  sync(objects);
}

async function cachedObject(objects, asset) {
  const record = await readJSON(objectIndex(objects, asset));
  if (record?.sha256 !== asset.sha256 || !/^asset-[A-Za-z0-9]+$/.test(record.directory)) return;
  const directory = path.join(objects, record.directory);
  if (physicalFiles(directory, asset)) return directory;
}

async function downloadObject(objects, asset, context) {
  context.signal?.throwIfAborted();
  const directory = fs.mkdtempSync(path.join(objects, "asset-"));
  try { await download(asset, directory, context); }
  catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  // Once an index may have been renamed, keep its complete payload even if directory sync failed.
  publishObject(objects, asset, directory);
  return directory;
}

async function checkRuntime(directory, signal) {
  const env = { ...process.env, SGREP_RUNTIME_DIR: directory, HF_HUB_OFFLINE: "1" };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(path.join(directory, "bin/sgrep"), ["--check-runtime"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const output = [], diagnostics = [];
    let bytes = 0, failure;
    // The standalone verifier has no service/corpus children. Kill it and await close before releasing payloads.
    const stop = reason => { failure ??= reason; child.kill("SIGKILL"); };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new Error("Semantic runtime verification timed out.")), 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", error => { failure ??= error; });
    for (const [stream, chunks] of [[child.stdout, output], [child.stderr, diagnostics]]) {
      stream.on("error", stop);
      stream.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) stop(new Error("Semantic runtime verification output exceeds 64 KiB."));
        else chunks.push(chunk);
      });
    }
    child.once("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const stderr = Buffer.concat(diagnostics).toString("utf8");
      if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error(`Semantic runtime verification failed: ${stderr}`), { stderr }));
      else resolve(Buffer.concat(output).toString("utf8"));
    });
  });
  const report = JSON.parse(stdout);
  if (report.runtime_check !== 1 || JSON.stringify(report.models) !== JSON.stringify(["bekko128", "lateon-edge"])) {
    throw new Error("Semantic setup did not execute both prepared models.");
  }
}

async function legacyModel(directory, asset, name) {
  if (!directory) return;
  const entry = (await readJSON(path.join(directory, "assets.json")))?.models?.[name];
  if (entry?.revision !== asset.catalog.revision || Object.keys(entry.files).length !== Object.keys(asset.catalog.files).length) return;
  if (!Object.entries(asset.catalog.files).every(([file, value]) =>
    entry.files[file]?.sha256 === value.sha256 && entry.files[file]?.bytes === value.bytes)) return;
  const source = entry.directory ?? path.join(directory, "models", name);
  if (physicalFiles(source, asset)) return source;
}

async function install(base, signal) {
  const release = await installationLock(base, signal);
  const context = { signal };
  const adopted = new Set();
  let stagedRuntime;
  try {
    signal?.throwIfAborted();
    const previous = await selectedRuntime(base);
    if (await readyRuntime(previous)) return;
    signal?.throwIfAborted();
    const objects = path.join(base, "objects");
    fs.mkdirSync(objects, { recursive: true, mode: 0o700 });
    const engine = await cachedObject(objects, distribution.engine) ?? await downloadObject(objects, distribution.engine, context);
    const models = [];
    for (const [name, asset] of Object.entries(distribution.models)) {
      let directory = await cachedObject(objects, asset);
      const legacy = directory ? undefined : await legacyModel(previous, asset, name);
      signal?.throwIfAborted();
      if (legacy) {
        directory = fs.mkdtempSync(path.join(objects, "asset-"));
        adopted.add(directory);
        copyPayload(legacy, directory, asset);
      }
      directory ??= await downloadObject(objects, asset, context);
      models.push({ name, asset, directory });
    }
    stagedRuntime = fs.mkdtempSync(path.join(base, "runtime-"));
    copyPayload(engine, stagedRuntime, distribution.engine);
    const repaired = new Set();
    for (;;) {
      const catalog = { format_version: 2, models: Object.fromEntries(models.map(model =>
        [model.name, { ...model.asset.catalog, directory: model.directory }])) };
      publish(path.join(stagedRuntime, "assets.json"), JSON.stringify(catalog) + "\n");
      try { await checkRuntime(stagedRuntime, signal); break; }
      catch (error) {
        const damaged = models.find(model => !repaired.has(model.name)
          && error.stderr?.includes("ASSET_MISSING_OR_CORRUPT") && error.stderr.includes(model.name));
        if (!damaged) throw error;
        repaired.add(damaged.name);
        damaged.directory = await downloadObject(objects, damaged.asset, context);
      }
    }
    for (const { asset, directory } of models) {
      if (adopted.delete(directory)) publishObject(objects, asset, directory);
    }
    publish(path.join(stagedRuntime, "installation.json"), JSON.stringify({ distribution: distribution.id,
      engine: distribution.engine.id, models: Object.fromEntries(models.map(model => [model.name, model.asset.id])) }) + "\n");
    sync(stagedRuntime);
    signal?.throwIfAborted();
    publish(path.join(base, "current"), path.basename(stagedRuntime) + "\n");
    stagedRuntime = undefined;
    sync(base);
  } finally {
    if (stagedRuntime) fs.rmSync(stagedRuntime, { recursive: true, force: true });
    for (const directory of adopted) fs.rmSync(directory, { recursive: true, force: true });
    try { await context.agent?.close(); } finally { await release(); }
  }
}

/** Automatic lifecycle setup; no SDK/dev dependency, compiler, service or corpus is started. */
export async function ensureSemanticRuntime(agentDir = agentDirectory(), signal) {
  signal?.throwIfAborted();
  if (process.env.SGREP_RUNTIME_DIR) return;
  const base = path.resolve(agentDir, SEMANTIC_RUNTIME_PATH);
  if (checkedAgents.has(base)) return;
  const unsupported = unsupportedPlatform();
  if (unsupported) throw new Error(`Semantic unavailable: ${unsupported}; no alternate backend is selected.`);
  validateDistribution();
  if (!(await readyRuntime(await selectedRuntime(base)))) {
    signal?.throwIfAborted();
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    await install(base, signal);
  }
  signal?.throwIfAborted();
  checkedAgents.add(base);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const unsupported = process.env.SGREP_RUNTIME_DIR ? undefined : unsupportedPlatform();
  if (unsupported) console.log(`Metis installed; ${unsupported}. Other Metis features remain available.`);
  else {
    await ensureSemanticRuntime();
    console.log(process.env.SGREP_RUNTIME_DIR ? "Metis semantic uses the existing external runtime override."
      : "Metis semantic CPU runtime is ready; unchanged model assets are reused.");
  }
}
