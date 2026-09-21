#!/usr/bin/env node
/**
 * Vendor tooling for `vendor/pi-codex-conversion` — a local copy of the npm package
 * `@howaboua/pi-codex-conversion`, maintained here so patches survive `pi update`.
 * Provenance, payload scope and the upgrade procedure live in that directory's
 * `UPSTREAM.md`; the patch list lives in `PATCHES.md`.
 *
 *   build   tsc -p tsconfig.build.json  +  changelog.ts -> changelog.js
 *   check   tsc -p tsconfig.json (type check the vendored sources)
 *   patch   diff the vendored sources against the pristine upstream checkout
 *   sync    copy a newer upstream over the vendored tree, replay the patch, rebuild
 *
 * Run through `npm run vendor:<action>`.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "pi-codex-conversion");
const UPSTREAM = join(ROOT, "references", "howaboua-pi-stuff", "packages", "pi-codex-conversion");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const PATCH_FILE = join(VENDOR, "patches", "local.patch");

/** Paths copied from upstream. `src` carries the patched sources; the rest are runtime assets. */
const VENDORED_PATHS = ["src", "vendor", "code-mode", "types", "changelog.ts", "CHANGELOG.md", "LICENSE"];
/** Payload trimming (see UPSTREAM.md): no voice helper binaries, native tools for linux-x64 only. */
const EXCLUDES = [
  /^src[/\\]voice[/\\]bin([/\\]|$)/,
  /^src[/\\]tools[/\\][^/\\]+[/\\]bin[/\\](?!linux-x64([/\\]|$))/,
];

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

function requireUpstream() {
  if (existsSync(UPSTREAM)) return;
  log(`pristine upstream checkout missing: ${relative(ROOT, UPSTREAM)}`);
  log("clone it first — see vendor/pi-codex-conversion/UPSTREAM.md");
  process.exit(1);
}

function copyFromUpstream(entry) {
  const source = join(UPSTREAM, entry);
  if (!existsSync(source)) return 0;
  // A vendored path can be a single file (`changelog.ts`), which `walk` cannot read.
  if (statSync(source).isFile()) {
    const target = join(VENDOR, entry);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    return 1;
  }
  let copied = 0;
  for (const path of walk(source)) {
    const relativePath = relative(UPSTREAM, path);
    if (EXCLUDES.some((pattern) => pattern.test(relativePath))) continue;
    const target = join(VENDOR, relativePath);
    if (statSync(path).isDirectory()) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path));
    // `writeFileSync` drops the executable bit the vendored native tools carry.
    chmodSync(target, statSync(path).mode);
    copied += 1;
  }
  return copied;
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

function patch() {
  requireUpstream();
  // Baseline: upstream `src` minus the payload trimming, so the diff shows only real changes
  // (otherwise every excluded binary would show up as a deletion).
  const baseline = mkdtempSync(join(tmpdir(), "pi-codex-vendor-"));
  try {
    const baselineSrc = join(baseline, "src");
    for (const path of walk(join(UPSTREAM, "src"))) {
      const relativePath = relative(UPSTREAM, path);
      if (EXCLUDES.some((pattern) => pattern.test(relativePath))) continue;
      const target = join(baseline, relativePath);
      if (statSync(path).isDirectory()) mkdirSync(target, { recursive: true });
      // cpSync keeps the file mode, so native tool binaries do not show up as mode changes.
      else cpSync(path, target);
    }
    let diff = "";
    try {
      diff = run("git", ["diff", "--no-index", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", baselineSrc, join(VENDOR, "src")]);
    } catch (error) {
      diff = error.stdout ?? "";
    }
    // Re-root at `src/` so the patch applies with `git apply -p1` from the vendored directory.
    // Both trees appear on both sides: `git diff --no-index` reuses the only available path for
    // files that exist in a single tree (for example a newly added helper).
    const normalized = diff
      .replaceAll(`a${baselineSrc}${sep}`, "a/src/")
      .replaceAll(`b${baselineSrc}${sep}`, "b/src/")
      .replaceAll(`a${join(VENDOR, "src")}${sep}`, "a/src/")
      .replaceAll(`b${join(VENDOR, "src")}${sep}`, "b/src/");
    mkdirSync(dirname(PATCH_FILE), { recursive: true });
    writeFileSync(PATCH_FILE, normalized);
    const files = [...normalized.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]);
    const lines = normalized.split("\n");
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    log(`patch: ${relative(ROOT, PATCH_FILE)} — ${files.length} file(s), +${added} -${removed}`);
    for (const file of files) log(`  ${file}`);
    if (files.length === 0) log("  (vendored sources are identical to upstream)");
  } finally {
    rmSync(baseline, { recursive: true, force: true });
  }
}

function sync() {
  requireUpstream();
  const upstreamVersion = JSON.parse(readFileSync(join(UPSTREAM, "package.json"), "utf8")).version;
  const vendoredVersion = JSON.parse(readFileSync(join(VENDOR, "package.json"), "utf8")).version;
  log(`syncing upstream ${upstreamVersion} (vendored ${vendoredVersion})`);
  // Sources and assets are replaced wholesale; patch files, docs and manifests stay.
  for (const entry of VENDORED_PATHS) rmSync(join(VENDOR, entry), { recursive: true, force: true });
  let copied = 0;
  for (const entry of VENDORED_PATHS) copied += copyFromUpstream(entry);
  log(`copied ${copied} file(s) from ${relative(ROOT, UPSTREAM)}`);
  if (existsSync(PATCH_FILE) && readFileSync(PATCH_FILE, "utf8").trim() !== "") {
    log("replaying patches/local.patch");
    try {
      // `git apply` resolves patch paths against the repository root, so run it from there and
      // prepend the vendored directory — running it inside the subdirectory skips every file.
      run("git", ["apply", "-p1", "--whitespace=nowarn", `--directory=${relative(ROOT, VENDOR)}`, relative(ROOT, PATCH_FILE)], { cwd: ROOT });
      log("  applied cleanly");
    } catch (error) {
      log("  PATCH DID NOT APPLY — reconcile by hand, then update PATCHES.md");
      log(String(error.stderr ?? error.message));
      process.exit(1);
    }
  }
  build();
  log("sync ok — review the diff, update UPSTREAM.md version/commit, run the full gate suite");
}

const actions = { build, check, patch, sync };
const action = process.argv[2];
if (!action || !(action in actions)) {
  log(`usage: node scripts/vendor-codex-conversion.mjs <${Object.keys(actions).join("|")}>`);
  process.exit(action ? 1 : 0);
}
actions[action]();
