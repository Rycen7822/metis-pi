import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, chmodSync, renameSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash, hash, sourceInputs } from "./lib/native-assets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const native = "src/pi-session-recall/native";
const cargoManifest = `${native}/Cargo.toml`;
const packaged = "src/pi-session-recall/assets/linux-x64";
const worker = "bin/metis-session-recall";
const notice = "THIRD_PARTY_NOTICES.txt";
const platform = "x86_64-unknown-linux-gnu";
const glibcBaseline = [2, 39];
const minimumGlibc = glibcBaseline.join(".");
const linux = process.platform === "linux" && process.arch === "x64";
const command = (file, args, options) => execFileSync(file, args, { cwd: root, encoding: "utf8", ...options });
const include = name => /\.(rs|sql)$/.test(name);
const encoderCrates = ["src/local-embedding/bekko", "src/local-embedding/potion"];
const sourceDigest = () => hash(JSON.stringify([
  ...sourceInputs(root, join(root, native, "src"), include,
    [cargoManifest, `${native}/Cargo.lock`, "scripts/build-session-recall.mjs", "scripts/lib/native-assets.mjs"]),
  ...sourceInputs(root, join(root, native, "licenses"), () => true),
  ...encoderCrates.flatMap(dir => sourceInputs(root, join(root, dir, "src"), include, [`${dir}/Cargo.toml`])),
]));
const payload = directory => [worker, notice].map(path => ({
  path, sha256: fileHash(join(directory, path)), bytes: statSync(join(directory, path)).size,
}));

function verifyWorker(file) {
  const header = command("readelf", ["-Wh", file]);
  assert.match(header, /Class:\s+ELF64/);
  assert.match(header, /Machine:\s+Advanced Micro Devices X86-64/);
  assert.doesNotMatch(command("readelf", ["-Wd", file]), /\((RPATH|RUNPATH)\)/);
  const glibc = [...command("readelf", ["-WV", file]).matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)];
  const [baselineMajor, baselineMinor] = glibcBaseline;
  assert.ok(glibc.length && glibc.every(([, major, minor]) => +major < baselineMajor || +major === baselineMajor && +minor <= baselineMinor),
    `Recall worker must target glibc ${minimumGlibc} or earlier symbols`);
  assert.equal(command(file, ["--protocol"]).trim(), "1");
}

function dependencyNotices() {
  const metadata = JSON.parse(command("cargo", ["metadata", "--manifest-path", cargoManifest,
    "--locked", "--format-version", "1", "--filter-platform", platform], { maxBuffer: 8 * 1024 * 1024 }));
  const graph = new Map(metadata.resolve.nodes.map(node => [node.id, node.deps]));
  const closure = new Set([metadata.resolve.root]);
  for (const id of closure) for (const dep of graph.get(id)) {
    if (dep.dep_kinds.some(kind => kind.kind !== "dev")) closure.add(dep.pkg);
  }
  const rows = metadata.packages.filter(pkg => pkg.source && closure.has(pkg.id));
  rows.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
  const sections = ["Metis Session Recall — locked Linux x64 Rust and bundled native dependency notices"];
  for (const pkg of rows) {
    const local = join(root, native, "licenses", `${pkg.name}-${pkg.version}`);
    const dir = existsSync(local) ? local : dirname(pkg.manifest_path);
    const files = sourceInputs(dir, dir, name => /^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|UNLICENSE)(?:$|[-_.])/i.test(name));
    const names = [...new Set([...files.map(file => file.path), ...(pkg.license_file ? [pkg.license_file] : [])])].sort();
    assert.ok(names.length, `Missing redistributed notices for ${pkg.name} ${pkg.version}`);
    sections.push(`${pkg.name} ${pkg.version} — ${pkg.license ?? "see below"}`);
    for (const file of names) sections.push(`--- ${file} ---\n${readFileSync(join(dir, file), "utf8")}`);
  }
  return sections.join("\n\n") + "\n";
}

function verify(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.target, platform);
  assert.equal(manifest.minimumGlibc, minimumGlibc);
  assert.equal(manifest.sourceSha256, sourceDigest(), "Recall worker source changed; run npm run build:recall");
  assert.deepEqual(manifest.files, payload(directory), "Recall worker payload differs from its manifest");
  if (linux) verifyWorker(join(directory, worker));
  console.log("Packaged Recall worker: source and payload verified.");
}

function build(directory) {
  assert.ok(linux, `Build Recall on Linux x64 with glibc ${minimumGlibc}`);
  const rust = command("rustc", ["--version"]).trim();
  assert.match(rust, /^rustc 1\.94\.0 /, "Use Rust 1.94.0, matching the packaged standard-library notices");
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? ".work/session-recall-build");
  const cargoHome = resolve(process.env.CARGO_HOME ?? join(homedir(), ".cargo"));
  const sysroot = command("rustc", ["--print", "sysroot"]).trim();
  const mappings = [`${resolve(root)}=/metis-recall`, `${target}=/metis-target`, `${cargoHome}=/cargo`, `${sysroot}=/rustc`];
  const flags = ["-Ctarget-cpu=x86-64", ...mappings.map(mapping => `--remap-path-prefix=${mapping}`)];
  const sourceSha256 = sourceDigest();
  const notices = dependencyNotices();
  command("cargo", ["build", "--release", "--locked", "--target", platform, "--manifest-path", cargoManifest], {
    env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"), CARGO_PROFILE_RELEASE_STRIP: "symbols" },
    stdio: "inherit",
  });
  assert.equal(sourceDigest(), sourceSha256, "Recall worker source changed during build");
  const executable = join(directory, worker);
  mkdirSync(dirname(executable), { recursive: true });
  const incoming = `${executable}.${process.pid}.tmp`;
  try {
    copyFileSync(join(target, platform, "release/metis-session-recall"), incoming);
    chmodSync(incoming, 0o755);
    verifyWorker(incoming);
    renameSync(incoming, executable);
  } finally { rmSync(incoming, { force: true }); }
  writeFileSync(join(directory, notice), notices);
  const manifest = { target: platform, minimumGlibc, sourceSha256, rust, files: payload(directory) };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Staged Recall worker: ${executable}`);
}

if (process.argv[2] === "verify") verify(join(root, packaged));
else build(resolve(root, process.argv[2] ?? packaged));
