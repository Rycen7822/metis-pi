import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const priceRefreshMarker = (agentDir) => join(agentDir, "cache", "metis-model-prices.refresh");

/** Request a refresh without downloading catalogs or loading the SDK during package installation. */
export async function requestPriceRefresh(agentDir) {
  const file = priceRefreshMarker(agentDir), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, randomUUID(), { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configured
    ? configured.replace(/^~(?=$|[\\/])/, () => homedir())
    : join(homedir(), ".pi", "agent");
  await requestPriceRefresh(agentDir);
  console.log("Metis model prices marked for refresh on next use.");
}
