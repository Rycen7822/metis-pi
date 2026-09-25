import { execFileSync } from "node:child_process";

const paths = ["vendor/pi-codex-conversion/dist", "vendor/pi-codex-conversion/changelog.js"];
const changes = execFileSync("git", [
  "status", "--porcelain=v1", "--untracked-files=all", "--", ...paths,
], { encoding: "utf8" });

if (changes.trim()) {
  process.stderr.write(`Vendor build outputs are not synchronized:\n${changes}`);
  process.exitCode = 1;
}
