import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { splitWebAccessConfig } from "../../configuration/web-access.ts";
import { clearProviderEnvironment } from "./provider-env.mjs";

export async function createHome(prefix, config = {}, agentPath = "") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const directory = join(home, agentPath);
  await mkdir(directory, { recursive: true });
  const { preferences, credentials } = splitWebAccessConfig(config);
  await writeFile(join(directory, "metis-pi.toml"), stringify({ webAccess: preferences }) + "\n", "utf8");
  await writeFile(join(directory, "web-search.json"), JSON.stringify(credentials) + "\n", "utf8");
  return home;
}

export function runChild(script, env = {}, { timeout, maxBuffer = 2 * 1024 * 1024, execArgv = [] } = {}) {
  const environment = { ...process.env };
  clearProviderEnvironment(environment);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return spawnSync(process.execPath, [...execArgv, "--input-type=module"], {
    input: script, encoding: "utf8", env: environment, maxBuffer, timeout,
  });
}
