import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeNotices } from "./notices.mjs";
import { hash, fileHash, peInfo, sourceInputs } from "../../../scripts/lib/native-assets.mjs";

// Builds the Windows x64 search library from Linux by cross-linking with the
// Rust MSVC target, Zig as the C compiler and rust-lld. A Windows host can run
// the same script natively once Visual Studio and Zig are installed; nothing
// here requires cargo-zigbuild, whose MSVC support cannot pass MSVC arguments.
const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, "../../..");
const target = "x86_64-pc-windows-msvc";
const asset = "src/neural-search/assets/win32-x64/metis_neural_search.dll";
const manifestPath = join(root, "src/neural-search/assets/win32-x64-manifest.json");
const notices = ["src/neural-search/assets/THIRD_PARTY_NOTICES-win32-x64.txt", "src/neural-search/assets/RUST-STDLIB-NOTICES.html"];
const mode = process.argv[2] ?? "build";
if (process.argv.length > 3 || !["build", "verify"].includes(mode)) throw new Error("Usage: node src/neural-search/engine/build-win32-x64.mjs [build|verify]");

const command = (name, args, options = {}) => execFileSync(name, args, { cwd: root, encoding: "utf8", ...options }).trim();
const bindingInputs = ["api.ts", "ffi.ts", "finder.ts"].map(name => `src/neural-search/native/binding/${name}`);
const inputs = () => sourceInputs(root, source,
  name => /(?:\.rs|\.toml|\.lock|\.h|\.mjs)$/.test(name) || /^(?:LICENSE|COPYING|COPYRIGHT|NOTICE)(?:$|[-_.])/.test(name),
  [...bindingInputs, "scripts/lib/native-assets.mjs"]);

const EXPORTS = ["abi_version", "create", "take_instance", "destroy", "files", "mixed", "grep", "multi_grep", "scan", "progress", "health", "free_result", "get_file", "get_mixed", "get_match", "pointer_offset"].map(name => `metis_search_${name}`).sort();
// Windows system DLLs a static-CRT image may import. libgit2 pulls the extra
// Win32 APIs; the C runtime itself must stay static to keep the asset portable.
const SYSTEM_IMPORTS = /^(?:KERNEL32|NTDLL|ADVAPI32|WS2_32|OLE32|SECUR32|SHELL32|USER32|CRYPT32|BCRYPT|BCRYPTPRIMITIVES|api-ms-win-[a-z0-9-]+)\.dll$/i;
// Windows has no shared-library visibility control, so the statically linked C
// dependencies export their own symbols next to ours. Accept the known families
// and reject anything else, which is what would indicate leaked upstream API.
const STATIC_DEPENDENCY_EXPORTS = /^(?:metis_search_|fff_|git_|giterr_|pcre2_|ntlm_|mdb_|blake3_|crc32|adler32|compress|uncompress|deflate|inflate|zlib)/i;

function abi(path) {
  const info = peInfo(path);
  if (info.machine !== "x86-64" || !info.dll) throw new Error("Expected an x86-64 PE DLL.");
  if (info.imports.some(name => !SYSTEM_IMPORTS.test(name))) throw new Error(`Unexpected Windows imports: ${info.imports.join(", ")}`);
  // The private metis_search_* + fff_* surface is the SDK contract and must match
  // exactly; a stray fff_* export therefore fails here rather than silently ship.
  const privateExports = info.exports.filter(name => /^(?:metis_search_|fff_)/.test(name)).sort();
  if (JSON.stringify(privateExports) !== JSON.stringify(EXPORTS)) throw new Error(`Unexpected private search ABI: ${privateExports.join(", ")}`);
  const unexpected = info.exports.filter(name => !STATIC_DEPENDENCY_EXPORTS.test(name));
  if (unexpected.length) throw new Error(`Unexpected exported symbols: ${unexpected.slice(0, 5).join(", ")}`);
  return { machine: "x86-64", crt: "static", imports: info.imports, exports: privateExports };
}

function verify(manifest) {
  const current = inputs();
  if (manifest.schemaVersion !== 2 || manifest.target !== target || manifest.asset.path !== asset || manifest.crt !== "static" || manifest.abiVersion !== 7 || manifest.upstream?.version !== "0.11.0" || manifest.upstream?.commit !== "95fd777c2529fc7b4d7572dabff64cc07268f2c5")
    throw new Error("Unexpected Windows search library manifest.");
  if (JSON.stringify(current) !== JSON.stringify(manifest.source.inputs) || hash(JSON.stringify(current)) !== manifest.source.sha256)
    throw new Error("Search engine source differs from the packaged Windows library; rebuild it.");
  const path = join(root, asset);
  if (manifest.asset.sha256 !== fileHash(path) || manifest.asset.bytes !== statSync(path).size)
    throw new Error("Windows search library bytes differ from the manifest.");
  if (JSON.stringify(manifest.asset.abi) !== JSON.stringify(abi(path))) throw new Error("Windows search library ABI differs from the manifest.");
  for (const name of notices)
    if (manifest.notices?.find(entry => entry.path === name)?.sha256 !== fileHash(join(root, name))) throw new Error(`Windows search library notices differ: ${name}`);
  console.log("Owned Windows x64 search library: source, bytes and ABI verified.");
}

