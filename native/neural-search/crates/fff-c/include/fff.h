/* Metis private Linux x64 ABI v6. Not a standalone SDK or allocation API.
 * Maintained with src/ffi_types.rs and the ffi-rs layout. Derived from FFF
 * 0.11.0 (MIT), Copyright (c) 2025 Dmitriy Kovalenko; see ../../../LICENSE.
 * All result views and their strings/arrays are borrowed until free_result.
 * Only take_instance transfers ownership; destroy that handle exactly once.
 */
#ifndef METIS_NEURAL_SEARCH_H
#define METIS_NEURAL_SEARCH_H
#include <stdbool.h>
#include <stdint.h>

#define METIS_SEARCH_ABI_VERSION 6

typedef struct {
  uint32_t version;
  const char *base_path, *frecency_db_path, *history_db_path;
  bool enable_fs_root_scanning, enable_home_dir_scanning, follow_symlinks;
} MetisCreateOptions;

/* Opaque owner with the following borrowed 32-byte prefix. Do not allocate
 * this view or free individual payloads; the native owner has a private tail. */
typedef struct MetisResult MetisResult;
typedef struct { bool success; char *error; void *handle; int64_t int_value; } MetisResultView;
typedef struct { char *relative_path, *git_status; int64_t total_frecency_score; } MetisFile;
typedef struct { MetisFile *items; uint32_t count, total_matched, total_files; int32_t top_score; } MetisFiles;
typedef struct { char *relative_path, *display_name; uint8_t item_type; } MetisMixedItem;
typedef struct { MetisMixedItem *items; uint32_t count; } MetisMixed;
typedef struct {
  char *relative_path, *git_status, *line_content;
  char **context_before, **context_after;
  uint64_t line_number;
  int64_t total_frecency_score;
  uint32_t context_before_count, context_after_count;
} MetisMatch;
typedef struct {
  MetisMatch *items;
  uint32_t count, total_files_searched, total_files, filtered_file_count, next_file_offset;
  /* Bit 0: multiline projection limited; bit 1: display/context bytes clipped. */
  uint8_t output_limits;
  char *regex_fallback_error;
  uint64_t index_version;
} MetisGrep;
typedef struct {
  uint64_t scanned_files_count;
  bool is_scanning, is_watcher_ready, is_ready;
  uint64_t index_version;
  char *scan_error, *git_status_error, *watcher_error;
} MetisProgress;

uint32_t metis_search_abi_version(void);
MetisResult *metis_search_create(const MetisCreateOptions *options);
void *metis_search_take_instance(MetisResult *create_result);
void metis_search_destroy(void *handle);
MetisResult *metis_search_files(void *handle, const char *query, uint32_t item_offset, uint32_t page_size);
MetisResult *metis_search_mixed(void *handle, const char *query, uint32_t page_size);
/* Pattern bytes are independent from the filter grammar. mode: plain=0,
 * regex=1, fuzzy=2. page_limit is a soft whole-file limit, not a row cursor.
 * Zero file-size/page-size selects the existing default; zero time is unlimited.
 * enforce_time_budget=false preserves complete zero-match searches.
 * Zero expected_index_version is fresh offset0; continuations must match the
 * index version captured with the previous result under the same read lock. */
MetisResult *metis_search_grep(void *handle, const char *pattern, const char *filters, uint8_t mode,
  uint64_t max_file_size, uint32_t max_matches, bool smart_case, uint32_t file_offset,
  uint32_t page_limit, uint64_t time_ms, bool enforce_time_budget, uint32_t before, uint32_t after,
  uint64_t expected_index_version);
/* LF-separated literal OR needles; higher layers reject ambiguous embedded LF. */
MetisResult *metis_search_multi_grep(void *handle, const char *patterns, const char *filters,
  uint64_t max_file_size, uint32_t max_matches, bool smart_case, uint32_t file_offset,
  uint32_t page_limit, uint64_t time_ms, bool enforce_time_budget, uint32_t before, uint32_t after,
  uint64_t expected_index_version);
MetisResult *metis_search_scan(void *handle);
MetisResult *metis_search_is_scanning(void *handle);
MetisResult *metis_search_progress(void *handle);
MetisResult *metis_search_health(void *handle, const char *test_path);
void metis_search_free_result(MetisResult *result);
const MetisFile *metis_search_get_file(const MetisFiles *result, uint32_t index);
const MetisMixedItem *metis_search_get_mixed(const MetisMixed *result, uint32_t index);
const MetisMatch *metis_search_get_match(const MetisGrep *result, uint32_t index);
const void *metis_search_pointer_offset(const void *base, uint64_t bytes);
#endif
