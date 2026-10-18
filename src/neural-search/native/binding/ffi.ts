// Derived from FFF 0.11.0 (MIT); maintained by Metis. See ../../METIS.md.
// Linux x64 C layout: retain External addresses until the matching Rust
// fff_free_* call. Free the result envelope separately from its owned payload;
// neither Rust allocation may be released with libc::free or JS cleanup.
import { DataType, type FieldType, isNullPointer, type JsExternal, load, open, restorePointer, wrapPointer } from "ffi-rs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FileItem, GrepMatch, GrepResult, InitOptions, Location, MixedItem, MixedSearchResult, Result, Score, SearchResult } from "./api.ts";
import { createGrepCursor, err } from "./api.ts";

const LIBRARY_KEY = "metis_neural_search_v1";

const FFF_CREATE_OPTIONS_STRUCT = {
  version: DataType.U32,
  base_path: DataType.String,
  frecency_db_path: DataType.String,
  history_db_path: DataType.String,
  enable_mmap_cache: DataType.U8,
  enable_content_indexing: DataType.U8,
  watch: DataType.U8,
  ai_mode: DataType.U8,
  log_file_path: DataType.String,
  log_level: DataType.String,
  cache_budget_max_files: DataType.U64,
  cache_budget_max_bytes: DataType.U64,
  cache_budget_max_file_size: DataType.U64,
  enable_fs_root_scanning: DataType.U8,
  enable_home_dir_scanning: DataType.U8,
  follow_symlinks: DataType.U8,
};

const FFF_CREATE_OPTIONS_VERSION = 2;

const GREP_MODE_PLAIN = 0;

const GREP_MODE_REGEX = 1;

const GREP_MODE_FUZZY = 2;

function grepModeToU8(mode?: string): number {
  switch (mode) {
    case "regex":
      return GREP_MODE_REGEX;
    case "fuzzy":
      return GREP_MODE_FUZZY;
    default:
      return GREP_MODE_PLAIN;
  }
}

let isLoaded = false;

const FFF_RESULT_STRUCT = {
  success: DataType.U8,
  error: DataType.External,
  handle: DataType.External,
  int_value: DataType.I64,
};

interface FffResultRaw {
  success: number;
  error: JsExternal;
  handle: JsExternal;
  int_value: number;
}

function loadLibrary(): void {
  if (isLoaded) return;

  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Metis Neural Search requires Linux x64 (glibc).");
  const binaryPath = fileURLToPath(new URL("../../../../assets/neural-search/linux-x64/libmetis_neural_search.so", import.meta.url));
  if (!existsSync(binaryPath)) throw new Error("Metis Neural Search library is missing; reinstall the complete Metis package.");

  open({ library: LIBRARY_KEY, path: binaryPath });
  isLoaded = true;
}

function snakeToCamel(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(snakeToCamel);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    result[camelKey] = snakeToCamel(value);
  }
  return result;
}

function readCString(ptr: JsExternal): string | null {
  if (isNullPointer(ptr)) return null;
  try {
    const [str] = restorePointer({
      retType: [DataType.String],
      paramsValue: wrapPointer([ptr]),
    });
    return str as string;
  } catch {
    return null;
  }
}

function callRaw(
  funcName: string,
  paramsType: FieldType[],
  paramsValue: unknown[],
): { rawPtr: JsExternal; struct: FffResultRaw } {
  const rawPtr = load({
    library: LIBRARY_KEY,
    funcName,
    retType: DataType.External,
    paramsType,
    paramsValue,
    freeResultMemory: false,
  }) as JsExternal;

  const [structData] = restorePointer({
    retType: [FFF_RESULT_STRUCT],
    paramsValue: wrapPointer([rawPtr]),
  }) as unknown as [FffResultRaw];

  return { rawPtr, struct: structData };
}

function freeResult(resultPtr: JsExternal): void {
  try {
    load({
      library: LIBRARY_KEY,
      funcName: "fff_free_result",
      retType: DataType.Void,
      paramsType: [DataType.External],
      paramsValue: [resultPtr],
    });
  } catch {
    // Ignore cleanup errors
  }
}

