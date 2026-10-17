// Fixture-only private IPC replacing the retired task CLI in lifecycle tests.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const work = fileURLToPath(new URL("../../.work/", import.meta.url));
export function subagentAdmin(runtime, state, operation, params = {}) {
  const path = relative(work, resolve(state));
  assert.ok(path && !path.startsWith(`..${sep}`) && path !== "..", "administer disposable fixture state only");
  assert.ok(["ping", "shutdown"].includes(operation));
  const reply = JSON.parse(execFileSync("python3", ["-c", `import asyncio,json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from metis_subagent.client import request
from metis_subagent.common import AgentError
try: result={"result":asyncio.run(request(Path(sys.argv[2]),sys.argv[3],json.loads(sys.argv[4]),autostart=False))}
except AgentError as error: result={"error":error.as_dict()}
print(json.dumps(result))
`, runtime.root, state, operation, JSON.stringify(params)], { encoding: "utf8", timeout: 20000 }));
  if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
  return reply.result;
}
