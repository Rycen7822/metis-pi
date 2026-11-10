import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const sdkVersion = "1.5.2";
export const sdkUpstreamCommit = "b4afdddf44e059c67ccf5097e5317d913521b470";
export const sdkPatchCount = 8;
export const sdkPackages = ["ai", "tui", "codemode", "coding-agent"];
export const sdkFiles = ["coding-agent/docs/codemode.md"];
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
