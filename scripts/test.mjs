#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = new URL("../src/pi-web-access/", import.meta.url);
const [suite, shard, ...extra] = process.argv.slice(2);
const webAccess = suite === "web-access";
const root = webAccess ? new URL("test/", webRoot) : new URL("../test/", import.meta.url);
const files = (dir = root, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const name = `${prefix}${entry.name}`;
  if (entry.isDirectory()) return files(new URL(`${entry.name}/`, dir), `${name}/`);
  return entry.isFile() && /\.test\.m(?:j|t)s$/.test(name) ? [name] : [];
});

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
const selected = files().sort().filter(suites[suite]);
if (selected.length === 0) {
  console.error(`No tests selected for ${suite}`);
  process.exit(2);
}
const child = spawnSync(
  process.execPath,
  ["--experimental-strip-types",
    ...(webAccess ? ["--import", new URL("test/isolate-env.mjs", webRoot).href] : []),
    "--test", ...(shard ? [shard] : []), ...selected.map((file) => join(fileURLToPath(root), file))],
  { stdio: "inherit", ...(webAccess ? { cwd: fileURLToPath(webRoot) } : {}) },
);
if (child.error) console.error(child.error);
process.exitCode = child.status ?? 1;
const runAsk = suite === "ask" || (suite === "all" && (!shard || shard.startsWith("--test-shard=1/")));
if (process.exitCode === 0 && runAsk) {
  const ask = spawnSync(process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--config", "config/vitest/ask.config.ts"],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" });
  if (ask.error) console.error(ask.error);
  process.exitCode = ask.status ?? 1;
}