function readResultEnvelope(
  funcName: string,
  paramsType: FieldType[],
  paramsValue: unknown[],
): { rawPtr: JsExternal; struct: FffResultRaw } | Result<never> {
  loadLibrary();
  const { rawPtr, struct: structData } = callRaw(funcName, paramsType, paramsValue);

  if (structData.success === 0) {
    const errorStr = readCString(structData.error);
    freeResult(rawPtr);
    return err(errorStr || "Unknown error");
  }

  return { rawPtr, struct: structData };
}

function callVoidResult(
  funcName: string,
  paramsType: FieldType[],
  paramsValue: unknown[],
): Result<void> {
  const res = readResultEnvelope(funcName, paramsType, paramsValue);
  if ("ok" in res) return res;
  freeResult(res.rawPtr);
  return { ok: true, value: undefined };
}

function callJsonResult<T>(
  funcName: string,
  paramsType: FieldType[],
  paramsValue: unknown[],
): Result<T> {
  const res = readResultEnvelope(funcName, paramsType, paramsValue);
  if ("ok" in res) return res;
  const handlePtr = res.struct.handle;
  freeResult(res.rawPtr);
  if (isNullPointer(handlePtr)) return { ok: true, value: undefined as T };
  const jsonStr = readCString(handlePtr);
  freeString(handlePtr);
  if (jsonStr === null || jsonStr === "") return { ok: true, value: undefined as T };
  try {
    return { ok: true, value: snakeToCamel(JSON.parse(jsonStr)) as T };
  } catch {
    return { ok: true, value: jsonStr as T };
  }
}

function freeString(ptr: JsExternal): void {
  try {
    load({
      library: LIBRARY_KEY,
      funcName: "fff_free_string",
      retType: DataType.Void,
      paramsType: [DataType.External],
      paramsValue: [ptr],
    });
  } catch {
    // Ignore
  }
}

export type NativeHandle = JsExternal;

export function ffiCreate(options: InitOptions): Result<NativeHandle> {
  loadLibrary();

  // ABI v2: keep this layout in sync with native/neural-search/crates/fff-c/include/fff.h.
  const optsValue = {
    version: FFF_CREATE_OPTIONS_VERSION,
    base_path: options.basePath,
    frecency_db_path: options.frecencyDbPath ?? "",
    history_db_path: options.historyDbPath ?? "",
    enable_mmap_cache: options.disableMmapCache ? 0 : 1,
    enable_content_indexing: (options.disableContentIndexing ?? options.disableMmapCache) ? 0 : 1,
    watch: options.disableWatch ? 0 : 1,
    ai_mode: options.aiMode ? 1 : 0,
    log_file_path: options.logFilePath ?? "",
    log_level: options.logLevel ?? "",
    cache_budget_max_files: options.cacheBudgetMaxFiles ?? 0,
    cache_budget_max_bytes: options.cacheBudgetMaxBytes ?? 0,
    cache_budget_max_file_size: options.cacheBudgetMaxFileSize ?? 0,
    enable_fs_root_scanning: options.enableFsRootScanning ? 1 : 0,
    enable_home_dir_scanning: options.enableHomeDirScanning ? 1 : 0,
    follow_symlinks: options.followSymlinks ? 1 : 0,
  };

  const rawPtr = load({
    library: LIBRARY_KEY,
    funcName: "fff_create_instance_with",
    retType: DataType.External,
    paramsType: [FFF_CREATE_OPTIONS_STRUCT],
    paramsValue: [optsValue],
    freeResultMemory: false,
  }) as JsExternal;

  const [structData] = restorePointer({
    retType: [FFF_RESULT_STRUCT],
    paramsValue: wrapPointer([rawPtr]),
  }) as unknown as [FffResultRaw];

  const success = structData.success !== 0;

  try {
    if (success) {
      const handle = structData.handle;
      if (isNullPointer(handle)) {
        return err("fff_create_instance_with returned null handle");
      }
      return { ok: true, value: handle };
    } else {
      const errorStr = readCString(structData.error);
      return err(errorStr || "Unknown error");
    }
  } finally {
    freeResult(rawPtr);
  }
}

export function ffiDestroy(handle: NativeHandle): void {
  loadLibrary();
  load({
    library: LIBRARY_KEY,
    funcName: "fff_destroy",
    retType: DataType.Void,
    paramsType: [DataType.External],
    paramsValue: [handle],
  });
}

const FFF_FILE_ITEM_STRUCT = {
  relative_path: DataType.External,
  file_name: DataType.External,
  git_status: DataType.External,
  size: DataType.U64,
  modified: DataType.U64,
  access_frecency_score: DataType.I64,
  modification_frecency_score: DataType.I64,
  total_frecency_score: DataType.I64,
  is_binary: DataType.U8,
};

