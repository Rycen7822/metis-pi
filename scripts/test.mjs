#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import bunAskFiles from "../config/bun/ask-files.json" with { type: "json" };

const project = new URL("../", import.meta.url);
const webRoot = new URL("src/pi-web-access/", project);
const [suite, shard, ...extra] = process.argv.slice(2);
const webAccess = suite === "web-access";
const root = webAccess ? new URL("test/", webRoot) : new URL("test/", project);
const files = (dir, pattern, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const name = `${prefix}${entry.name}`;
  if (entry.isDirectory()) return files(new URL(`${entry.name}/`, dir), pattern, `${name}/`);
  return entry.isFile() && pattern.test(name) ? [name] : [];
});

function run(command, args, cwd) {
  const child = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (child.error?.code === "ENOENT" && command === "bun") {
    console.error("Install Bun 1.4.0 on PATH to run the ask-user-question tests.");
  } else if (child.error) {
    console.error(child.error);
  }
  return child.status ?? 1;
}

function runAskTests() {
  const directory = "test/ask-user-question/";
  const unmatchedBunFiles = new Set(bunAskFiles);
  const bunPaths = [], vitestPaths = [];
  for (const file of files(new URL(directory, project), /\.test\.ts$/).sort()) {
    const path = directory + file;
    if (unmatchedBunFiles.delete(file)) bunPaths.push(`./${path}`);
    else vitestPaths.push(path); // New tests stay on Vitest until verified with Bun.
  }
  if (unmatchedBunFiles.size) {
    console.error(`Bun ask-user-question manifest names missing tests: ${[...unmatchedBunFiles].join(", ")}`);
    return 1;
  }
  if (!bunPaths.length) {
    console.error("The Bun ask-user-question manifest must list at least one test.");
    return 1;
  }
  const cwd = fileURLToPath(project);
  const status = run("bun", ["test", "--parallel=4", "--dots", "--preload", `./${directory}support/setup.ts`, ...bunPaths], cwd);
  if (status !== 0 || vitestPaths.length === 0) return status;
  return run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "config/vitest/ask.config.ts", ...vitestPaths], cwd);
}

const suites = {
  all: () => true,
  "web-access": () => true,
  core: (file) => file.startsWith("core/"),
  host: (file) => file.startsWith("contract/") || file === "package.test.mjs",
  lsp: (file) => file.startsWith("lsp/"),
  ask: (file) => file === "contract/ask-user-question.test.mts",
  protocol: (file) => file.startsWith("protocol/"),
  io: (file) => file.startsWith("io/"),
  resource: (file) => file.startsWith("resource/"),
  chrome: (file) => [
    "core/chrome", "core/working", "core/hardware-cursor",
    "contract/appearance", "contract/editor", "contract/copy-mirror", "contract/copy-text",
    "contract/fullscreen", "contract/history-window", "contract/sticky-prompt", "contract/clipboard-facade",
    "resource/copy-cache", "resource/copy-heap", "resource/windows-clipboard",
  ].some((owner) => file.startsWith(`${owner}.test.`)),
};

const invalidShard = shard !== undefined && (!/^--test-shard=[1-9]\d*\/[1-9]\d*$/.test(shard) || (!webAccess && suite !== "all"));
if (extra.length || !Object.hasOwn(suites, suite) || invalidShard) {
  console.error(`Usage: node scripts/test.mjs <${Object.keys(suites).join("|")}> [--test-shard=index/total (all or web-access)]`);
  process.exit(2);
}
const selected = files(root, /\.test\.m(?:j|t)s$/).sort().filter(suites[suite]);
if (selected.length === 0) {
  console.error(`No tests selected for ${suite}`);
  process.exit(2);
}
process.exitCode = run(
  process.execPath,
  ["--experimental-strip-types",
    ...(webAccess ? ["--import", new URL("test/isolate-env.mjs", webRoot).href] : []),
    "--test", ...(shard ? [shard] : []), ...selected.map((file) => join(fileURLToPath(root), file))],
  webAccess ? fileURLToPath(webRoot) : undefined,
);
const runAsk = suite === "ask" || (suite === "all" && (!shard || shard.startsWith("--test-shard=1/")));
if (process.exitCode === 0 && runAsk) process.exitCode = runAskTests();
