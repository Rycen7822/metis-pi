// Loaded by `npm test` before the runner spawns test files. Tests write and prune the
// fetched-content cache, so a cache root exported in the shell must never reach them.
delete process.env.PI_WEB_ACCESS_CACHE_ROOT;
// Gemini fixtures supply their own endpoints; inherited gateways bypass those mocks.
delete process.env.GOOGLE_GEMINI_BASE_URL;
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-access-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({ toolActivation: "eager" }));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
