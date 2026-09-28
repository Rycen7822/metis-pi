#!/usr/bin/env node
/** Build and type-check the locally maintained conversion fork.
 * Source and Git history own local changes; see UPSTREAM.md for selective updates.
 * Runtime JavaScript stays committed; generated declarations remain local.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "pi-codex-conversion");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const log = (message) => process.stdout.write(`${message}\n`);

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf-8", ...options });
}

/** Every file and directory below `dir`, skipping node_modules. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    out.push(path);
    if (entry.isDirectory()) out.push(...walk(path));
  }
  return out;
}

function summarize(dir) {
  const files = walk(dir).filter((path) => statSync(path).isFile());
  const bytes = files.reduce((total, path) => total + statSync(path).size, 0);
  return `${files.length} files, ${(bytes / 1048576).toFixed(1)} MB`;
}

function build() {
  rmSync(join(VENDOR, "dist"), { recursive: true, force: true });
  log("building vendored sources -> dist/");
  run(process.execPath, [TSC, "-p", join(VENDOR, "tsconfig.build.json")]);
  // The entry imports ../changelog.ts from source and ../changelog.js once built.
  const changelog = readFileSync(join(VENDOR, "changelog.ts"), "utf8");
  writeFileSync(join(VENDOR, "changelog.js"), stripTypeScriptTypes(changelog, { mode: "strip" }));
  log(`dist/   ${summarize(join(VENDOR, "dist"))}`);
  log(`vendor/ ${summarize(join(VENDOR, "vendor"))}`);
  log("build ok");
}

function check() {
  log("type-checking vendored sources (tsconfig.json)");
  run(process.execPath, [TSC, "-p", join(VENDOR, "tsconfig.json"), "--noEmit"]);
  log("check ok: 0 type errors");
}

const actions = { build, check };
const action = process.argv[2];
if (!action || !(action in actions)) {
  log(`usage: node scripts/vendor-codex-conversion.mjs <${Object.keys(actions).join("|")}>`);
  process.exit(action ? 1 : 0);
}
actions[action]();