interface FffFileItemRaw {
  relative_path: JsExternal;
  file_name: JsExternal;
  git_status: JsExternal;
  size: number;
  modified: number;
  access_frecency_score: number;
  modification_frecency_score: number;
  total_frecency_score: number;
  is_binary: number;
}

const FFF_SCORE_STRUCT = {
  total: DataType.I32,
  base_score: DataType.I32,
  filename_bonus: DataType.I32,
  special_filename_bonus: DataType.I32,
  frecency_boost: DataType.I32,
  distance_penalty: DataType.I32,
  current_file_penalty: DataType.I32,
  combo_match_boost: DataType.I32,
  exact_match: DataType.U8,
  match_type: DataType.External,
};

interface FffScoreRaw {
  total: number;
  base_score: number;
  filename_bonus: number;
  special_filename_bonus: number;
  frecency_boost: number;
  distance_penalty: number;
  current_file_penalty: number;
  combo_match_boost: number;
  exact_match: number;
  match_type: JsExternal;
}

const FFF_SEARCH_RESULT_STRUCT = {
  items: DataType.External,
  scores: DataType.External,
  count: DataType.U32,
  total_matched: DataType.U32,
  total_files: DataType.U32,
  // FffLocation inlined (flattened)
  location_tag: DataType.U8,
  location_line: DataType.I32,
  location_col: DataType.I32,
  location_end_line: DataType.I32,
  location_end_col: DataType.I32,
};

interface FffSearchResultRaw {
  items: JsExternal;
  scores: JsExternal;
  count: number;
  total_matched: number;
  total_files: number;
  location_tag: number;
  location_line: number;
  location_col: number;
  location_end_line: number;
  location_end_col: number;
}

const FFF_MIXED_ITEM_STRUCT = {
  item_type: DataType.U8,
  relative_path: DataType.External,
  display_name: DataType.External,
  git_status: DataType.External,
  size: DataType.U64,
  modified: DataType.U64,
  access_frecency_score: DataType.I64,
  modification_frecency_score: DataType.I64,
  total_frecency_score: DataType.I64,
  is_binary: DataType.U8,
};

interface FffMixedItemRaw {
  item_type: number;
  relative_path: JsExternal;
  display_name: JsExternal;
  git_status: JsExternal;
  size: number;
  modified: number;
  access_frecency_score: number;
  modification_frecency_score: number;
  total_frecency_score: number;
  is_binary: number;
}

const FFF_MIXED_SEARCH_RESULT_STRUCT = {
  items: DataType.External,
  scores: DataType.External,
  count: DataType.U32,
  total_matched: DataType.U32,
  total_files: DataType.U32,
  total_dirs: DataType.U32,
  // FffLocation inlined (flattened)
  location_tag: DataType.U8,
  location_line: DataType.I32,
  location_col: DataType.I32,
  location_end_line: DataType.I32,
  location_end_col: DataType.I32,
};

interface FffMixedSearchResultRaw {
  items: JsExternal;
  scores: JsExternal;
  count: number;
  total_matched: number;
  total_files: number;
  total_dirs: number;
  location_tag: number;
  location_line: number;
  location_col: number;
  location_end_line: number;
  location_end_col: number;
}

const FFF_GREP_MATCH_STRUCT = {
  relative_path: DataType.External,
  file_name: DataType.External,
  git_status: DataType.External,
  line_content: DataType.External,
  match_ranges: DataType.External,
  context_before: DataType.External,
  context_after: DataType.External,
  size: DataType.U64,
  modified: DataType.U64,
  total_frecency_score: DataType.I64,
  access_frecency_score: DataType.I64,
  modification_frecency_score: DataType.I64,
  line_number: DataType.U64,
  byte_offset: DataType.U64,
  col: DataType.U32,
  match_ranges_count: DataType.U32,
  context_before_count: DataType.U32,
  context_after_count: DataType.U32,
  // C has u16 immediately followed by bools, not padding. I16 preserves its
  // two-byte width; reinterpret the signed value when projecting to JS.
  fuzzy_score: DataType.I16,
  has_fuzzy_score: DataType.U8,
  is_binary: DataType.U8,
  is_definition: DataType.U8,
};

