#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const action = process.argv[2];
if (!["build", "check", "fresh"].includes(action)) {
  throw new Error("Usage: node scripts/vendor-condense.mjs <build|check|fresh>");
}
const root = new URL("../", import.meta.url);
const scratch = action === "fresh" ? mkdtempSync(join(tmpdir(), "metis-condense-build-")) : undefined;
try {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)),
    "-p", "vendor/pi-condense/tsconfig.json",
    ...(action === "check" ? ["--noEmit"] : []),
    ...(scratch ? ["--outDir", scratch] : []),
  ], { cwd: fileURLToPath(root), stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0 && scratch) {
    const shipped = fileURLToPath(new URL("vendor/pi-condense/dist/", root));
    const list = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name))).sort();
    const expected = list(scratch);
    if (JSON.stringify(expected) !== JSON.stringify(list(shipped))) throw new Error("condense dist file list is stale; run npm run vendor:build");
    for (const name of expected) {
      if (!readFileSync(join(scratch, name)).equals(readFileSync(join(shipped, name)))) {
        throw new Error(`condense dist/${name} is stale; run npm run vendor:build`);
      }
    }
    console.log("condense build matches shipped output");
  }
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
