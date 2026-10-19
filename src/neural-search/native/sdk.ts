import type { FileFinderApi, InitOptions, Result } from "./binding/api.ts";

export const SCAN_TIMEOUT_MS = 15_000;
export type FileFinderStatic = { create(options: InitOptions): Result<FileFinderApi> };
type Sdk = { FileFinder: FileFinderStatic };
// Reload must not re-import native modules in a compiled Bun host. Cache the
// binding, never live finders; a new engine ABI requires a new cache version.
const sdkGlobal = globalThis as typeof globalThis & {
  __metisNeuralSearchSdkPromisesV6?: Map<string, Promise<Sdk>>;
};
const sdkPromises = sdkGlobal.__metisNeuralSearchSdkPromisesV6 ??= new Map<string, Promise<Sdk>>();

export function loadSdk(): Promise<Sdk> {
  if (process.platform !== "linux" || process.arch !== "x64")
    return Promise.reject(new Error("Metis Neural Search requires Linux x64 (glibc)."));
  const key = import.meta.url;
  let pending = sdkPromises.get(key);
  if (!pending) {
    pending = import("./binding/finder.ts").catch(error => {
      sdkPromises.delete(key);
      throw new Error(`Neural Search could not load its Linux binding: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    sdkPromises.set(key, pending);
  }
  return pending;
}
