// Maintainer packaging only; end users install/update through Pi.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const { values } = parseArgs({ options: {
  runtime: { type: "string" }, release: { type: "string" }, output: { type: "string" },
} });
if (!values.runtime || !/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(values.release ?? "")) {
  throw new Error("Specify --runtime <prepared-directory> --release <immutable-release-tag> [--output <directory>].");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.resolve(values.runtime);
const output = path.resolve(values.output ?? path.join(root, "external/semantic-release", values.release));
const destination = path.join(root, "src/neural-search/runtime/distribution.json");
const previous = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, "utf8")) : undefined;
const catalog = JSON.parse(fs.readFileSync(path.join(runtime, "assets.json"), "utf8"));
const env = { ...process.env, SGREP_RUNTIME_DIR: runtime, HF_HUB_OFFLINE: "1" };
delete env.LD_LIBRARY_PATH;
delete env.LD_PRELOAD;
const check = JSON.parse(execFileSync(path.join(runtime, "bin/sgrep"), ["--check-runtime"], { env, encoding: "utf8", timeout: 120_000 }));
if (check.runtime_check !== 1 || !check.models.includes("bekko128") || !check.models.includes("lateon-edge")) {
  throw new Error("Prepared runtime did not execute both models.");
}
fs.mkdirSync(output, { recursive: true });
const download = `https://github.com/Rycen7822/metis-pi/releases/download/${values.release}`;

function inventory(directory, names) {
  const files = {};
  function collect(name) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) collect(`${name}/${child}`);
    else if (stat.isFile()) files[name] = stat.size;
    else throw new Error(`Release payload must contain physical files: ${file}`);
  }
  for (const name of names) collect(name);
  return files;
}

async function archive(name, directory, files, notices = []) {
  const filename = `${name}.tar.gz`;
  const target = path.join(output, filename);
  execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--format=ustar",
    "-czf", target, "-C", directory, ...Object.keys(files).sort(),
    ...(notices.length ? ["-C", runtime, ...notices] : [])], { stdio: "inherit" });
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  return { id: `${name}-${sha256}`, url: `${download}/${filename}`, bytes: fs.statSync(target).size, sha256 };
}

const engineFiles = inventory(runtime, ["bin", "lib", "parsers", "notices"]);
const engine = { ...await archive("engine-linux-x64", runtime, engineFiles), files: engineFiles };
const models = {};
for (const name of ["bekko128", "lateon-edge"]) {
  const { revision, files } = catalog.models[name];
  const approved = { revision, files };
  const old = previous?.models?.[name];
  if (old?.notices && isDeepStrictEqual(old.catalog, approved)) {
    models[name] = old; // Immutable model release URL stays unchanged when only the engine changes.
    continue;
  }
  const directory = catalog.models[name].directory ?? path.join(runtime, "models", name);
  const sizes = inventory(directory, Object.keys(files));
  for (const [file, metadata] of Object.entries(files)) {
    if (sizes[file] !== metadata.bytes) throw new Error(`Model file size mismatch: ${name}/${file}`);
  }
  const notices = ["notices/Prepared-models-NOTICE.txt", ...(name === "bekko128"
    ? ["notices/Bekko-model-card.md", "notices/Bekko-MIT.txt"]
    : ["notices/LateOn-model-card.md", "notices/Apache-2.0.txt"])];
  models[name] = { ...await archive(`model-${name}`, directory, sizes, notices), catalog: approved,
    notices: inventory(runtime, notices) };
}
// readelf: the current CLI requires GLIBC_2.39; native/ORT require 2.38. Lower only after rebuilding/requalification.
const distribution = { format_version: 1, id: values.release, minimum_glibc: "2.39", engine, models };
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(distribution, null, 2) + "\n");
fs.writeFileSync(path.join(output, "distribution.json"), JSON.stringify(distribution, null, 2) + "\n");
console.log(`Release assets: ${output}\nDistribution: ${destination}`);
