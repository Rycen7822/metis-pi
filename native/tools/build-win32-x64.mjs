import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, fileHash, peInfo, sourceInputs as collectSourceInputs } from "../../scripts/lib/native-assets.mjs";

// Builds the Windows x64 exec helper. It runs natively from Windows or is
// cross-built from Linux with the Rust MSVC target, Zig as C compiler and
// rust-lld; the crate itself needs no platform-specific source changes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(root, "native/tools");
const target = "x86_64-pc-windows-msvc";
const manifestPath = join(root, "assets/native-tools/win32-x64-manifest.json");
const helpers = [
  { name: "exec_bridge", path: "assets/native-tools/exec/win32-x64/exec_bridge.exe" },
];
const mode = process.argv[2] ?? "build";
if (process.argv.length > 3 || !["build", "verify"].includes(mode)) throw new Error("Usage: node native/tools/build-win32-x64.mjs [build|verify]");

const command = (name, args) => execFileSync(name, args, { cwd: root, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

const sourceInputs = () => collectSourceInputs(root, sourceRoot,
  name => name.endsWith(".rs") || ["Cargo.toml", "Cargo.lock", "build-linux-x64.mjs", "build-win32-x64.mjs"].includes(name), ["scripts/lib/native-assets.mjs"]);

// A shipped helper must stay runnable on a machine without Visual C++ runtime
// redistributables, so the C runtime is linked statically.
const SYSTEM_IMPORTS = /^(?:KERNEL32|NTDLL|ADVAPI32|WS2_32|OLE32|SECUR32|SHELL32|USER32|CRYPT32|BCRYPT|BCRYPTPRIMITIVES|api-ms-win-[a-z0-9-]+)\.dll$/i;

function peAbi(path) {
  const info = peInfo(path);
  if (info.machine !== "x86-64") throw new Error(`${path}: expected an x86-64 PE image`);
  if (info.dll) throw new Error(`${path}: expected an executable, not a DLL`);
  if (info.imports.some(name => !SYSTEM_IMPORTS.test(name))) throw new Error(`${path}: unexpected Windows imports: ${info.imports.join(", ")}`);
  return { machine: "x86-64", crt: "static", imports: info.imports };
}

function verify(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.target !== target || manifest.source.root !== "native/tools") throw new Error("Unexpected native helper manifest");
  const inputs = sourceInputs();
  if (JSON.stringify(inputs) !== JSON.stringify(manifest.source.inputs) || hash(JSON.stringify(inputs)) !== manifest.source.sha256)
    throw new Error("Checkout Rust/Cargo/build inputs differ from the packaged native helper manifest; rebuild the helpers");
  if (manifest.assets.length !== helpers.length) throw new Error("Unexpected native helper asset count");
  for (const helper of helpers) {
    const asset = manifest.assets.find(candidate => candidate.path === helper.path);
    const path = join(root, helper.path);
    if (!asset || asset.sha256 !== fileHash(path) || asset.bytes !== statSync(path).size) throw new Error(`${helper.path}: packaged bytes differ from the manifest`);
    if (JSON.stringify(asset.abi) !== JSON.stringify(peAbi(path))) throw new Error(`${helper.path}: ABI differs from the manifest`);
  }
  console.log("Checkout sources and packaged Windows x64 helpers verified.");
}

if (mode === "verify") {
  verify(JSON.parse(readFileSync(manifestPath, "utf8")));
} else {
  const native = process.platform === "win32";
  if (!native && (process.platform !== "linux" || process.arch !== "x64")) throw new Error("Build Windows x64 assets on Windows x64 or cross-build from Linux x64.");
  const inputs = sourceInputs();
  const targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR ?? ".work/native-tools-win-build", "owned-rust1.94.0-win-x64");
  const rustFlags = ["-C", "target-feature=+crt-static", "-C", "target-cpu=x86-64"];
  const args = ["build", "--manifest-path", "native/tools/Cargo.toml", "--release", "--locked", "--target", target, "--bin", "exec_bridge"];
  const environment = { ...process.env, CARGO_TARGET_DIR: targetDirectory, CARGO_ENCODED_RUSTFLAGS: rustFlags.join("\x1f") };
  if (!native) {
    const sysroot = command("rustc", ["--print", "sysroot"]);
    const { ZIG, WINDOWS_ZIGCC, WINDOWS_ZIGAR, WINDOWS_SDK_LIB, WINDOWS_MSVC_LIB } = process.env;
    if (!ZIG || !WINDOWS_ZIGCC || !WINDOWS_SDK_LIB || !WINDOWS_MSVC_LIB)
      throw new Error("Cross-building the Windows helper requires ZIG, WINDOWS_ZIGCC, WINDOWS_SDK_LIB and WINDOWS_MSVC_LIB.");
    Object.assign(environment, {
      CC_x86_64_pc_windows_msvc: WINDOWS_ZIGCC,
      AR_x86_64_pc_windows_msvc: WINDOWS_ZIGAR,
      CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: join(sysroot, "lib/rustlib", process.env.HOST_TRIPLE ?? "x86_64-unknown-linux-gnu", "bin/rust-lld"),
    });
    environment.CARGO_ENCODED_RUSTFLAGS = [...rustFlags, `-Lnative=${WINDOWS_SDK_LIB}/um/x64`, `-Lnative=${WINDOWS_SDK_LIB}/ucrt/x64`, `-Lnative=${WINDOWS_MSVC_LIB}`].join("\x1f");
  }
  execFileSync("cargo", args, { cwd: root, stdio: "inherit", env: environment });
  if (JSON.stringify(sourceInputs()) !== JSON.stringify(inputs)) throw new Error("Native source changed while building; packaged assets were not updated");
  const assets = helpers.map(helper => {
    const candidate = join(targetDirectory, target, "release", `${helper.name}.exe`);
    return { path: helper.path, sha256: fileHash(candidate), bytes: statSync(candidate).size, abi: peAbi(candidate) };
  });
  const manifest = {
    schemaVersion: 1, target,
    source: { root: "native/tools", baseRevision: command("git", ["rev-parse", "HEAD"]),
      baseRef: command("git", ["describe", "--tags", "--always", "HEAD"]),
      modified: Boolean(command("git", ["status", "--porcelain", "--", "native/tools"])),
      verification: "Requires a Git checkout containing native/tools; installed packages contain helper bytes only.",
      sha256: hash(JSON.stringify(inputs)), inputs },
    build: { command: ["cargo", ...args], rustc: command("rustc", ["--version"]), cargo: command("cargo", ["--version"]),
      linker: native ? "link.exe" : "rust-lld", rustFlags },
    assets,
  };
  for (const helper of helpers) {
    const destination = join(root, helper.path), temporary = `${destination}.tmp-${process.pid}`;
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(targetDirectory, target, "release", `${helper.name}.exe`), temporary);
    renameSync(temporary, destination);
  }
  const temporaryManifest = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`); renameSync(temporaryManifest, manifestPath);
  verify(manifest);
}