interface FffGrepMatchRaw {
  relative_path: JsExternal;
  file_name: JsExternal;
  git_status: JsExternal;
  line_content: JsExternal;
  match_ranges: JsExternal;
  context_before: JsExternal;
  context_after: JsExternal;
  size: number;
  modified: number;
  total_frecency_score: number;
  access_frecency_score: number;
  modification_frecency_score: number;
  line_number: number;
  byte_offset: number;
  col: number;
  match_ranges_count: number;
  context_before_count: number;
  context_after_count: number;
  fuzzy_score: number;
  has_fuzzy_score: number;
  is_binary: number;
  is_definition: number;
}

const FFF_GREP_RESULT_STRUCT = {
  items: DataType.External,
  count: DataType.U32,
  total_matched: DataType.U32,
  total_files_searched: DataType.U32,
  total_files: DataType.U32,
  filtered_file_count: DataType.U32,
  next_file_offset: DataType.U32,
  regex_fallback_error: DataType.External,
};

interface FffGrepResultRaw {
  items: JsExternal;
  count: number;
  total_matched: number;
  total_files_searched: number;
  total_files: number;
  filtered_file_count: number;
  next_file_offset: number;
  regex_fallback_error: JsExternal;
}

const FFF_MATCH_RANGE_STRUCT = {
  start: DataType.U32,
  end: DataType.U32,
};

interface FffMatchRangeRaw {
  start: number;
  end: number;
}

function readFileItemFromRaw(raw: FffFileItemRaw): FileItem {
  return {
    relativePath: readCString(raw.relative_path) ?? "",
    fileName: readCString(raw.file_name) ?? "",
    gitStatus: readCString(raw.git_status) ?? "",
    size: Number(raw.size),
    modified: Number(raw.modified),
    accessFrecencyScore: Number(raw.access_frecency_score),
    modificationFrecencyScore: Number(raw.modification_frecency_score),
    totalFrecencyScore: Number(raw.total_frecency_score),
  };
}

function readScoreFromRaw(raw: FffScoreRaw): Score {
  return {
    total: raw.total,
    baseScore: raw.base_score,
    filenameBonus: raw.filename_bonus,
    specialFilenameBonus: raw.special_filename_bonus,
    frecencyBoost: raw.frecency_boost,
    distancePenalty: raw.distance_penalty,
    currentFilePenalty: raw.current_file_penalty,
    comboMatchBoost: raw.combo_match_boost,
    exactMatch: raw.exact_match !== 0,
    matchType: readCString(raw.match_type) ?? "",
  };
}

function readMixedItemFromRaw(raw: FffMixedItemRaw): MixedItem {
  if (raw.item_type === 1) {
    // Directory
    return {
      type: "directory",
      item: {
        relativePath: readCString(raw.relative_path) ?? "",
        dirName: readCString(raw.display_name) ?? "",
        maxAccessFrecency: Number(raw.access_frecency_score),
      },
    };
  }
  // File (item_type === 0)
  return {
    type: "file",
    item: {
      relativePath: readCString(raw.relative_path) ?? "",
      fileName: readCString(raw.display_name) ?? "",
      gitStatus: readCString(raw.git_status) ?? "",
      size: Number(raw.size),
      modified: Number(raw.modified),
      accessFrecencyScore: Number(raw.access_frecency_score),
      modificationFrecencyScore: Number(raw.modification_frecency_score),
      totalFrecencyScore: Number(raw.total_frecency_score),
    },
  };
}

function callAccessor<T>(
  funcName: string,
  resultPtr: JsExternal,
  index: number,
  structDef: Record<string, DataType>,
): T {
  loadLibrary();
  const elemPtr = load({
    library: LIBRARY_KEY,
    funcName,
    retType: DataType.External,
    paramsType: [DataType.External, DataType.U32],
    paramsValue: [resultPtr, index],
  }) as JsExternal;

  const [raw] = restorePointer({
    retType: [structDef],
    paramsValue: wrapPointer([elemPtr]),
  }) as unknown as [T];

  return raw;
}

function ptrOffset(base: JsExternal, bytes: number): JsExternal {
  return load({
    library: LIBRARY_KEY,
    funcName: "fff_ptr_offset",
    retType: DataType.External,
    paramsType: [DataType.External, DataType.U64],
    paramsValue: [base, bytes],
  }) as JsExternal;
}

