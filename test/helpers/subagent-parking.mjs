import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SubagentClient } from "../../src/subagents/host/client.ts";
import { runtimePackage } from "../../src/subagents/host/runtime-package.ts";
import { subagentAdmin } from "./subagent-admin.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function status(runtime, state) {
  try {
    return subagentAdmin(runtime, state, "ping");
  } catch (error) {
    assert.equal(error.code, "daemon_unavailable");
    return undefined;
  }
}
export async function fixture(t) {
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work/metis-subagent-parking-")),
    state = join(dir, "metis", "subagent"),
    runtime = runtimePackage();
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ extensions: [join(root, "test/subagents/pi_mock_provider.ts")] }),
  );
  writeFileSync(
    join(dir, "metis-pi.toml"),
    '[subagents.profiles.reader.env]\nPI_OFFLINE="1"\nPI_MOCK_STREAM_MS="30"\n',
  );
  const ctx = {
    cwd: dir,
    model: { provider: "pi-mock-offline", id: "mock" },
    sessionManager: SessionManager.create(dir, dir),
    isProjectTrusted: () => true,
  };
  const client = new SubagentClient(runtime, ctx, dir, undefined, () => {}),
    clients = [client];
  t.after(async () => {
    try {
      for (const client of clients) await client.close();
      if (status(runtime, state))
        subagentAdmin(runtime, state, "shutdown", { force: true });
      if (clients.some((client) => client.scope))
        execFileSync(
          "python3",
          [
            "-c",
            "import fcntl,sys; f=open(sys.argv[1],'rb'); fcntl.flock(f,fcntl.LOCK_EX)",
            join(state, "daemon.lock"),
          ],
          { timeout: 20000 },
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return { dir, state, runtime, client, clients, ctx };
}
