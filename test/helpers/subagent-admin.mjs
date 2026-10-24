// Private IPC and lease observations for disposable lifecycle fixtures.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getPythonCommand } from "../../src/subagents/host/python.ts";

const work = fileURLToPath(new URL("../../.work/", import.meta.url));
function assertFixtureState(state) {
  const path = relative(work, resolve(state));
  assert.ok(path && !path.startsWith(`..${sep}`) && path !== "..", "administer disposable fixture state only");
}

export function subagentAdmin(runtime, state, operation, params = {}) {
  assertFixtureState(state);
  assert.ok(["ping", "shutdown"].includes(operation));
  const reply = JSON.parse(execFileSync(getPythonCommand(), ["-c", `import asyncio,json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from metis_subagent.client import request
from metis_subagent.common import AgentError
try: result={"result":asyncio.run(request(Path(sys.argv[2]),sys.argv[3],json.loads(sys.argv[4]),autostart=False))}
except AgentError as error: result={"error":error.as_dict()}
print(json.dumps(result))
`, runtime.root, state, operation, JSON.stringify(params)], { encoding: "utf8", timeout: 20000, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } }));
  if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
  return reply.result;
}

export function waitForDaemonExit(runtime, state, timeout = 20000) {
  assertFixtureState(state);
  execFileSync(getPythonCommand(), ["-c", `import sys,time
sys.path.insert(0,sys.argv[1])
from metis_subagent.locks import try_lock
with open(sys.argv[2], "rb") as lock:
    until=time.monotonic()+float(sys.argv[3])
    while not try_lock(lock.fileno()):
        if time.monotonic()>=until: raise TimeoutError("Daemon shutdown did not release its lease")
        time.sleep(.025)
`, runtime.root, join(state, "daemon.lock"), String(timeout / 1000)],
    { timeout: timeout + 2000, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
}