function readCStringArray(ptrArray: JsExternal, count: number): string[] {
  if (count === 0 || isNullPointer(ptrArray)) return [];
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    const elemPtr = ptrOffset(ptrArray, i * 8);
    const [charPtr] = restorePointer({
      retType: [DataType.External],
      paramsValue: [elemPtr],
    }) as unknown as [JsExternal];
    result.push(readCString(charPtr) ?? "");
  }
  return result;
}

function readGrepMatchFromRaw(raw: FffGrepMatchRaw): GrepMatch {
  // Read match_ranges array via pointer offsets
  const matchRanges: [number, number][] = [];
  for (let i = 0; i < raw.match_ranges_count; i++) {
    const rangePtr = ptrOffset(raw.match_ranges, i * 8); // FffMatchRange is 8 bytes
    const [rangeRaw] = restorePointer({
      retType: [FFF_MATCH_RANGE_STRUCT],
      paramsValue: wrapPointer([rangePtr]),
    }) as unknown as [FffMatchRangeRaw];
    matchRanges.push([rangeRaw.start, rangeRaw.end]);
  }

  const match: GrepMatch = {
    relativePath: readCString(raw.relative_path) ?? "",
    fileName: readCString(raw.file_name) ?? "",
    gitStatus: readCString(raw.git_status) ?? "",
    lineContent: readCString(raw.line_content) ?? "",
    size: Number(raw.size),
    modified: Number(raw.modified),
    totalFrecencyScore: Number(raw.total_frecency_score),
    accessFrecencyScore: Number(raw.access_frecency_score),
    modificationFrecencyScore: Number(raw.modification_frecency_score),
    isBinary: raw.is_binary !== 0,
    lineNumber: Number(raw.line_number),
    col: raw.col,
    byteOffset: Number(raw.byte_offset),
    matchRanges,
  };

  if (raw.has_fuzzy_score !== 0) {
    match.fuzzyScore = raw.fuzzy_score & 0xffff;
  }
  if (raw.context_before_count > 0) {
    match.contextBefore = readCStringArray(raw.context_before, raw.context_before_count);
  }
  if (raw.context_after_count > 0) {
    match.contextAfter = readCStringArray(raw.context_after, raw.context_after_count);
  }
  if (raw.is_definition !== 0) {
    match.isDefinition = true;
  }

  return match;
}

function parseGrepResult(rawPtr: JsExternal): Result<GrepResult> {
  loadLibrary();

  const [envelope] = restorePointer({
    retType: [FFF_RESULT_STRUCT],
    paramsValue: wrapPointer([rawPtr]),
  }) as unknown as [FffResultRaw];

  const success = envelope.success !== 0;

  if (!success) {
    const errorMsg = readCString(envelope.error) || "Unknown error";
    freeResult(rawPtr);
    return err(errorMsg);
  }

  const handlePtr = envelope.handle;
  freeResult(rawPtr);

  if (isNullPointer(handlePtr)) {
    return err("grep returned null result");
  }

  const [gr] = restorePointer({
    retType: [FFF_GREP_RESULT_STRUCT],
    paramsValue: wrapPointer([handlePtr]),
  }) as unknown as [FffGrepResultRaw];

  const count = gr.count;
  const regexFallbackError = readCString(gr.regex_fallback_error) ?? undefined;

  const items: GrepMatch[] = [];
  for (let i = 0; i < count; i++) {
    const rawMatch = callAccessor<FffGrepMatchRaw>(
      "fff_grep_result_get_match",
      handlePtr,
      i,
      FFF_GREP_MATCH_STRUCT,
    );
    items.push(readGrepMatchFromRaw(rawMatch));
  }

  // Free native grep result
  load({
    library: LIBRARY_KEY,
    funcName: "fff_free_grep_result",
    retType: DataType.Void,
    paramsType: [DataType.External],
    paramsValue: [handlePtr],
  });

  const grepResult: GrepResult = {
    items,
    totalMatched: gr.total_matched,
    totalFilesSearched: gr.total_files_searched,
    totalFiles: gr.total_files,
    filteredFileCount: gr.filtered_file_count,
    nextCursor: gr.next_file_offset > 0 ? createGrepCursor(gr.next_file_offset) : null,
  };
  if (regexFallbackError) {
    grepResult.regexFallbackError = regexFallbackError;
  }
  return { ok: true, value: grepResult };
}

