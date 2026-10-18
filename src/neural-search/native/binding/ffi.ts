// Metis private Linux x64 ABI v3. Rust owns each envelope and its payload;
// decode into detached JS values before freeing the envelope in finally.
import { DataType, type FieldType, isNullPointer, type JsExternal, load, open, restorePointer, wrapPointer } from "ffi-rs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { err, type FileItem, type GrepOptions, type GrepResult, type HealthCheck, type InitOptions, type MixedItem, type MixedSearchResult, type MultiGrepOptions, type Result, type ScanProgress, type SearchResult } from "./api.ts";

const LIBRARY_KEY = "metis_neural_search_v3";
const ABI_VERSION = 3;
const CREATE = {
  version: DataType.U32, base_path: DataType.String, frecency_db_path: DataType.String, history_db_path: DataType.String,
  enable_fs_root_scanning: DataType.U8, enable_home_dir_scanning: DataType.U8, follow_symlinks: DataType.U8,
};
// This is only the borrowed 32-byte prefix; the native envelope also contains
// a private Rust payload owner, never read or freed through JS/libc.
const ENVELOPE = { success: DataType.U8, error: DataType.External, handle: DataType.External, int_value: DataType.I64 } as const;
const FILE = { relative_path: DataType.External, git_status: DataType.External, total_frecency_score: DataType.I64 } as const;
const FILES = { items: DataType.External, count: DataType.U32, total_matched: DataType.U32, total_files: DataType.U32, top_score: DataType.I32 } as const;
const MIXED_ITEM = { relative_path: DataType.External, display_name: DataType.External, item_type: DataType.U8 } as const;
const MIXED = { items: DataType.External, count: DataType.U32 } as const;
const MATCH = {
  relative_path: DataType.External, git_status: DataType.External, line_content: DataType.External,
  context_before: DataType.External, context_after: DataType.External, line_number: DataType.U64,
  total_frecency_score: DataType.I64, context_before_count: DataType.U32, context_after_count: DataType.U32,
} as const;
const GREP = {
  items: DataType.External, count: DataType.U32, total_files_searched: DataType.U32, total_files: DataType.U32,
  filtered_file_count: DataType.U32, next_file_offset: DataType.U32, regex_fallback_error: DataType.External,
} as const;
const PROGRESS = { scanned_files_count: DataType.U64, is_scanning: DataType.U8, is_watcher_ready: DataType.U8, is_ready: DataType.U8 } as const;
type Raw<S> = { [K in keyof S]: S[K] extends DataType.External ? JsExternal : number };
export type NativeHandle = JsExternal;
let loaded = false;

function invoke(name: string, paramsType: FieldType[], paramsValue: unknown[], retType: FieldType = DataType.External): unknown {
  return load({ library: LIBRARY_KEY, funcName: `metis_search_${name}`, retType, paramsType, paramsValue, freeResultMemory: false });
}
function loadLibrary(): void {
  if (loaded) return;
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Metis Neural Search requires Linux x64 (glibc).");
  const path = fileURLToPath(new URL("../../../../assets/neural-search/linux-x64/libmetis_neural_search.so", import.meta.url));
  if (!existsSync(path)) throw new Error("Metis Neural Search library is missing; reinstall the complete Metis package.");
  open({ library: LIBRARY_KEY, path });
  if (invoke("abi_version", [], [], DataType.U32) !== ABI_VERSION)
    throw new Error("Neural Search ABI mismatch; reinstall the complete Metis package and restart Pi.");
  loaded = true;
}
function readStruct<S extends Record<string, DataType>>(pointer: NativeHandle, shape: S): Raw<S> {
  if (isNullPointer(pointer)) throw new Error("Neural Search returned a null payload.");
  return restorePointer({ retType: [shape], paramsValue: wrapPointer([pointer]) })[0] as Raw<S>;
}
function readString(pointer: NativeHandle): string {
  if (isNullPointer(pointer)) return "";
  return restorePointer({ retType: [DataType.String], paramsValue: wrapPointer([pointer]) })[0] as string;
}
function result<T>(name: string, types: FieldType[], values: unknown[], decode: (view: Raw<typeof ENVELOPE>, address: NativeHandle) => T): Result<T> {
  if (values.some(value => typeof value === "string" && value.includes("\0"))) return err("NUL is not supported in native search input.");
  loadLibrary();
  const address = invoke(name, types, values) as NativeHandle;
  try {
    const view = readStruct(address, ENVELOPE);
    return view.success ? { ok: true, value: decode(view, address) } : err(readString(view.error) || "Native search failed.");
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  } finally {
    // Rust can release the payload even if reading the envelope itself failed.
    invoke("free_result", [DataType.External], [address], DataType.Void);
  }
}
function element<S extends Record<string, DataType>>(name: string, owner: NativeHandle, index: number, shape: S): Raw<S> {
  return readStruct(invoke(name, [DataType.External, DataType.U32], [owner, index]) as NativeHandle, shape);
}
function strings(address: NativeHandle, count: number): string[] {
  const values: string[] = [];
  for (let index = 0; index < count; index++) {
    const slot = invoke("pointer_offset", [DataType.External, DataType.U64], [address, index * 8]) as NativeHandle;
    const pointer = restorePointer({ retType: [DataType.External], paramsValue: [slot] })[0] as NativeHandle;
    values.push(readString(pointer));
  }
  return values;
}
function file(raw: Raw<typeof FILE>): FileItem {
  return { relativePath: readString(raw.relative_path), gitStatus: readString(raw.git_status), totalFrecencyScore: Number(raw.total_frecency_score) };
}