// Cross and native builds differ only in these inputs. Every path comes from
// the environment so no build machine path reaches the product or the manifest.
function crossEnvironment() {
  const zig = process.env.ZIG;
  const sysroot = command("rustc", ["--print", "sysroot"]);
  const rustLld = join(sysroot, "lib/rustlib", process.env.HOST_TRIPLE ?? "x86_64-unknown-linux-gnu", "bin/rust-lld");
  const sdk = process.env.WINDOWS_SDK_LIB;
  const msvc = process.env.WINDOWS_MSVC_LIB;
  const includes = process.env.WINDOWS_C_INCLUDE;
  if (!zig || !sdk || !msvc || !includes || !process.env.WINDOWS_ZIGCC || !process.env.WINDOWS_ZIGAR)
    throw new Error("Cross-building the Windows library requires ZIG, WINDOWS_ZIGCC, WINDOWS_ZIGAR, WINDOWS_C_INCLUDE, WINDOWS_SDK_LIB and WINDOWS_MSVC_LIB.");
  return {
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: rustLld,
    CC_x86_64_pc_windows_msvc: process.env.WINDOWS_ZIGCC,
    AR_x86_64_pc_windows_msvc: process.env.WINDOWS_ZIGAR,
    CFLAGS_x86_64_pc_windows_msvc: includes,
    extraFlags: [`-Lnative=${sdk}/um/x64`, `-Lnative=${sdk}/ucrt/x64`, `-Lnative=${msvc}`, `-Clink-arg=${msvc}/oldnames.lib`],
  };
}

if (mode === "verify") {
  verify(JSON.parse(readFileSync(manifestPath, "utf8")));
} else {
  const native = process.platform === "win32";
  if (!native && (process.platform !== "linux" || process.arch !== "x64")) throw new Error("Build Windows x64 assets on Windows x64 or cross-build from Linux x64.");
  const rustc = command("rustc", ["--version"]);
  if (!rustc.startsWith("rustc 1.94.0 ")) throw new Error("Publish builds require Rust 1.94.0; see src/neural-search/engine/README.md.");
  if (!native) {
    const zig = command(process.env.ZIG, ["version"]);
    if (zig !== "0.16.0") throw new Error("Cross-building requires Zig 0.16.0.");
  }
  writeNotices(root, source, target);
  const before = inputs();
  const output = resolve(root, process.env.CARGO_TARGET_DIR ?? ".work/neural-engine-win/target", "owned-rust1.94.0-win-x64");
  const flags = ["-Ctarget-feature=+crt-static", "-Ctarget-cpu=x86-64"];
  const remapPaths = [[root, "/metis-neural-search"], [realpathSync(process.env.CARGO_HOME ?? join(homedir(), ".cargo")), "/cargo"], [output, "/metis-target"]];
  flags.push(...remapPaths.map(([from, to]) => `--remap-path-prefix=${from}=${to}`));
  const args = ["build", "--manifest-path", "src/neural-search/engine/Cargo.toml", "--profile", "ci", "--locked", "--target", target, "-p", "fff-c"];
  const environment = { ...process.env, CARGO_TARGET_DIR: output, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"), ZLOB_ZIG_CPU: "baseline" };
  if (!native) {
    const { extraFlags, ...cross } = crossEnvironment();
    Object.assign(environment, cross);
    environment.CARGO_ENCODED_RUSTFLAGS = [...flags, ...extraFlags].join("\x1f");
  }
  execFileSync("cargo", args, { cwd: root, stdio: "inherit", env: environment });
  if (JSON.stringify(inputs()) !== JSON.stringify(before)) throw new Error("Search source changed during compilation; packaged bytes were not updated.");
  const candidate = join(output, target, "ci", "metis_neural_search.dll");
  const manifest = {
    schemaVersion: 2, target, crt: "static", abiVersion: 7,
    upstream: { version: "0.11.0", commit: "95fd777c2529fc7b4d7572dabff64cc07268f2c5" },
    source: { roots: ["src/neural-search/engine", "src/neural-search/native/binding"], sha256: hash(JSON.stringify(before)), inputs: before },
    build: { command: ["cargo", ...args], rustc, zig: native ? null : command(process.env.ZIG, ["version"]), rustFlags: flags, pathRemapping: remapPaths.map(([, to]) => to), cFlags: environment.CFLAGS_x86_64_pc_windows_msvc ?? "", zlobZigCpu: "baseline" },
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
