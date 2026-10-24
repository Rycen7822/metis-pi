import { spawnSync } from "node:child_process";
import { getPythonCommand } from "../src/subagents/host/python.ts";

const result = spawnSync(getPythonCommand(), process.argv.slice(2), {
  stdio: "inherit", env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
