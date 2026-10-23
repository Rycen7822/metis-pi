import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const fileHash = path => hash(readFileSync(path));

// Both asset manifests record the same ordered, repo-relative source format.
export function sourceInputs(root, directory, include, extra = []) {
  const collect = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "target") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.isFile() && include(entry.name)
      ? [{ path: relative(root, path).split(sep).join("/"), sha256: fileHash(path) }] : [];
  });
  const inputs = collect(directory);
  for (const path of extra) inputs.push({ path, sha256: fileHash(join(root, path)) });
  return inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