function parseSearchResult(rawPtr: JsExternal): Result<SearchResult> {
  loadLibrary();

  // Read FffResult envelope
  const [envelope] = restorePointer({
    retType: [FFF_RESULT_STRUCT],
    paramsValue: wrapPointer([rawPtr]),
  }) as unknown as [FffResultRaw];

  const success = envelope.success !== 0;

  if (!success) {
    const errorMsg = readCString(envelope.error) || "Unknown error";
    freeResult(rawPtr);
    return err(errorMsg);
  }

  const handlePtr = envelope.handle;
  // Free the FffResult envelope (does NOT free handle)
  freeResult(rawPtr);

  if (isNullPointer(handlePtr)) {
    return err("fff_search returned null search result");
  }

  // Read FffSearchResult struct
  const [sr] = restorePointer({
    retType: [FFF_SEARCH_RESULT_STRUCT],
    paramsValue: wrapPointer([handlePtr]),
  }) as unknown as [FffSearchResultRaw];

  const count = sr.count;

  // Read location
  let location: Location | undefined;
  if (sr.location_tag === 1) {
    location = { type: "line", line: sr.location_line };
  } else if (sr.location_tag === 2) {
    location = {
      type: "position",
      line: sr.location_line,
      col: sr.location_col,
    };
  } else if (sr.location_tag === 3) {
    location = {
      type: "range",
      start: { line: sr.location_line, col: sr.location_col },
      end: { line: sr.location_end_line, col: sr.location_end_col },
    };
  }

  // Read items and scores via accessor functions
  const items: FileItem[] = [];
  const scores: Score[] = [];

  for (let i = 0; i < count; i++) {
    const rawItem = callAccessor<FffFileItemRaw>(
      "fff_search_result_get_item",
      handlePtr,
      i,
      FFF_FILE_ITEM_STRUCT,
    );
    items.push(readFileItemFromRaw(rawItem));

    const rawScore = callAccessor<FffScoreRaw>(
      "fff_search_result_get_score",
      handlePtr,
      i,
      FFF_SCORE_STRUCT,
    );
    scores.push(readScoreFromRaw(rawScore));
  }

  // Free native search result
  load({
    library: LIBRARY_KEY,
    funcName: "fff_free_search_result",
    retType: DataType.Void,
    paramsType: [DataType.External],
    paramsValue: [handlePtr],
  });

  const result: SearchResult = {
    items,
    scores,
    totalMatched: sr.total_matched,
    totalFiles: sr.total_files,
  };
  if (location) {
    result.location = location;
  }
  return { ok: true, value: result };
}

function parseMixedSearchResult(rawPtr: JsExternal): Result<MixedSearchResult> {
  loadLibrary();

  // Read FffResult envelope
  const [envelope] = restorePointer({
    retType: [FFF_RESULT_STRUCT],
    paramsValue: wrapPointer([rawPtr]),
  }) as unknown as [FffResultRaw];

  const success = envelope.success !== 0;

  if (!success) {
    const errorMsg = readCString(envelope.error) || "Unknown error";
    freeResult(rawPtr);
    return err(errorMsg);
  }

  const handlePtr = envelope.handle;
  // Free the FffResult envelope (does NOT free handle)
  freeResult(rawPtr);

  if (isNullPointer(handlePtr)) {
    return err("fff_search_mixed returned null search result");
  }

  // Read FffMixedSearchResult struct
  const [sr] = restorePointer({
    retType: [FFF_MIXED_SEARCH_RESULT_STRUCT],
    paramsValue: wrapPointer([handlePtr]),
  }) as unknown as [FffMixedSearchResultRaw];

  const count = sr.count;

  // Read location
  let location: Location | undefined;
  if (sr.location_tag === 1) {
    location = { type: "line", line: sr.location_line };
  } else if (sr.location_tag === 2) {
    location = {
      type: "position",
      line: sr.location_line,
      col: sr.location_col,
    };
  } else if (sr.location_tag === 3) {
    location = {
      type: "range",
      start: { line: sr.location_line, col: sr.location_col },
      end: { line: sr.location_end_line, col: sr.location_end_col },
    };
  }

  // Read items and scores via accessor functions
  const items: MixedItem[] = [];
  const scores: Score[] = [];

  for (let i = 0; i < count; i++) {
    const rawItem = callAccessor<FffMixedItemRaw>(
      "fff_mixed_search_result_get_item",
      handlePtr,
      i,
      FFF_MIXED_ITEM_STRUCT,
    );
    items.push(readMixedItemFromRaw(rawItem));

    const rawScore = callAccessor<FffScoreRaw>(
      "fff_mixed_search_result_get_score",
      handlePtr,
      i,
      FFF_SCORE_STRUCT,
    );
    scores.push(readScoreFromRaw(rawScore));
  }

  // Free native mixed search result
  load({
    library: LIBRARY_KEY,
    funcName: "fff_free_mixed_search_result",
    retType: DataType.Void,
    paramsType: [DataType.External],
    paramsValue: [handlePtr],
  });

  const result: MixedSearchResult = {
    items,
    scores,
    totalMatched: sr.total_matched,
    totalFiles: sr.total_files,
    totalDirs: sr.total_dirs,
  };
  if (location) {
    result.location = location;
  }
  return { ok: true, value: result };
}

