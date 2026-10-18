import type { FileFinderApi, InitOptions, Result } from "@ff-labs/fff-node";

export const SCAN_TIMEOUT_MS = 15_000;
export type FileFinderStatic = { create(options: InitOptions): Result<FileFinderApi> };
type Sdk = { FileFinder: FileFinderStatic };
const sdkPromises = new Map<string, Promise<Sdk>>();

export function sdkCandidates(followSymlinks: boolean): readonly string[] {
  const bun = process.versions.bun || typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  // Published fff-bun 0.11 uses ABI v1 and silently ignores followSymlinks.
  if (bun && followSymlinks) return ["@ff-labs/fff-node"];
  return bun ? ["@ff-labs/fff-bun", "@ff-labs/fff-node"] : ["@ff-labs/fff-node"];
}

export function loadSdk(followSymlinks: boolean): Promise<Sdk> {
  const candidates = sdkCandidates(followSymlinks);
  const key = candidates.join(",");
  let pending = sdkPromises.get(key);
  if (!pending) {
    pending = loadFirst(candidates).catch(error => { sdkPromises.delete(key); throw error; });
    sdkPromises.set(key, pending);
  }
  return pending;
}

async function loadFirst(candidates: readonly string[]): Promise<Sdk> {
  const errors: string[] = [];
  for (const name of candidates) {
    try {
      const sdk = name === "@ff-labs/fff-bun" ? await import("@ff-labs/fff-bun") : await import("@ff-labs/fff-node");
      if (typeof sdk.FileFinder?.create !== "function") throw new Error("Missing FileFinder.create");
      return sdk;
    } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  throw new Error(`Neural search could not load a native FFF binding. ${errors.join("; ")}`);
}
