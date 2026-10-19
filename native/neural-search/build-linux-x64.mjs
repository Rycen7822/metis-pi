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
  const files = readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "target") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return inputs(path);
    return entry.isFile() && (/(?:\.rs|\.toml|\.lock|\.h|\.mjs)$/.test(entry.name) || /^(?:LICENSE|COPYING|COPYRIGHT|NOTICE)(?:$|[-_.])/.test(entry.name))
      ? [{ path: relative(root, path), sha256: fileHash(path) }] : [];
  });
  if (directory === source) for (const name of ["api.ts", "ffi.ts", "finder.ts"]) {
    const path = `src/neural-search/native/binding/${name}`;
    files.push({ path, sha256: fileHash(join(root, path)) });
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
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
  const expected = ["abi_version", "create", "take_instance", "destroy", "files", "mixed", "grep", "multi_grep", "scan", "is_scanning", "progress", "health", "free_result", "get_file", "get_mixed", "get_match", "pointer_offset"].map(name => `metis_search_${name}`).sort();
  const exports = [...symbols].filter(name => /^(?:fff_|metis_search_)/.test(name)).sort();
  if (JSON.stringify(exports) !== JSON.stringify(expected)) throw new Error(`Unexpected private search ABI: ${exports.join(", ")}`);
  return { version: 6, machine: "x86-64", needed, glibc, exports };
}

function verify(manifest) {
  const current = inputs();
  if (manifest.schemaVersion !== 2 || manifest.target !== target || manifest.asset.path !== asset || manifest.minGlibc !== "2.31" || manifest.abiVersion !== 6 || manifest.build?.zlobZigCpu !== "baseline" || manifest.upstream?.version !== "0.11.0" || manifest.upstream?.commit !== "95fd777c2529fc7b4d7572dabff64cc07268f2c5")
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
  const rustc = command("rustc", ["--version"]);
  const zig = command("zig", ["version"]);
  const zigbuild = command("cargo-zigbuild", ["--version"]);
  if (!rustc.startsWith("rustc 1.94.0 ") || zig !== "0.16.0" || !zigbuild.endsWith("0.23.4"))
    throw new Error("Publish builds require Rust 1.94.0, Zig 0.16.0 and cargo-zigbuild 0.23.4; see native/neural-search/README.md.");
  // A shipped library must not silently inherit a developer's native CPU flags.
  // Local profiling can use cargo directly; the packaged target stays baseline x64.
  const supplied = process.env.CARGO_ENCODED_RUSTFLAGS;
  const flags = supplied === undefined ? (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean) : supplied.split("\x1f").filter(Boolean);
  const targetFlags = process.env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS ?? "";
  const cflags = [process.env.CFLAGS, process.env.CXXFLAGS, process.env.CFLAGS_x86_64_unknown_linux_gnu].filter(Boolean).join(" ");
  if (/target-(?:cpu|feature)|target_feature/.test([...flags, targetFlags].join(" ")) || /(?:-march=|-mcpu=|-m(?:avx|sse|aes|bmi))/.test(cflags))
    throw new Error("Packaged search builds reject host-specific CPU flags; use the portable build environment.");
  flags.push("-Ctarget-cpu=x86-64");
  writeNotices(root, source);
  const before = inputs();
  const output = resolve(root, process.env.CARGO_TARGET_DIR ?? ".work/neural-engine/target");
  const args = ["zigbuild", "--manifest-path", "native/neural-search/Cargo.toml", "--profile", "ci", "--locked", "--target", `${target}.2.31`, "-p", "fff-c"];
  execFileSync("cargo", args, { cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: output, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"), ZLOB_ZIG_CPU: "baseline" } });
  if (JSON.stringify(inputs()) !== JSON.stringify(before)) throw new Error("Search source changed during compilation; packaged bytes were not updated.");
  const candidate = join(output, target, "ci/libmetis_neural_search.so");
  const manifest = {
    schemaVersion: 2, target, minGlibc: "2.31", abiVersion: 6,
    upstream: { version: "0.11.0", commit: "95fd777c2529fc7b4d7572dabff64cc07268f2c5" },
    source: { roots: ["native/neural-search", "src/neural-search/native/binding"], sha256: hash(JSON.stringify(before)), inputs: before },
    build: { command: ["cargo", ...args], rustc, zig, zigbuild, rustFlags: flags, cFlags: cflags, zlobZigCpu: "baseline" },
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