export function ffiSearch(
  handle: NativeHandle,
  query: string,
  currentFile: string,
  maxThreads: number,
  pageIndex: number,
  pageSize: number,
  comboBoostMultiplier: number,
  minComboCount: number,
): Result<SearchResult> {
  loadLibrary();

  const rawPtr = load({
    library: LIBRARY_KEY,
    funcName: "fff_search",
    retType: DataType.External,
    paramsType: [
      DataType.External, // handle
      DataType.String, // query
      DataType.String, // current_file
      DataType.U32, // max_threads
      DataType.U32, // page_index
      DataType.U32, // page_size
      DataType.I32, // combo_boost_multiplier
      DataType.U32, // min_combo_count
    ],
    paramsValue: [
      handle,
      query,
      currentFile,
      maxThreads,
      pageIndex,
      pageSize,
      comboBoostMultiplier,
      minComboCount,
    ],
    freeResultMemory: false,
  }) as JsExternal;

  return parseSearchResult(rawPtr);
}

export function ffiSearchMixed(
  handle: NativeHandle,
  query: string,
  currentFile: string,
  maxThreads: number,
  pageIndex: number,
  pageSize: number,
  comboBoostMultiplier: number,
  minComboCount: number,
): Result<MixedSearchResult> {
  loadLibrary();

  const rawPtr = load({
    library: LIBRARY_KEY,
    funcName: "fff_search_mixed",
    retType: DataType.External,
    paramsType: [
      DataType.External, // handle
      DataType.String, // query
      DataType.String, // current_file
      DataType.U32, // max_threads
      DataType.U32, // page_index
      DataType.U32, // page_size
      DataType.I32, // combo_boost_multiplier
      DataType.U32, // min_combo_count
    ],
    paramsValue: [
      handle,
      query,
      currentFile,
      maxThreads,
      pageIndex,
      pageSize,
      comboBoostMultiplier,
      minComboCount,
    ],
    freeResultMemory: false,
  }) as JsExternal;

  return parseMixedSearchResult(rawPtr);
}

export function ffiLiveGrep(
  handle: NativeHandle,
  query: string,
  mode: string,
  maxFileSize: number,
  maxMatchesPerFile: number,
  smartCase: boolean,
  fileOffset: number,
  pageLimit: number,
  timeBudgetMs: number,
  enforceTimeBudget: boolean,
  beforeContext: number,
  afterContext: number,
  classifyDefinitions: boolean,
): Result<GrepResult> {
  loadLibrary();

  const rawPtr = load({
    library: LIBRARY_KEY,
    funcName: "fff_live_grep_ex",
    retType: DataType.External,
    paramsType: [
      DataType.External, // handle
      DataType.String, // query
      DataType.U8, // mode
      DataType.U64, // max_file_size
      DataType.U32, // max_matches_per_file
      DataType.Boolean, // smart_case
      DataType.U32, // file_offset
      DataType.U32, // page_limit
      DataType.U64, // time_budget_ms
      DataType.Boolean, // enforce_time_budget
      DataType.U32, // before_context
      DataType.U32, // after_context
      DataType.Boolean, // classify_definitions
    ],
    paramsValue: [
      handle,
      query,
      grepModeToU8(mode),
      maxFileSize,
      maxMatchesPerFile,
      smartCase,
      fileOffset,
      pageLimit,
      timeBudgetMs,
      enforceTimeBudget,
      beforeContext,
      afterContext,
      classifyDefinitions,
    ],
    freeResultMemory: false,
  }) as JsExternal;

  return parseGrepResult(rawPtr);
}

