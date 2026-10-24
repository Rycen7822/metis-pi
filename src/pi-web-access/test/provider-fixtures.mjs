import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stringify } from "smol-toml";
import { splitWebAccessConfig } from "../../configuration/web-access.ts";
import { clearProviderEnvironment } from "./provider-env.mjs";
import { RESOLVED_SEARCH_PROVIDERS } from "../search-providers.ts";

export function availabilityFor(only) {
  return { all: false, ...Object.fromEntries(RESOLVED_SEARCH_PROVIDERS.map(provider => [provider, provider === only])) };
}

export async function createHome(prefix, config = {}, agentPath = "") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const directory = join(home, agentPath);
  await mkdir(directory, { recursive: true });
  const { preferences, credentials } = splitWebAccessConfig(config);
  await writeFile(join(directory, "metis-pi.toml"), stringify({ webAccess: preferences }) + "\n", "utf8");
  await writeFile(join(directory, "web-search.json"), JSON.stringify(credentials) + "\n", "utf8");
  return home;
}

export function nodeCommand(script, ...args) {
  return [process.execPath, script, ...args].map(value => JSON.stringify(value.replaceAll("\\", "/"))).join(" ");
}

export async function writeCredentialCommand(directory, name, source) {
  const script = join(directory, `${name}.mjs`);
  await writeFile(script, source, "utf8");
  return `!${nodeCommand(script)}`;
}

export function markerCredentialCommand(marker, credential) {
  return writeCredentialCommand(dirname(marker), `${basename(marker)}-command`, `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "");
    process.stdout.write(${JSON.stringify(credential)});
  `);
}

export function runChild(script, env = {}, { timeout, maxBuffer = 2 * 1024 * 1024, execArgv = [] } = {}) {
  const environment = { ...process.env };
  clearProviderEnvironment(environment);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return spawnSync(process.execPath, [...execArgv, "--input-type=module"], {
    input: script, encoding: "utf8", env: environment, maxBuffer, timeout, windowsHide: true,
  });
}
