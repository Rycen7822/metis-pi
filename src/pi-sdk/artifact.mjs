import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const sdkVersion = "1.6.1";
export const sdkUpstreamCommit = "ef4a1cfcca62b77ad3558337ff3e1c7f6beeadfe";
export const sdkPatchCount = 33;
export const sdkPackages = ["ai", "tui", "codemode", "coding-agent"];
export const sdkRuntimePackages = [...sdkPackages, "agent-core", "mcp", "schema", "telemetry"];
export const sdkFiles = ["coding-agent/docs/codemode.md"];
export const sdkPackageDir = (root, name) => join(root, "node_modules", "@earendil-works", `pi-${name}`);
export const digest = value => createHash("sha256").update(value).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export async function readDistribution() {
  const data = JSON.parse(await readFile(new URL("./distribution.json", import.meta.url), "utf8"));
  if (data.schemaVersion !== 1 || data.piVersion !== sdkVersion || data.upstreamCommit !== sdkUpstreamCommit || !hex(data.patchSet)
    || !Array.isArray(data.patches) || data.patches.length !== sdkPatchCount
    || data.patches.some(patch => typeof patch.file !== "string" || !hex(patch.sha256))
    || !hex(data.archive?.sha256) || !Number.isSafeInteger(data.archive?.bytes) || data.archive.bytes <= 0
    || !Number.isSafeInteger(data.archive?.unpackedBytes) || data.archive.unpackedBytes <= 0
    || data.archive.file !== `pi-${sdkVersion}.tgz`) throw new Error("Invalid Metis Pi SDK distribution manifest");
  return data;
}

export async function verifiedArchive(distribution) {
  const path = fileURLToPath(new URL(`../../assets/pi-sdk/${distribution.archive.file}`, import.meta.url));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== distribution.archive.bytes)
    throw new Error("Metis Pi SDK archive size/type mismatch");
  if (digest(await readFile(path)) !== distribution.archive.sha256) throw new Error("Metis Pi SDK archive checksum mismatch");
  return path;
}

/** Replace the extracted SDK payload in a prepared package tree. The caller owns validation and activation. */
export async function replaceSdkPayload(root, payload) {
  for (const name of sdkPackages) {
    const target = join(sdkPackageDir(root, name), "dist");
    await rm(target, { recursive: true, force: true });
    await cp(join(payload, name, "dist"), target, { recursive: true });
  }
  for (const file of sdkFiles) {
    const [name, ...parts] = file.split("/");
    const target = join(sdkPackageDir(root, name), ...parts);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(payload, file), target);
  }
}
