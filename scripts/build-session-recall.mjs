// Maintainer staging. No model download, production install or dependency on sgrep.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, chmodSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build Recall on Linux x64.");
const root = fileURLToPath(new URL("../", import.meta.url));
const dest = resolve(root, process.argv[2] ?? "src/pi-session-recall/assets/linux-x64");
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? ".work/session-recall-build");
execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", "src/pi-session-recall/native/Cargo.toml"], {
  cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target }, stdio: "inherit",
});
const bin = join(dest, "bin");
mkdirSync(bin, { recursive: true });
const executable = join(bin, "metis-session-recall");
const incoming = `${executable}.${process.pid}.tmp`;
try {
  copyFileSync(join(target, "release/metis-session-recall"), incoming);
  chmodSync(incoming, 0o755);
  if (execFileSync(incoming, ["--protocol"], { encoding: "utf8" }).trim() !== "1") {
    throw new Error("Unexpected Recall worker protocol.");
  }
  renameSync(incoming, executable);
} finally { rmSync(incoming, { force: true }); }
console.log(`Staged Recall worker: ${executable}`);
