import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeNotices } from "./notices.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, "../..");
const target = "x86_64-unknown-linux-gnu";
const asset = "assets/neural-search/linux-x64/libmetis_neural_search.so";
const manifestPath = join(root, "assets/neural-search/linux-x64-manifest.json");
const notices = ["assets/neural-search/THIRD_PARTY_NOTICES.txt", "assets/neural-search/RUST-STDLIB-NOTICES.html"];
const mode = process.argv[2] ?? "build";
if (process.argv.length > 3 || !["build", "verify"].includes(mode)) throw new Error("Usage: node native/neural-search/build-linux-x64.mjs [build|verify]");
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The owned search library targets Linux x64 glibc only.");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fileHash = path => hash(readFileSync(path));
const command = (name, args, options = {}) => execFileSync(name, args, { cwd: root, encoding: "utf8", ...options }).trim();

function inputs(directory = source) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "target") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return inputs(path);
    return entry.isFile() && (/(?:\.rs|\.toml|\.lock|\.h|\.mjs)$/.test(entry.name) || /^(?:LICENSE|COPYING|COPYRIGHT|NOTICE)(?:$|[-_.])/.test(entry.name))
      ? [{ path: relative(root, path), sha256: fileHash(path) }] : [];
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function abi(path) {
  const header = command("readelf", ["-W", "-h", path]);
  if (!/Class:\s+ELF64/.test(header) || !/Machine:\s+Advanced Micro Devices X86-64/.test(header) || !/Type:\s+DYN/.test(header))
    throw new Error("Expected an x86-64 ELF shared library.");
  const dynamic = command("readelf", ["-W", "-d", path]);
  if (/\((?:RPATH|RUNPATH)\)/.test(dynamic)) throw new Error("Search library must not embed a build-machine library path.");
  const needed = [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(match => match[1]).sort();
  const allowed = new Set(["libgcc_s.so.1", "libm.so.6", "libc.so.6", "ld-linux-x86-64.so.2", "libpthread.so.0", "librt.so.1", "libdl.so.2"]);
  if (needed.some(name => !allowed.has(name))) throw new Error(`Unexpected shared dependencies: ${needed.join(", ")}`);
  const glibc = [...new Set(command("readelf", ["-W", "--version-info", path]).match(/GLIBC_[\d.]+/g))].sort();
  if (!glibc.length || glibc.some(version => {
    const [major, minor] = version.slice(6).split(".").map(Number);
    return major > 2 || major === 2 && minor > 31;
  })) throw new Error("Search library must target glibc 2.31 or older symbols.");
  const symbols = new Set(command("readelf", ["-W", "--dyn-syms", path]).split("\n").filter(line => !/\bUND\b/.test(line)).map(line => line.trim().split(/\s+/).at(-1)));
  for (const name of ["fff_create_instance_with", "fff_destroy", "fff_search", "fff_search_mixed", "fff_live_grep_ex", "fff_multi_grep_ex", "fff_scan_files", "fff_is_scanning", "fff_get_scan_progress", "fff_health_check", "fff_free_result", "fff_free_search_result", "fff_free_mixed_search_result", "fff_free_grep_result", "fff_free_scan_progress", "fff_free_string", "fff_ptr_offset", "fff_search_result_get_item", "fff_search_result_get_score", "fff_mixed_search_result_get_item", "fff_mixed_search_result_get_score", "fff_grep_result_get_match"])
    if (!symbols.has(name)) throw new Error(`Search ABI symbol missing: ${name}`);
  return { machine: "x86-64", needed, glibc };
}

function verify(manifest) {
  const current = inputs();
  if (manifest.schemaVersion !== 1 || manifest.target !== target || manifest.asset.path !== asset || manifest.minGlibc !== "2.31" || manifest.createOptionsVersion !== 2 || manifest.engineVersion !== "0.11.0")
    throw new Error("Unexpected search library manifest.");
  if (JSON.stringify(current) !== JSON.stringify(manifest.source.inputs) || hash(JSON.stringify(current)) !== manifest.source.sha256)
    throw new Error("Search engine source differs from the packaged library; rebuild it.");
  const path = join(root, asset);
  if (manifest.asset.sha256 !== fileHash(path) || manifest.asset.bytes !== statSync(path).size)
    throw new Error("Search library bytes differ from the manifest.");
  if (JSON.stringify(manifest.asset.abi) !== JSON.stringify(abi(path))) throw new Error("Search library ABI differs from the manifest.");
  for (const name of notices)
    if (manifest.notices?.find(entry => entry.path === name)?.sha256 !== fileHash(join(root, name))) throw new Error(`Search library notices differ: ${name}`);
  console.log("Owned Linux x64 search library: source, bytes and ABI verified.");
}

if (mode === "verify") {
  verify(JSON.parse(readFileSync(manifestPath, "utf8")));
} else {
  writeNotices(root, source);
  const before = inputs();
  const output = resolve(root, process.env.CARGO_TARGET_DIR ?? ".work/neural-engine/target");
  const args = ["zigbuild", "--manifest-path", "native/neural-search/Cargo.toml", "--profile", "ci", "--locked", "--target", `${target}.2.31`, "-p", "fff-c", "--no-default-features", "--features", "zlob"];
  execFileSync("cargo", args, { cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: output } });
  if (JSON.stringify(inputs()) !== JSON.stringify(before)) throw new Error("Search source changed during compilation; packaged bytes were not updated.");
  const candidate = join(output, target, "ci/libmetis_neural_search.so");
  const manifest = {
    schemaVersion: 1, target, minGlibc: "2.31", engineVersion: "0.11.0", createOptionsVersion: 2,
    source: { root: "native/neural-search", sha256: hash(JSON.stringify(before)), inputs: before },
    build: { command: ["cargo", ...args], rustc: command("rustc", ["--version"]), zig: command("zig", ["version"]), rustFlags: process.env.CARGO_ENCODED_RUSTFLAGS ?? process.env.RUSTFLAGS ?? "" },
    asset: { path: asset, sha256: fileHash(candidate), bytes: statSync(candidate).size, abi: abi(candidate) },
    notices: notices.map(path => ({ path, sha256: fileHash(join(root, path)) })),
  };
  mkdirSync(dirname(join(root, asset)), { recursive: true });
  const temporary = `${join(root, asset)}.tmp-${process.pid}`;
  copyFileSync(candidate, temporary);
  renameSync(temporary, join(root, asset));
  writeFileSync(`${manifestPath}.tmp-${process.pid}`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${manifestPath}.tmp-${process.pid}`, manifestPath);
  verify(manifest);
}
