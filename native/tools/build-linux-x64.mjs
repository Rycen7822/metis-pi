import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(root, "native/tools");
const target = "x86_64-unknown-linux-musl";
const manifestPath = join(root, "assets/native-tools/linux-x64-manifest.json");
const helpers = [
  { name: "exec_bridge", path: "assets/native-tools/exec/linux-x64/exec_bridge" },
  { name: "view_image", path: "assets/native-tools/view-image/linux-x64/view_image" },
];
const mode = process.argv[2] ?? "build";
if (process.argv.length > 3 || !["build", "verify"].includes(mode)) throw new Error("Usage: node native/tools/build-linux-x64.mjs [build|verify]");
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("This builder verifies Linux x64 assets on Linux x64");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fileHash = path => hash(readFileSync(path));
const command = (name, args) => execFileSync(name, args, { cwd: root, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

function sourceInputs(directory = sourceRoot) {
  const inputs = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "target") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inputs.push(...sourceInputs(path));
    else if (entry.isFile() && (entry.name.endsWith(".rs") || ["Cargo.toml", "Cargo.lock", "build-linux-x64.mjs"].includes(entry.name))) {
      inputs.push({ path: relative(root, path).split(sep).join("/"), sha256: fileHash(path) });
    }
  }
  return inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function staticAbi(path) {
  const header = command("readelf", ["-W", "-h", path]);
  if (!/Class:\s+ELF64/.test(header) || !/Machine:\s+Advanced Micro Devices X86-64/.test(header)) throw new Error(`${path}: expected x86-64 ELF`);
  if (/\bINTERP\b/.test(command("readelf", ["-W", "-l", path]))) throw new Error(`${path}: dynamic interpreter is not allowed`);
  if (/\(NEEDED\)/.test(command("readelf", ["-W", "-d", path]))) throw new Error(`${path}: shared-library dependency is not allowed`);
  if (/GLIBC_[\d.]+/.test(command("readelf", ["-W", "--version-info", path]))) throw new Error(`${path}: GLIBC dependency is not allowed`);
  return { machine: "x86-64", interpreter: null, needed: [], glibcVersions: [] };
}

function verify(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.target !== target || manifest.source.root !== "native/tools") throw new Error("Unexpected native helper manifest");
  const inputs = sourceInputs();
  if (JSON.stringify(inputs) !== JSON.stringify(manifest.source.inputs) || hash(JSON.stringify(inputs)) !== manifest.source.sha256) {
    throw new Error("Checkout Rust/Cargo/build inputs differ from the packaged native helper manifest; rebuild the helpers");
  }
  if (manifest.assets.length !== helpers.length) throw new Error("Unexpected native helper asset count");
  for (const helper of helpers) {
    const asset = manifest.assets.find(candidate => candidate.path === helper.path);
    const path = join(root, helper.path);
    if (!asset || asset.sha256 !== fileHash(path) || asset.bytes !== statSync(path).size) throw new Error(`${helper.path}: packaged bytes differ from the manifest`);
    if (!(statSync(path).mode & 0o111)) throw new Error(`${helper.path}: executable permission is required`);
    if (JSON.stringify(asset.abi) !== JSON.stringify(staticAbi(path))) throw new Error(`${helper.path}: ABI differs from the manifest`);
  }
  console.log("Checkout sources and packaged static Linux x64 helpers verified.");
}

if (mode === "verify") {
  verify(JSON.parse(readFileSync(manifestPath, "utf8")));
} else {
  const inputs = sourceInputs();
  const targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR ?? ".work/native-tools-build");
  const rustFlags = ["-C", "target-feature=+crt-static", "-C", "target-cpu=x86-64"];
  const args = ["build", "--manifest-path", "native/tools/Cargo.toml", "--release", "--locked", "--offline", "--target", target, "--bin", "exec_bridge", "--bin", "view_image"];
  execFileSync("cargo", args, { cwd: root, stdio: "inherit", env: { ...process.env,
    CARGO_TARGET_DIR: targetDirectory, CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: "musl-gcc",
    CARGO_ENCODED_RUSTFLAGS: rustFlags.join("\x1f"),
  } });
  if (JSON.stringify(sourceInputs()) !== JSON.stringify(inputs)) throw new Error("Native source changed while building; packaged assets were not updated");
  const assets = helpers.map(helper => {
    const candidate = join(targetDirectory, target, "release", helper.name);
    return { path: helper.path, sha256: fileHash(candidate), bytes: statSync(candidate).size, abi: staticAbi(candidate) };
  });
  const manifest = {
    schemaVersion: 1, target,
    source: { root: "native/tools", baseRevision: command("git", ["rev-parse", "HEAD"]),
      baseRef: command("git", ["describe", "--tags", "--always", "HEAD"]),
      modified: Boolean(command("git", ["status", "--porcelain", "--", "native/tools"])),
      verification: "Requires a Git checkout containing native/tools; installed packages contain helper bytes only.",
      sha256: hash(JSON.stringify(inputs)), inputs },
    build: { command: ["cargo", ...args], rustc: command("rustc", ["--version"]), cargo: command("cargo", ["--version"]),
      linker: "musl-gcc", linkerVersion: command("musl-gcc", ["--version"]).split("\n")[0], rustFlags },
    assets,
  };
  for (const helper of helpers) {
    const destination = join(root, helper.path), temporary = `${destination}.tmp-${process.pid}`;
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(targetDirectory, target, "release", helper.name), temporary);
    chmodSync(temporary, 0o755); renameSync(temporary, destination);
  }
  const temporaryManifest = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`); renameSync(temporaryManifest, manifestPath);
  verify(manifest);
}
