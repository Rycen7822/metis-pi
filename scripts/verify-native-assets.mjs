import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash, hash } from "./lib/native-assets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const platform of ["linux", "win32"]) {
  for (const directory of ["assets/native-tools", "src/neural-search/assets"]) {
    const path = `${directory}/${platform}-x64-manifest.json`;
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    assert.equal(hash(JSON.stringify(manifest.source.inputs)), manifest.source.sha256, `${path}: source digest`);
    const records = [...manifest.source.inputs, ...(manifest.assets ?? [manifest.asset]), ...(manifest.notices ?? [])];
    for (const record of records) {
      const file = join(root, record.path);
      assert.equal(fileHash(file), record.sha256, `${record.path}: source or payload changed; rebuild its asset`);
      if (record.bytes !== undefined) assert.equal(statSync(file).size, record.bytes, `${record.path}: byte count`);
    }
  }
}
// Platform builders additionally own complete input collection and ABI policy.
if (process.arch !== "x64" || !["linux", "win32"].includes(process.platform))
  throw new Error("Native ABI verification requires Linux x64 or Windows x64.");
for (const directory of ["native/tools", "src/neural-search/engine"]) {
  const result = spawnSync(process.execPath, [`${directory}/build-${process.platform}-x64.mjs`, "verify"], {
    cwd: root, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Linux and Windows native source manifests, payload bytes and host ABI verified.");
