#!/usr/bin/env node
// File selection only. Each test still runs in Node's own isolated test process.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
// Bytecode reuse does not share module state between isolated test processes.
if (env.NODE_COMPILE_CACHE === undefined && !env.NODE_V8_COVERAGE)
  env.NODE_COMPILE_CACHE = join(repo, ".work/test-cache/node");

const webRoot = new URL("../src/pi-web-access/", import.meta.url);
const root = process.argv[2] === "plugins" ? new URL("test/", webRoot) : new URL("../test/", import.meta.url);
const files = (dir = root, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const name = `${prefix}${entry.name}`;
  if (entry.isDirectory()) return files(new URL(`${entry.name}/`, dir), `${name}/`);
  return entry.isFile() && /\.test\.m(?:j|t)s$/.test(name) ? [name] : [];
});

const suites = {
  all: () => true,
  plugins: () => true,
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

const suite = process.argv[2];
let concurrency;
try {
  if (!Object.hasOwn(suites, suite)) throw new Error("Unknown test suite");
  ({ values: { concurrency } } = parseArgs({
    args: process.argv.slice(3), options: { concurrency: { type: "string" } },
  }));
  if (concurrency !== undefined && (!/^[1-9]\d*$/.test(concurrency) || !Number.isSafeInteger(Number(concurrency))))
    throw new Error("--concurrency must be a positive integer");
} catch (error) {
  console.error(`${error.message}\nUsage: node scripts/test.mjs <${Object.keys(suites).join("|")}> [--concurrency=N]`);
  process.exit(2);
}
const longRunning = new Set(["contract/subagents-parking.test.mjs", "contract/subagents-idle-session.test.mjs"]);
// Start real idle-grace E2E first; every selected file still gets its own process.
const selected = files().sort().filter(suites[suite])
  .sort((a, b) => Number(longRunning.has(b)) - Number(longRunning.has(a)));
if (selected.length === 0) {
  console.error(`No tests selected for ${suite}`);
  process.exit(2);
}
function run(label, args, cwd) {
  const started = performance.now();
  const child = spawnSync(process.execPath, args, { cwd, stdio: "inherit", env });
  if (child.error) console.error(child.error);
  const code = child.status ?? 1;
  console.log(`[tests:${suite}] ${label} wall time ${((performance.now() - started) / 1000).toFixed(2)}s · exit ${code}`);
  return code;
}

console.log(`[tests:${suite}] ${selected.length} Node files · concurrency ${concurrency ?? "Node default"} · process isolation`);
let code = run("Node",
  ["--experimental-strip-types",
    ...(suite === "plugins" ? ["--import", new URL("test/isolate-env.mjs", webRoot).href] : []),
    "--test", ...(concurrency ? [`--test-concurrency=${concurrency}`] : []),
    ...selected.map((file) => join(fileURLToPath(root), file))],
  suite === "plugins" ? fileURLToPath(webRoot) : undefined);
if (code === 0 && (suite === "ask" || suite === "all"))
  code = run("Vitest", ["node_modules/vitest/vitest.mjs", "run", "--config", "config/vitest/ask.config.ts"], repo);
process.exitCode = code;
