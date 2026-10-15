import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterAll } from "vitest";
const home = mkdtempSync(join(tmpdir(), "metis-questions-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
beforeEach(() => {
  rmSync(join(process.env.PI_CODING_AGENT_DIR!, "metis-pi.toml"), { force: true });
  rmSync(join(home, ".config"), { recursive: true, force: true });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));