export function ffiMultiGrep(
  handle: NativeHandle,
  patternsJoined: string,
  constraints: string,
  maxFileSize: number,
  maxMatchesPerFile: number,
  smartCase: boolean,
  fileOffset: number,
  pageLimit: number,
  timeBudgetMs: number,
  enforceTimeBudget: boolean,
  beforeContext: number,
  afterContext: number,
  classifyDefinitions: boolean,
): Result<GrepResult> {
  loadLibrary();

  const rawPtr = load({
    library: LIBRARY_KEY,
    funcName: "fff_multi_grep_ex",
    retType: DataType.External,
    paramsType: [
      DataType.External, // handle
      DataType.String, // patterns_joined
      DataType.String, // constraints
      DataType.U64, // max_file_size
      DataType.U32, // max_matches_per_file
      DataType.Boolean, // smart_case
      DataType.U32, // file_offset
      DataType.U32, // page_limit
      DataType.U64, // time_budget_ms
      DataType.Boolean, // enforce_time_budget
      DataType.U32, // before_context
      DataType.U32, // after_context
      DataType.Boolean, // classify_definitions
    ],
    paramsValue: [
      handle,
      patternsJoined,
      constraints,
      maxFileSize,
      maxMatchesPerFile,
      smartCase,
      fileOffset,
      pageLimit,
      timeBudgetMs,
      enforceTimeBudget,
      beforeContext,
      afterContext,
      classifyDefinitions,
    ],
    freeResultMemory: false,
  }) as JsExternal;

  return parseGrepResult(rawPtr);
}

export function ffiScanFiles(handle: NativeHandle): Result<void> {
  return callVoidResult("fff_scan_files", [DataType.External], [handle]);
}

export function ffiIsScanning(handle: NativeHandle): boolean {
  loadLibrary();
  return load({
    library: LIBRARY_KEY,
    funcName: "fff_is_scanning",
    retType: DataType.Boolean,
    paramsType: [DataType.External],
    paramsValue: [handle],
  }) as boolean;
}

const FFF_SCAN_PROGRESS_STRUCT = {
  scanned_files_count: DataType.U64,
  is_scanning: DataType.U8,
  is_watcher_ready: DataType.U8,
  is_warmup_complete: DataType.U8,
};

interface FffScanProgressRaw {
  scanned_files_count: number;
  is_scanning: number;
  is_watcher_ready: number;
  is_warmup_complete: number;
}

export function ffiGetScanProgress(handle: NativeHandle): Result<{
  scannedFilesCount: number;
  isScanning: boolean;
  isWatcherReady: boolean;
  isWarmupComplete: boolean;
}> {
  loadLibrary();
  const res = readResultEnvelope("fff_get_scan_progress", [DataType.External], [handle]);
  if ("ok" in res) return res;

  const handlePtr = res.struct.handle;
  freeResult(res.rawPtr);

  if (isNullPointer(handlePtr)) return err("scan progress returned null");

  const [sp] = restorePointer({
    retType: [FFF_SCAN_PROGRESS_STRUCT],
    paramsValue: wrapPointer([handlePtr]),
  }) as unknown as [FffScanProgressRaw];

  const result = {
    scannedFilesCount: Number(sp.scanned_files_count),
    isScanning: sp.is_scanning !== 0,
    isWatcherReady: sp.is_watcher_ready !== 0,
    isWarmupComplete: sp.is_warmup_complete !== 0,
  };

  // Free native scan progress
  load({
    library: LIBRARY_KEY,
    funcName: "fff_free_scan_progress",
    retType: DataType.Void,
    paramsType: [DataType.External],
    paramsValue: [handlePtr],
  });

  return { ok: true, value: result };
}

export function ffiHealthCheck(
  handle: NativeHandle | null,
  testPath: string,
): Result<unknown> {
  if (handle === null) {
    // Use U64(0) as a null pointer since ffi-rs rejects null for External params
    return callJsonResult<unknown>(
      "fff_health_check",
      [DataType.U64, DataType.String],
      [0, testPath],
    );
  }

  return callJsonResult<unknown>(
    "fff_health_check",
    [DataType.External, DataType.String],
    [handle, testPath],
  );
}
