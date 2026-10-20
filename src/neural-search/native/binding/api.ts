// Metis-owned search boundary, not a general-purpose engine SDK.
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export const err = (error: string): Result<never> => ({ ok: false, error });

export interface InitOptions {
  basePath: string;
  frecencyDbPath?: string;
  historyDbPath?: string;
  enableFsRootScanning?: boolean;
  enableHomeDirScanning?: boolean;
  followSymlinks?: boolean;
}
/** offset is a zero-based item offset, never a page number. */
export interface SearchOptions { offset?: number; pageSize?: number; }
export interface FileItem { relativePath: string; gitStatus: string; totalFrecencyScore: number; }
export interface SearchResult {
  items: FileItem[];
  totalMatched: number;
  totalFiles: number;
  /** Preserve the captured native page's top score while JS pages its snapshot. */
  topScore: number;
}
export type MixedItem =
  | { type: "file"; item: { relativePath: string; fileName: string } }
  | { type: "directory"; item: { relativePath: string; dirName: string } };
export interface MixedSearchResult { items: MixedItem[]; }
export interface ScanProgress {
  scannedFilesCount: number;
  isScanning: boolean;
  isWatcherReady: boolean;
  isReady: boolean;
  indexVersion: number;
  scanError?: string;
  gitStatusError?: string;
  watcherError?: string;
}
export interface DbHealth { path: string; diskSize: number; healthy: boolean; }
export interface HealthCheck {
  version: string;
  git: { available: boolean; repositoryFound: boolean; workdir?: string; libgit2Version: string; error?: string };
  filePicker: { initialized: boolean; basePath?: string; isScanning?: boolean; indexedFiles?: number; error?: string };
  frecency: { initialized: boolean; dbHealthcheck?: DbHealth; error?: string };
  queryTracker: { initialized: boolean; dbHealthcheck?: DbHealth; error?: string };
}

export type GrepMode = "plain" | "regex" | "fuzzy";
/** File offset and index identity captured by the same native read operation. */
export interface GrepCursor { readonly _offset: number; readonly _indexVersion: number; }
export interface GrepOptions {
  constraints?: string;
  mode?: GrepMode;
  maxFileSize?: number;
  maxMatchesPerFile?: number;
  smartCase?: boolean;
  cursor?: GrepCursor | null;
  pageSize?: number;
  timeBudgetMs?: number;
  /** Off by default: zero-match searches must inspect all candidate files. */
  enforceTimeBudget?: boolean;
  beforeContext?: number;
  afterContext?: number;
}
export interface MultiGrepOptions extends Omit<GrepOptions, "mode"> { patterns: string[]; }
export interface GrepMatch extends FileItem {
  lineNumber: number;
  lineContent: string;
  contextBefore?: string[];
  contextAfter?: string[];
}
export interface GrepResult {
  indexVersion: number;
  items: GrepMatch[];
  totalMatched: number;
  totalFilesSearched: number;
  totalFiles: number;
  filteredFileCount: number;
  nextCursor: GrepCursor | null;
  regexFallbackError?: string;
  nativeMultilineLimited: boolean;
  nativeOutputTruncated: boolean;
}
export interface FileFinderApi {
  readonly isDestroyed: boolean;
  destroy(): void;
  fileSearch(query: string, options?: SearchOptions): Result<SearchResult>;
  mixedSearch(query: string, options?: Pick<SearchOptions, "pageSize">): Result<MixedSearchResult>;
  grep(pattern: string, options?: GrepOptions): Result<GrepResult>;
  multiGrep(options: MultiGrepOptions): Result<GrepResult>;
  scanFiles(): Result<void>;
  getScanProgress(): Result<ScanProgress>;
  waitForScan(timeoutMs?: number): Promise<Result<boolean>>;
  healthCheck(testPath?: string): Result<HealthCheck>;
}
