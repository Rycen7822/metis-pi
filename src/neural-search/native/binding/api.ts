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
export interface SearchOptions { pageIndex?: number; pageSize?: number; }
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
}
export interface DbHealth { path: string; diskSize: number; }
export interface HealthCheck {
  version: string;
  git: { available: boolean; repositoryFound: boolean; workdir?: string; libgit2Version: string; error?: string };
  filePicker: { initialized: boolean; basePath?: string; isScanning?: boolean; indexedFiles?: number; error?: string };
  frecency: { initialized: boolean; dbHealthcheck?: DbHealth; error?: string };
  queryTracker: { initialized: boolean; dbHealthcheck?: DbHealth; error?: string };
}

export type GrepMode = "plain" | "regex" | "fuzzy";
/** File offset into the native ordered candidate set, distinct from a JS row cursor. */
export interface GrepCursor { readonly _offset: number; }
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
  items: GrepMatch[];
  totalMatched: number;
  totalFilesSearched: number;
  totalFiles: number;
  filteredFileCount: number;
  nextCursor: GrepCursor | null;
  regexFallbackError?: string;
}
export interface FileFinderApi {
  readonly isDestroyed: boolean;
  destroy(): void;
  fileSearch(query: string, options?: SearchOptions): Result<SearchResult>;
  mixedSearch(query: string, options?: SearchOptions): Result<MixedSearchResult>;
  grep(pattern: string, options?: GrepOptions): Result<GrepResult>;
  multiGrep(options: MultiGrepOptions): Result<GrepResult>;
  scanFiles(): Result<void>;
  isScanning(): boolean;
  getScanProgress(): Result<ScanProgress>;
  waitForScan(timeoutMs?: number): Promise<Result<boolean>>;
  healthCheck(testPath?: string): Result<HealthCheck>;
}
