#!/usr/bin/env node
// File selection only. Each test still runs in Node's own isolated test process.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../test/", import.meta.url);
const files = (dir = root, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const name = `${prefix}${entry.name}`;
  if (entry.isDirectory()) return files(new URL(`${entry.name}/`, dir), `${name}/`);
  return entry.isFile() && /\.test\.m(?:j|t)s$/.test(name) ? [name] : [];
});

const suites = {
  all: () => true,
  core: (file) => file.startsWith("core/"),
  host: (file) => file.startsWith("contract/") || file === "package.test.mjs",
  protocol: (file) => file.startsWith("protocol/"),
  io: (file) => file.startsWith("io/"),
  resource: (file) => file.startsWith("resource/"),
  chrome: (file) => [
    "core/chrome", "core/working", "core/hardware-cursor",
    "contract/appearance", "contract/editor", "contract/copy-mirror", "contract/copy-text",
    "contract/fullscreen", "contract/history-window", "contract/clipboard-facade",
    "resource/copy-cache", "resource/copy-heap", "resource/windows-clipboard",
  ].some((owner) => file.startsWith(`${owner}.test.`)),
};

const suite = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(suites, suite)) {
  console.error(`Usage: node scripts/test.mjs <${Object.keys(suites).join("|")}>`);
  process.exit(2);
}
const selected = files().sort().filter(suites[suite]);
if (selected.length === 0) {
  console.error(`No tests selected for ${suite}`);
  process.exit(2);
}
const child = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...selected.map((file) => join(fileURLToPath(root), file))], { stdio: "inherit" });
if (child.error) console.error(child.error);
process.exitCode = child.status ?? 1;
