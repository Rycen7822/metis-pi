// Finder lifetime is session-owned; library modules remain process-cached.
import { ffiCreate, ffiDestroy, ffiGetScanProgress, ffiGrep, ffiHealthCheck, ffiIsScanning, ffiMultiGrep, ffiScanFiles, ffiSearch, ffiSearchMixed, type NativeHandle } from "./ffi.ts";
import type { FileFinderApi, GrepOptions, GrepResult, HealthCheck, InitOptions, MixedSearchResult, MultiGrepOptions, Result, ScanProgress, SearchOptions, SearchResult } from "./api.ts";
import { err } from "./api.ts";

export class FileFinder implements FileFinderApi {
  private constructor(private handle: NativeHandle | null) {}
  static create(options: InitOptions): Result<FileFinder> {
    const result = ffiCreate(options);
    return result.ok ? { ok: true, value: new FileFinder(result.value) } : result;
  }
  destroy(): void {
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) ffiDestroy(handle);
  }
  get isDestroyed(): boolean { return this.handle === null; }
  private alive(): Result<NativeHandle> {
    return this.handle === null ? err("FileFinder instance has been destroyed.") : { ok: true, value: this.handle };
  }
  fileSearch(query: string, options?: SearchOptions): Result<SearchResult> {
    const guard = this.alive();
    return guard.ok ? ffiSearch(guard.value, query, options?.offset ?? 0, options?.pageSize ?? 0) : guard;
  }
  mixedSearch(query: string, options?: SearchOptions): Result<MixedSearchResult> {
    const guard = this.alive();
    return guard.ok ? ffiSearchMixed(guard.value, query, options?.pageSize ?? 0) : guard;
  }
  grep(pattern: string, options?: GrepOptions): Result<GrepResult> {
    const guard = this.alive();
    return guard.ok ? ffiGrep(guard.value, pattern, options) : guard;
  }
  multiGrep(options: MultiGrepOptions): Result<GrepResult> {
    const guard = this.alive();
    if (!guard.ok) return guard;
    if (!options.patterns?.length) return err("patterns array must have at least 1 element");
    return ffiMultiGrep(guard.value, options);
  }
  scanFiles(): Result<void> {
    const guard = this.alive();
    return guard.ok ? ffiScanFiles(guard.value) : guard;
  }
  isScanning(): boolean { return this.handle !== null && ffiIsScanning(this.handle); }
  getScanProgress(): Result<ScanProgress> {
    const guard = this.alive();
    return guard.ok ? ffiGetScanProgress(guard.value) : guard;
  }
  async waitForScan(timeoutMs = 5000): Promise<Result<boolean>> {
    const guard = this.alive();
    if (!guard.ok) return guard;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const progress = this.getScanProgress();
      if (!progress.ok) return progress;
      if (!progress.value.isScanning && progress.value.scanError) return err(progress.value.scanError);
      if (progress.value.isReady) return { ok: true, value: true };
      if (Date.now() >= deadline) return { ok: true, value: false };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  healthCheck(testPath = ""): Result<HealthCheck> {
    const guard = this.alive();
    return guard.ok ? ffiHealthCheck(guard.value, testPath) : guard;
  }
}
