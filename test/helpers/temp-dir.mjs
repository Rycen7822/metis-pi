import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workbench = fileURLToPath(new URL("../../.work/", import.meta.url));

// Use for fixtures that belong in the checkout; the caller controls cleanup order.
export function createWorkDirectory(prefix) {
  mkdirSync(workbench, { recursive: true });
  return mkdtempSync(join(workbench, prefix));
}

export function temporaryDirectory(t, prefix = "metis-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
