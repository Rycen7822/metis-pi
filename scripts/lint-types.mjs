import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
// npm ci disables bin links, so Oxlint cannot discover the usual tsrs-lint shim.
const backend = process.platform === "win32" ? "scripts/tsrs-lint.cmd" : "node_modules/tsrs/bin/tsrs-lint";
const lint = spawnSync(process.execPath, [
  "node_modules/oxlint/bin/oxlint", "--config", ".oxlintrc.types.jsonc", "--type-aware",
  ...(process.argv.length > 2 ? process.argv.slice(2) : ["src", "extensions", "test/ask-user-question"]),
], {
  cwd: fileURLToPath(root),
  env: { ...process.env, OXLINT_TSGOLINT_PATH: fileURLToPath(new URL(backend, root)) },
  stdio: "inherit",
});
if (lint.error) console.error(lint.error);
process.exitCode = lint.status ?? 1;
