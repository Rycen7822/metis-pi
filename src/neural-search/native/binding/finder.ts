// Metis finder lifetime and operations; derived from FFF 0.11.0 (MIT).
import { ffiCreate, ffiDestroy, ffiGetScanProgress, ffiHealthCheck, ffiIsScanning, ffiLiveGrep, ffiMultiGrep, ffiScanFiles, ffiSearch, ffiSearchMixed, type NativeHandle } from "./ffi.ts";
import type { FileFinderApi, GrepOptions, GrepResult, HealthCheck, InitOptions, MixedSearchResult, MultiGrepOptions, Result, ScanProgress, SearchOptions, SearchResult } from "./api.ts";
import { err } from "./api.ts";

export class FileFinder implements FileFinderApi {
  private constructor(private handle: NativeHandle | null) {}

  static create(options: InitOptions): Result<FileFinder> {
    const result = ffiCreate(options);
    return result.ok ? { ok: true, value: new FileFinder(result.value) } : result;
  }

  destroy(): void {
    if (this.handle !== null) {
      ffiDestroy(this.handle);
      this.handle = null;
    }
  }

  get isDestroyed(): boolean { return this.handle === null; }

  private ensureAlive(): Result<NativeHandle> {
    return this.handle === null ? err("FileFinder instance has been destroyed.") : { ok: true, value: this.handle };
  }

  fileSearch(query: string, options?: SearchOptions): Result<SearchResult> {
    const guard = this.ensureAlive();
    if (!guard.ok) return guard;
    return ffiSearch(guard.value, query, options?.currentFile ?? "", options?.maxThreads ?? 0,
      options?.pageIndex ?? 0, options?.pageSize ?? 0, options?.comboBoostMultiplier ?? 0, options?.minComboCount ?? 0);
  }

  mixedSearch(query: string, options?: SearchOptions): Result<MixedSearchResult> {
    const guard = this.ensureAlive();
    if (!guard.ok) return guard;
    return ffiSearchMixed(guard.value, query, options?.currentFile ?? "", options?.maxThreads ?? 0,
      options?.pageIndex ?? 0, options?.pageSize ?? 0, options?.comboBoostMultiplier ?? 0, options?.minComboCount ?? 0);
  }

  grep(query: string, options?: GrepOptions): Result<GrepResult> {
    const guard = this.ensureAlive();
    if (!guard.ok) return guard;
    return ffiLiveGrep(guard.value, query, options?.mode ?? "plain", options?.maxFileSize ?? 0,
      options?.maxMatchesPerFile ?? 0, options?.smartCase ?? true, options?.cursor?._offset ?? 0,
      options?.pageSize ?? 0, options?.timeBudgetMs ?? 0, options?.enforceTimeBudget ?? false,
      options?.beforeContext ?? 0, options?.afterContext ?? 0, options?.classifyDefinitions ?? false);
  }

  multiGrep(options: MultiGrepOptions): Result<GrepResult> {
    const guard = this.ensureAlive();
    if (!guard.ok) return guard;
    if (!options.patterns || !options.patterns.length) return err("patterns array must have at least 1 element");
    return ffiMultiGrep(guard.value, options.patterns.join("\n"), options.constraints ?? "", options.maxFileSize ?? 0,
      options.maxMatchesPerFile ?? 0, options.smartCase ?? true, options.cursor?._offset ?? 0,
      options.pageSize ?? 0, options.timeBudgetMs ?? 0, options.enforceTimeBudget ?? false,
      options.beforeContext ?? 0, options.afterContext ?? 0, options.classifyDefinitions ?? false);
  }

  scanFiles(): Result<void> {
    const guard = this.ensureAlive();
    return guard.ok ? ffiScanFiles(guard.value) : guard;
  }

  isScanning(): boolean { return this.handle !== null && ffiIsScanning(this.handle); }

  getScanProgress(): Result<ScanProgress> {
    const guard = this.ensureAlive();
    return guard.ok ? ffiGetScanProgress(guard.value) : guard;
  }

  async waitForScan(timeoutMs = 5000): Promise<Result<boolean>> {
    const guard = this.ensureAlive();
    if (!guard.ok) return guard;
    const deadline = Date.now() + timeoutMs;
    while (this.isScanning()) {
      if (Date.now() >= deadline) return { ok: true, value: false };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { ok: true, value: true };
  }

  healthCheck(testPath?: string): Result<HealthCheck> {
    return ffiHealthCheck(this.handle, testPath || "") as Result<HealthCheck>;
  }
}
