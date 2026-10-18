import type { FileFinderApi, InitOptions, Result } from "@ff-labs/fff-node";
import { loadSdk, SCAN_TIMEOUT_MS, type FileFinderStatic } from "./sdk.ts";

type PickerOptions = Required<Pick<InitOptions, "enableHomeDirScanning" | "enableFsRootScanning" | "followSymlinks" | "frecencyDbPath" | "historyDbPath">>;

export class FilePickerFactory {
  private dbDisabled = false;
  constructor(private readonly options: PickerOptions & { onDbFailure?: (error: string) => void }) {}

  get databasesDisabled(): boolean { return this.dbDisabled; }

  async create(basePath: string, signal?: AbortSignal, persistent = true): Promise<FileFinderApi> {
    signal?.throwIfAborted();
    const { FileFinder } = await loadSdk(this.options.followSymlinks);
    signal?.throwIfAborted();
    const result = this.open(FileFinder, basePath, persistent);
    if (!result.ok) throw new Error(`Failed to create neural-search index for ${basePath}: ${result.error}`);
    const finder = result.value;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          if (!finder.isDestroyed) finder.destroy();
          reject(new Error("Neural-search lifecycle ended during index creation."));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      // A false readiness result is a timeout, not an incomplete-index error.
      const scanned = await Promise.race([finder.waitForScan(SCAN_TIMEOUT_MS), aborted]);
      signal?.throwIfAborted();
      if (!scanned.ok) throw new Error(scanned.error);
      return finder;
    } catch (error) {
      if (!finder.isDestroyed) finder.destroy();
      throw error;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  private open(FileFinder: FileFinderStatic, basePath: string, persistent: boolean): Result<FileFinderApi> {
    // Explicit fields keep database paths out of auxiliary and fallback indexes.
    const { enableHomeDirScanning, enableFsRootScanning, followSymlinks } = this.options;
    // FFF 0.11's content-index prefilter drops valid multiGrep OR candidates.
    const init = { basePath, enableHomeDirScanning, enableFsRootScanning, followSymlinks,
      aiMode: true, disableContentIndexing: true };
    if (!persistent || this.dbDisabled) return FileFinder.create(init);
    const result = FileFinder.create({ ...init,
      frecencyDbPath: this.options.frecencyDbPath, historyDbPath: this.options.historyDbPath,
    });
    if (result.ok) return result;
    const dbLess = FileFinder.create(init);
    if (!dbLess.ok) return result;
    this.dbDisabled = true;
    try { this.options.onDbFailure?.(result.error); }
    catch { /* Notification failures must not leak a successfully opened picker. */ }
    return dbLess;
  }
}