export function ffiCreate(options: InitOptions): Result<NativeHandle> {
  if (Object.values(options).some(value => typeof value === "string" && value.includes("\0"))) return err("NUL is not supported in an index path.");
  return result("create", [CREATE], [{ version: ABI_VERSION, base_path: options.basePath,
    frecency_db_path: options.frecencyDbPath ?? "", history_db_path: options.historyDbPath ?? "",
    enable_fs_root_scanning: options.enableFsRootScanning ? 1 : 0,
    enable_home_dir_scanning: options.enableHomeDirScanning ? 1 : 0, follow_symlinks: options.followSymlinks ? 1 : 0,
  }], (_view, owner) => {
    const handle = invoke("take_instance", [DataType.External], [owner]) as NativeHandle;
    if (isNullPointer(handle)) throw new Error("Native index creation returned a null handle.");
    return handle;
  });
}
export function ffiDestroy(handle: NativeHandle): void { invoke("destroy", [DataType.External], [handle], DataType.Void); }
export function ffiSearch(handle: NativeHandle, query: string, pageIndex: number, pageSize: number): Result<SearchResult> {
  return result("files", [DataType.External, DataType.String, DataType.U32, DataType.U32], [handle, query, pageIndex, pageSize], view => {
    const raw = readStruct(view.handle, FILES);
    const items: FileItem[] = [];
    for (let index = 0; index < raw.count; index++) items.push(file(element("get_file", view.handle, index, FILE)));
    return { items, totalMatched: raw.total_matched, totalFiles: raw.total_files, topScore: raw.top_score };
  });
}
export function ffiSearchMixed(handle: NativeHandle, query: string, pageSize: number): Result<MixedSearchResult> {
  return result("mixed", [DataType.External, DataType.String, DataType.U32], [handle, query, pageSize], view => {
    const raw = readStruct(view.handle, MIXED);
    const items: MixedItem[] = [];
    for (let index = 0; index < raw.count; index++) {
      const entry = element("get_mixed", view.handle, index, MIXED_ITEM);
      const relativePath = readString(entry.relative_path), name = readString(entry.display_name);
      items.push(entry.item_type === 1 ? { type: "directory", item: { relativePath, dirName: name } }
        : { type: "file", item: { relativePath, fileName: name } });
    }
    return { items };
  });
}

export function ffiGrep(handle: NativeHandle, pattern: string, options: GrepOptions = {}): Result<GrepResult> {
  return grep("grep", handle, pattern, options, options.mode === "regex" ? 1 : options.mode === "fuzzy" ? 2 : 0);
}
export function ffiMultiGrep(handle: NativeHandle, options: MultiGrepOptions): Result<GrepResult> {
  return grep("multi_grep", handle, options.patterns.join("\n"), options);
}
function grep(name: "grep" | "multi_grep", handle: NativeHandle, pattern: string, options: GrepOptions, mode?: number): Result<GrepResult> {
  const types: FieldType[] = [DataType.External, DataType.String, DataType.String];
  const values: unknown[] = [handle, pattern, options.constraints ?? ""];
  if (mode !== undefined) { types.push(DataType.U8); values.push(mode); }
  types.push(DataType.U64, DataType.U32, DataType.U8, DataType.U32, DataType.U32, DataType.U64, DataType.U8, DataType.U32, DataType.U32);
  values.push(options.maxFileSize ?? 0, options.maxMatchesPerFile ?? 0, options.smartCase === false ? 0 : 1,
    options.cursor?._offset ?? 0, options.pageSize ?? 0, options.timeBudgetMs ?? 0, options.enforceTimeBudget ? 1 : 0,
    options.beforeContext ?? 0, options.afterContext ?? 0);
  return result(name, types, values, view => {
    const raw = readStruct(view.handle, GREP);
    const items: GrepResult["items"] = [];
    for (let index = 0; index < raw.count; index++) {
      const entry = element("get_match", view.handle, index, MATCH);
      items.push({ relativePath: readString(entry.relative_path), gitStatus: readString(entry.git_status),
        totalFrecencyScore: Number(entry.total_frecency_score), lineNumber: Number(entry.line_number), lineContent: readString(entry.line_content),
        ...(entry.context_before_count ? { contextBefore: strings(entry.context_before, entry.context_before_count) } : {}),
        ...(entry.context_after_count ? { contextAfter: strings(entry.context_after, entry.context_after_count) } : {}),
      });
    }
    const regexFallbackError = readString(raw.regex_fallback_error);
    return { items, totalMatched: items.length, totalFiles: raw.total_files, totalFilesSearched: raw.total_files_searched,
      filteredFileCount: raw.filtered_file_count, nextCursor: raw.next_file_offset ? { _offset: raw.next_file_offset } : null,
      ...(regexFallbackError ? { regexFallbackError } : {}),
    };
  });
}
export function ffiScanFiles(handle: NativeHandle): Result<void> { return result("scan", [DataType.External], [handle], () => undefined); }
export function ffiIsScanning(handle: NativeHandle): boolean {
  const found = result("is_scanning", [DataType.External], [handle], view => Number(view.int_value) !== 0);
  return found.ok && found.value;
}
export function ffiGetScanProgress(handle: NativeHandle): Result<ScanProgress> {
  return result("progress", [DataType.External], [handle], view => {
    const raw = readStruct(view.handle, PROGRESS);
    return { scannedFilesCount: Number(raw.scanned_files_count), isScanning: !!raw.is_scanning, isWatcherReady: !!raw.is_watcher_ready, isReady: !!raw.is_ready };
  });
}
export function ffiHealthCheck(handle: NativeHandle, path: string): Result<HealthCheck> {
  return result("health", [DataType.External, DataType.String], [handle, path], view => JSON.parse(readString(view.handle)) as HealthCheck);
}
