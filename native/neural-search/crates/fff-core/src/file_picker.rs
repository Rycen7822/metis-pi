//! Core file picker: filesystem indexing, background watching, and fuzzy search.
//!
//! [`FilePicker`] is the central component of fff-search. It:
//!
//! 1. **Indexes** a directory tree in a background thread, collecting every
//!    non-ignored file into a path-sorted `Vec<FileItem>`.
//! 2. **Watches** the filesystem via the `notify` crate, applying
//!    create/modify/delete events to the index in real time.
//! 3. **Owns files**: Provides a values for search and provides a good entry point for
//!    fuzzy search and live grep
//!
//! # Lifecycle
//!
//! ```text
//!   new_with_shared_state()
//!     │
//!     ├─> background scan thread ──> populates SharedPicker
//!     └─> file-system watcher    ──> live updates SharedPicker
//!
//!   search()         <── borrows &self, delegates to fuzzy_search
//!   grep()           <── static, borrows &[FileItem] (live content search)
//!   trigger_rescan() <── synchronous re-index
//!   cancel()         <── shuts down background work
//! ```
//!
//! # Thread Safety
//!
//! `FilePicker` itself is **not** `Sync`!
//! all concurrent access goes through [`crate::SharedFilePicker`]

use crate::FFFStringStorage;
use crate::binary_classifier::{BinaryInput, scratch};
use crate::constants::{MAX_OVERFLOW_FILES, PATH_BUF_SIZE};
use crate::error::Error;
use crate::frecency::FrecencyTracker;
use crate::git::GitStatusCache;
#[cfg(test)]
use crate::git_recency;
use crate::git_recency::GitRecencyConfig;
use crate::grep::{GrepResult, GrepSearchOptions, multi_grep_search};
use crate::query_tracker::QueryTracker;
use crate::scan::{ScanConfig, ScanJob, ScanSignals};
use crate::score::fuzzy_match_and_score_files;
use crate::shared::{SharedFilePicker, SharedFrecency, WeakFilePicker};
use crate::simd_path::ArenaPtr;
use crate::stable_vec::StableVec;
use crate::types::{
    ContentCacheBudget, DirItem, DirSearchResult, FileItem, MixedItemRef, MixedSearchResult,
    PaginationArgs, Score, ScoringContext, SearchResult,
};
use crate::walk::WalkOutput;
use crate::watch::BackgroundWatcher;
use ahash::AHashMap;
use fff_query_parser::FFFQuery;
use git2::{Repository, Status};
use rayon::prelude::*;
use std::fmt::Debug;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
#[cfg(test)]
use std::thread::JoinHandle;
use std::time::SystemTime;
use tracing::{Level, debug, error, info, warn};

use crate::parallelism::{BACKGROUND_THREAD_POOL, SEARCH_THREAD_POOL};

/// Configuration for a single fuzzy search invocation.
///
/// Passed to [`FilePicker::search`] to control threading, pagination,
/// and scoring behavior.
#[derive(Debug, Clone, Copy, Default)]
pub struct FuzzySearchOptions<'a> {
    pub max_threads: usize,
    pub current_file: Option<&'a str>,
    pub project_path: Option<&'a Path>,
    pub combo_boost_score_multiplier: i32,
    pub min_combo_count: u32,
    pub pagination: PaginationArgs,
}

#[derive(Debug)]
pub(crate) struct FileSync {
    /// Allocation identity, not a timestamp; a replaced sync can reuse slots.
    identity: Arc<()>,
    pub(crate) git_workdir: Option<PathBuf>,
    /// Base files laid out in two partitions, each internally sorted by
    /// (parent_dir, filename):
    ///   `files[..indexable_count]` - indexable
    ///   `files[indexable_count..base_count]` - original-unindexable
    ///   `files[base_count..]` - overflow
    files: StableVec<FileItem>,
    indexable_count: usize,
    base_count: usize,
    /// Number of active present files that exists in the file system
    pub(crate) live_count: usize,
    /// Uniquely owned directory table, accessed under the picker lock.
    /// Dir frecency can be updated by parallel workers via its atomic score.
    /// Layout mirrors `files`: `dirs[..base_dirs_count]` is the sorted
    /// scan-built region, `dirs[base_dirs_count..]` holds watcher-appended dirs.
    dirs: StableVec<DirItem>,
    base_dirs_count: usize,
    /// Number of dirs with at least one live file (mirrors `live_count`).
    live_dirs_count: usize,
    /// Shared builder for overflow file paths. Each overflow file's ChunkedString
    /// uses `arena_override` pointing into this builder's arena.
    overflow_builder: Option<crate::simd_path::ChunkedPathStoreBuilder>,
    /// Immutable chunk-level deduped path store, read under the picker lock.
    chunked_paths: Option<Arc<crate::simd_path::ChunkedPathStore>>,
    /// Walker ignore rules, shared with the background filesystem watcher.
    pub(crate) ignore_rules: Option<Arc<crate::walk::WalkIgnoreRules>>,
}

impl FileSync {
    fn new() -> Self {
        Self {
            identity: Arc::new(()),
            files: StableVec::from_vec_with_reserve(Vec::new(), MAX_OVERFLOW_FILES),
            indexable_count: 0,
            base_count: 0,
            live_count: 0,
            dirs: StableVec::from_vec_with_reserve(Vec::new(), MAX_OVERFLOW_FILES),
            base_dirs_count: 0,
            live_dirs_count: 0,
            overflow_builder: None,
            git_workdir: None,
            chunked_paths: None,
            ignore_rules: None,
        }
    }

    #[inline]
    fn arena_base_ptr(&self) -> ArenaPtr {
        self.chunked_paths
            .as_ref()
            .map(|s| s.as_arena_ptr())
            .unwrap_or(ArenaPtr::null())
    }

    #[inline]
    fn arena_overflow_ptr(&self) -> ArenaPtr {
        self.overflow_builder
            .as_ref()
            .map(|b| b.as_arena_ptr())
            .unwrap_or(ArenaPtr::null())
    }

    #[inline]
    fn arena_for_file(&self, file: &FileItem) -> ArenaPtr {
        if file.is_overflow() {
            self.arena_overflow_ptr()
        } else {
            self.arena_base_ptr()
        }
    }

    #[inline]
    fn files(&self) -> &[FileItem] {
        &self.files
    }

    #[inline]
    fn overflow_files(&self) -> &[FileItem] {
        &self.files[self.base_count..]
    }

    #[inline]
    fn get_file_mut(&mut self, index: usize) -> Option<(ArenaPtr, &mut FileItem)> {
        Some((
            if index < self.base_count {
                self.arena_base_ptr()
            } else {
                self.arena_overflow_ptr()
            },
            self.files.get_mut(index)?,
        ))
    }

    #[inline]
    fn find_file_index(&self, path: &Path, base_path: &Path) -> Option<usize> {
        let relative = path.strip_prefix(base_path).ok()?.to_string_lossy();
        self.find_by_relative_path(&relative)
    }

    // Lookup for a base-relative, '/'-canonical path — the form paths are
    // stored in, so no normalization is needed.
    fn find_by_relative_path(&self, rel_path: &str) -> Option<usize> {
        let arena = self.arena_base_ptr();

        // Split into directory (with trailing '/') and filename.
        let parent_end = rel_path
            .rfind(std::path::is_separator)
            .map(|i| i + 1)
            .unwrap_or(0);
        let dir_rel = &rel_path[..parent_end];
        let filename = &rel_path[parent_end..];

        // Binary search dirs to find the parent directory index.
        // Dir items store the relative path including trailing '/' (e.g. "src/components/").
        // Only the scan-built region is sorted; watcher-appended dirs are not.
        let mut dir_buf = [0u8; crate::simd_path::PATH_BUF_SIZE];
        let dir_idx = self.dirs[..self.base_dirs_count]
            .binary_search_by(|d| d.read_relative_path(arena, &mut dir_buf).cmp(dir_rel))
            .ok();

        if let Some(dir_idx) = dir_idx {
            let dir_idx = dir_idx as u32;
            let cmp_key = |f: &FileItem| {
                f.parent_dir_index.cmp(&dir_idx).then_with(|| {
                    let fname = f.file_name(arena);
                    fname.as_str().cmp(filename)
                })
            };

            if self.indexable_count > 0
                && let Ok(pos) = self.files[..self.indexable_count].binary_search_by(cmp_key)
            {
                return Some(pos);
            }

            if self.indexable_count < self.base_count
                && let Ok(rel_pos) =
                    self.files[self.indexable_count..self.base_count].binary_search_by(cmp_key)
            {
                return Some(self.indexable_count + rel_pos);
            }
        }

        // Overflow region: linear scan by full relative path.
        if self.base_count < self.files.len() {
            let overflow_arena = self.arena_overflow_ptr();
            if let Some(pos) = self.files[self.base_count..]
                .iter()
                .position(|f| f.relative_path_eq(overflow_arena, rel_path))
            {
                return Some(self.base_count + pos);
            }
        }

        None
    }

    // TODO remove this function and make a better way to remove all files
    // from the directory without looping over the whole sync data list
    // Tombstones every matching arena file.
    fn tombstone_files_with_arena<F, T>(&mut self, mut predicate: F, mut on_tombstone: T) -> usize
    where
        F: FnMut(&FileItem, ArenaPtr) -> bool,
        T: FnMut(&mut FileItem, ArenaPtr),
    {
        let base_arena = self.arena_base_ptr();
        let overflow_arena = self.arena_overflow_ptr();
        let base_count = self.base_count;

        let mut tombstoned = 0usize;
        for (idx, file) in self.files.iter_mut().enumerate() {
            if file.is_deleted() {
                continue;
            }
            let arena = if idx < base_count {
                base_arena
            } else {
                overflow_arena
            };
            if predicate(file, arena) {
                on_tombstone(file, arena);
                file.set_deleted(true);
                tombstoned += 1;
            }
        }
        self.live_count -= tombstoned;
        tombstoned
    }

    /// Marks every dir matching `predicate` as deleted. Mirrors how dir-level
    /// FS events (remove/move-out) invalidate whole subtrees.
    fn tombstone_dirs_with_arena<F>(&mut self, mut predicate: F)
    where
        F: FnMut(&DirItem, ArenaPtr) -> bool,
    {
        let base_arena = self.arena_base_ptr();
        let overflow_arena = self.arena_overflow_ptr();
        let base_dirs_count = self.base_dirs_count;

        let mut removed = 0usize;
        for (idx, dir) in self.dirs.iter_mut().enumerate() {
            if dir.is_deleted() {
                continue;
            }
            let arena = if idx < base_dirs_count {
                base_arena
            } else {
                overflow_arena
            };
            if predicate(dir, arena) && dir.set_deleted(true) {
                removed += 1;
            }
        }
        self.live_dirs_count -= removed;
    }

    /// Restores a dir to the live state (file appeared under it again).
    fn revive_dir(&mut self, dir_idx: u32) {
        if let Some(dir) = self.dirs.get_mut(dir_idx as usize)
            && dir.set_deleted(false)
        {
            self.live_dirs_count += 1;
        }
    }

    /// Finds the dir index for a '/'-canonical relative dir path
    /// (with trailing '/', empty string for the base dir itself).
    fn find_dir_index(&self, dir_rel: &str) -> Option<usize> {
        let arena = self.arena_base_ptr();
        let mut dir_buf = [0u8; crate::simd_path::PATH_BUF_SIZE];
        if let Ok(idx) = self.dirs[..self.base_dirs_count]
            .binary_search_by(|d| d.read_relative_path(arena, &mut dir_buf).cmp(dir_rel))
        {
            return Some(idx);
        }

        // Watcher-appended region: unsorted, small (bounded by overflow cap).
        let overflow_arena = self.arena_overflow_ptr();
        self.dirs[self.base_dirs_count..]
            .iter()
            .position(|d| d.read_relative_path(overflow_arena, &mut dir_buf) == dir_rel)
            .map(|pos| self.base_dirs_count + pos)
    }

    /// Finds or appends the DirItem for `dir_rel`, returning its index.
    /// `None` when the dir table's overflow capacity is exhausted.
    fn find_or_add_dir(&mut self, dir_rel: &str) -> Option<u32> {
        if let Some(idx) = self.find_dir_index(dir_rel) {
            return Some(idx as u32);
        }

        let builder = self.overflow_builder.get_or_insert_with(|| {
            crate::simd_path::ChunkedPathStoreBuilder::new(MAX_OVERFLOW_FILES)
        });
        let chunked = builder.add_dir_immediate(dir_rel);

        let last_seg = if dir_rel.is_empty() {
            0
        } else {
            let trimmed = dir_rel.trim_end_matches(std::path::is_separator);
            trimmed
                .rfind(std::path::is_separator)
                .map(|i| i + 1)
                .unwrap_or(0) as u16
        };

        let idx = self.dirs.len();
        if !self.dirs.push(DirItem::new_overflow(chunked, last_seg)) {
            return None;
        }
        self.live_dirs_count += 1;
        Some(idx as u32)
    }
}

impl FileItem {
    pub fn new(path: PathBuf, base_path: &Path, git_status: Option<Status>) -> (Self, String) {
        let metadata = std::fs::metadata(&path).ok();
        Self::new_with_metadata(path, base_path, git_status, metadata.as_ref())
    }

    /// Create a FileItem using pre-fetched metadata to avoid a redundant stat syscall.
    /// Returns `(FileItem, relative_path)`. The FileItem's `path` field is
    /// empty; callers must populate it via `set_path` or `build_chunked_path_store_and_assign`.
    fn new_with_metadata(
        path: PathBuf,
        base_path: &Path,
        git_status: Option<Status>,
        metadata: Option<&std::fs::Metadata>,
    ) -> (Self, String) {
        let path_buf = pathdiff::diff_paths(&path, base_path).unwrap_or_else(|| path.clone());
        // The index is '/'-canonical on every platform; fold native separators.
        let relative_path =
            crate::path_utils::to_canonical_slashes(&path_buf.to_string_lossy()).into_owned();

        let (size, modified) = match metadata {
            Some(metadata) => {
                let size = metadata.len();
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs());

                (size, modified)
            }
            None => (0, 0),
        };

        let is_binary = is_known_binary_extension(&path);

        let filename_start = relative_path
            .rfind(std::path::is_separator)
            .map(|i| i + 1)
            .unwrap_or(0) as u16;

        let item = Self::new_raw(filename_start, size, modified, git_status, is_binary);
        (item, relative_path)
    }

    /// Create a FileItem with an empty ChunkedString from a path on disk.
    ///
    /// Returns `(file_item, relative_path_string)`. The relative path must be
    /// kept alongside the FileItem until `build_chunked_path_store_and_assign`
    /// populates each item's `path` field from the shared arena.
    pub fn new_from_walk(
        path: &Path,
        base_path: &Path,
        git_status: Option<Status>,
        metadata: Option<&std::fs::Metadata>,
    ) -> (Self, String) {
        let (size, modified) = match metadata {
            Some(metadata) => {
                let size = metadata.len();
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs());
                (size, modified)
            }
            None => (0, 0),
        };

        Self::new_from_walk_parts(path, base_path, git_status, size, modified)
    }

    /// Like [`Self::new_from_walk`] but takes already-extracted size and
    /// modification time (Unix seconds) instead of a `std::fs::Metadata`.
    /// Used by the zlob walker backend, which fetches metadata in bulk.
    pub fn new_from_walk_parts(
        path: &Path,
        base_path: &Path,
        git_status: Option<Status>,
        size: u64,
        modified: u64,
    ) -> (Self, String) {
        let is_binary = is_known_binary_extension(path);

        let rel = pathdiff::diff_paths(path, base_path).unwrap_or_else(|| path.to_path_buf());
        // The index is '/'-canonical on every platform; fold native separators.
        let rel_str = crate::path_utils::to_canonical_slashes(&rel.to_string_lossy()).into_owned();
        let fname_offset = rel_str
            .rfind(std::path::is_separator)
            .map(|i| i + 1)
            .unwrap_or(0) as u16;

        let item = Self::new_raw(fname_offset, size, modified, git_status, is_binary);
        (item, rel_str)
    }

    /// Zlob-walker fast path: skip the `pathdiff::diff_paths` PathBuf alloc by
    /// taking the already-relative slice and the basename-offset that zlob's
    /// scanner computed during traversal. ~80–120 ms saved on a chromium scan
    /// (500k entries × one fewer alloc + no component walk).
    ///
    /// `relative_path` is root-relative bytes; `basename_offset` is the byte
    /// offset where the basename begins (e.g. zlob's `entry.path_bytes().len()
    /// - entry.file_name().as_os_str().as_encoded_bytes().len()` minus the
    /// `relative_offset`).
    pub fn new_from_walk_bytes(
        path: &Path,
        relative_path: &[u8],
        basename_offset: u16,
        git_status: Option<Status>,
        size: u64,
        modified: u64,
    ) -> (Self, String) {
        let is_binary = is_known_binary_extension(path);
        // SAFETY-ish: paths on macOS/Linux are bytes; lossy conversion mirrors
        // the existing `to_string_lossy()` behavior on non-UTF8 names.
        let decoded = String::from_utf8_lossy(relative_path).into_owned();
        // The caller's offset indexes the raw bytes; re-measure it against the
        // decoded string so it never lands inside a U+FFFD (#799).
        let dir_bytes = relative_path
            .get(..basename_offset as usize)
            .unwrap_or(relative_path);
        let basename_offset = if std::str::from_utf8(dir_bytes).is_ok() {
            basename_offset
        } else {
            String::from_utf8_lossy(dir_bytes).len() as u16
        };
        let item = Self::new_raw(basename_offset, size, modified, git_status, is_binary);
        (item, decoded)
    }

    pub(crate) fn update_frecency_scores(
        &mut self,
        tracker: &FrecencyTracker,
        arena: ArenaPtr,
        base_path: &Path,
    ) -> Result<(), Error> {
        let mut abs_buf = [0u8; crate::simd_path::PATH_BUF_SIZE];
        let abs = self.write_absolute_path(arena, base_path, &mut abs_buf);
        self.access_frecency_score = tracker.get_access_score(abs) as i16;
        self.modification_frecency_score =
            tracker.get_modification_score(self.modified, self.git_status) as i16;

        Ok(())
    }
}

/// Options for creating a [`FilePicker`].
pub struct FilePickerOptions {
    pub base_path: String,
    /// Explicit cache budget. When `None`, the budget is auto-computed from
    /// the repo size after the initial scan completes.
    pub cache_budget: Option<ContentCacheBudget>,
    /// When `false` no background watcher will be created
    pub watch: bool,
    /// Follow symbolic links during file indexing
    pub follow_symlinks: bool,
    /// Allow indexing the filesystem root (`/`)
    pub enable_fs_root_scanning: bool,
    /// Allow indexing the user's home directory. Off by default for the same
    /// reason as `enable_fs_root_scanning`
    pub enable_home_dir_scanning: bool,
    /// Ranking boost for files that participated in recent commits of the
    /// current branch. Enabled with default limits unless overridden.
    pub git_recency: GitRecencyConfig,
}

impl Default for FilePickerOptions {
    fn default() -> Self {
        Self {
            base_path: ".".into(),
            cache_budget: None,
            watch: true,
            follow_symlinks: false,
            enable_fs_root_scanning: false,
            enable_home_dir_scanning: false,
            git_recency: GitRecencyConfig::default(),
        }
    }
}

pub struct FilePicker {
    pub base_path: PathBuf,
    sync_data: FileSync,
    classification_owner: Option<WeakFilePicker>,
    pub(crate) signals: ScanSignals,
    /// Conservative continuation epoch: every shared mutable access invalidates
    /// live content offsets, including no-op writes. Never reset by a rescan.
    index_version: u64,
    pub(crate) background_watcher: Option<BackgroundWatcher>,
    /// Single serialized writer for all git-status updates (scan, watcher,
    /// FFI). Owned by the picker so it exists before the first scan; its
    /// consumer thread is spawned lazily once a git workdir is discovered.
    pub(crate) git_status_worker: Arc<crate::git_status_worker::GitStatusWorker>,
    cache_budget: Arc<ContentCacheBudget>,
    has_explicit_cache_budget: bool,
    scanned_files_count: Arc<AtomicUsize>,
    watch: bool,
    follow_symlinks: bool,
    enable_fs_root_scanning: bool,
    enable_home_dir_scanning: bool,
    git_recency_config: GitRecencyConfig,
    trace_span: tracing::Span,
    trace_id: String,
}

impl std::fmt::Debug for FilePicker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilePicker")
            .field("base_path", &self.base_path)
            .field("sync_data", &self.sync_data)
            .field(
                "is_scanning",
                &self.signals.scanning.load(Ordering::Relaxed),
            )
            .field(
                "scanned_files_count",
                &self.scanned_files_count.load(Ordering::Relaxed),
            )
            .finish_non_exhaustive()
    }
}

impl FFFStringStorage for &FilePicker {
    #[inline]
    fn arena_for(&self, file: &FileItem) -> crate::simd_path::ArenaPtr {
        self.sync_data.arena_for_file(file)
    }

    #[inline]
    fn base_arena(&self) -> crate::simd_path::ArenaPtr {
        self.sync_data.arena_base_ptr()
    }

    #[inline]
    fn overflow_arena(&self) -> crate::simd_path::ArenaPtr {
        self.sync_data.arena_overflow_ptr()
    }
}

impl FilePicker {
    pub fn base_path(&self) -> &Path {
        &self.base_path
    }

    pub fn has_git_repo(&self) -> bool {
        self.sync_data.git_workdir.is_some()
    }

    /// Ignore rules from the last walk, reused by the background watcher.
    /// None when no ignore files were present.
    pub(crate) fn ignore_rules(&self) -> Option<Arc<crate::walk::WalkIgnoreRules>> {
        self.sync_data.ignore_rules.clone()
    }

    pub fn watch_enabled(&self) -> bool {
        self.watch
    }

    pub fn is_watcher_ready(&self) -> bool {
        self.background_watcher
            .as_ref()
            .is_some_and(|watcher| watcher.is_healthy())
    }

    pub fn follows_symlinks(&self) -> bool {
        self.follow_symlinks
    }

    pub fn fs_root_scanning_enabled(&self) -> bool {
        self.enable_fs_root_scanning
    }

    pub fn home_dir_scanning_enabled(&self) -> bool {
        self.enable_home_dir_scanning
    }

    pub fn git_recency_config(&self) -> GitRecencyConfig {
        self.git_recency_config
    }

    pub fn trace_id(&self) -> &str {
        &self.trace_id
    }

    pub fn trace_span(&self) -> tracing::Span {
        self.trace_span.clone()
    }

    pub fn cache_budget(&self) -> &ContentCacheBudget {
        &self.cache_budget
    }

    pub fn get_file_mut(&mut self, index: usize) -> Option<(ArenaPtr, &mut FileItem)> {
        self.sync_data.get_file_mut(index)
    }

    /// Absolute path to the repository root if the indexed tree lives
    /// inside a git working directory. `None` for non-git bases.
    pub fn git_root(&self) -> Option<&Path> {
        self.sync_data.git_workdir.as_deref()
    }

    pub fn has_explicit_cache_budget(&self) -> bool {
        self.has_explicit_cache_budget
    }

    pub fn set_cache_budget(&mut self, budget: ContentCacheBudget) {
        self.cache_budget = Arc::new(budget);
    }

    /// Get all indexed files sorted by path.
    /// Note: Files are stored sorted by PATH for efficient insert/remove.
    /// For frecency-sorted results, use search() which sorts matched results.
    pub fn get_files(&self) -> &[FileItem] {
        self.sync_data.files()
    }

    /// Count of live (non-tombstoned) files. O(1).
    #[inline]
    pub fn live_file_count(&self) -> usize {
        self.sync_data.live_count
    }

    pub fn get_overflow_files(&self) -> &[FileItem] {
        self.sync_data.overflow_files()
    }

    /// Get the directory table (sorted by path).
    pub fn get_dirs(&self) -> &[DirItem] {
        &self.sync_data.dirs
    }

    /// Actual heap bytes used: (chunked_path_store, 0, 0).
    /// The second element is 0 because leaked overflow stores aren't tracked.
    pub fn arena_bytes(&self) -> (usize, usize, usize) {
        let chunked = self
            .sync_data
            .chunked_paths
            .as_ref()
            .map_or(0, |s| s.heap_bytes());

        (chunked, 0, 0)
    }

    #[tracing::instrument(level = "debug", skip_all)]
    pub(crate) fn for_each_dir(&self, mut f: impl FnMut(&Path) -> ControlFlow<()>) {
        let dir_table = &self.sync_data.dirs;
        let base = self.base_path.as_path();

        if !dir_table.is_empty() {
            let arena = self.arena_base_ptr();
            let overflow_arena = self.sync_data.arena_overflow_ptr();
            let mut path_buf = PathBuf::with_capacity(crate::simd_path::PATH_BUF_SIZE);
            let mut prev_relative_path = String::new();

            let mut scratch_buf = [0u8; crate::simd_path::PATH_BUF_SIZE];
            for dir_item in dir_table.iter() {
                if dir_item.is_deleted() {
                    continue;
                }
                let item_arena = if dir_item.is_overflow() {
                    overflow_arena
                } else {
                    arena
                };
                let full_relative_path = dir_item.read_relative_path(item_arena, &mut scratch_buf);
                let relative_path = full_relative_path.trim_end_matches(std::path::is_separator);

                if relative_path.is_empty() {
                    // Files directly under base_path
                    prev_relative_path.clear();
                    continue;
                }

                let mut i = common_dir_prefix_len(&prev_relative_path, relative_path);
                // If we stopped on a separator, skip it — we want to start
                // emitting at the first unseen segment, not re-emit the
                // already-emitted prefix path.
                if i < relative_path.len()
                    && std::path::is_separator(relative_path.as_bytes()[i] as char)
                {
                    i += 1;
                }

                // Walk the suffix of `relative_path` one segment at a time, emitting
                // each previously unseen ancestor up to and including `relative_path`.
                while i < relative_path.len() {
                    let next_sep = relative_path[i..]
                        .find(std::path::is_separator)
                        .map(|off| i + off)
                        .unwrap_or(relative_path.len());
                    let ancestor_rel = &relative_path[..next_sep];

                    path_buf.clear();
                    path_buf.push(base);
                    path_buf.push(ancestor_rel);

                    // we can't really emit iterator here unfortunately
                    if matches!(f(path_buf.as_path()), ControlFlow::Break(())) {
                        return;
                    }

                    i = next_sep + 1;
                }

                prev_relative_path.clear();
                prev_relative_path.push_str(relative_path);
            }
            return;
        }

        // fallback that should never be happening, but it is possible to get the file
        // path from the absolute path using components api as well:
        let files = self.sync_data.files();
        let arena = self.arena_base_ptr();
        let mut current = self.base_path.clone();
        let mut path_buf = [0u8; PATH_BUF_SIZE];

        for file in files {
            let abs = file.write_absolute_path(arena, base, &mut path_buf);
            let Some(parent) = abs.parent() else {
                continue;
            };
            if parent == current.as_path() {
                continue;
            }

            while current.as_path() != base && !parent.starts_with(&current) {
                current.pop();
            }

            let Ok(remainder) = parent.strip_prefix(&current) else {
                continue;
            };
            for component in remainder.components() {
                current.push(component);
                if matches!(f(current.as_path()), ControlFlow::Break(())) {
                    return;
                }
            }
        }
    }

    /// Create a new FilePicker from options.
    /// Always prefer new_with_shared_state for the consumer application, use this only if you know
    /// what you are doing. This won't spawn the backgraound watcher and won't walk the file tree.
    pub fn new(options: FilePickerOptions) -> Result<Self, Error> {
        crate::git::tune_libgit2_for_local_reads();

        let path = PathBuf::from(&options.base_path);
        if !path.exists() {
            error!("Base path does not exist: {}", options.base_path);
            return Err(Error::InvalidPath(path));
        }
        // Relative bases (".", "sub/dir") are resolved against the cwd so
        // they can be compared with the absolute paths reported by the OS
        // watcher. Purely lexical: no symlinks are resolved. The
        // `components()` pass drops interior `.` segments ("/cwd/.").
        let path = if path.is_relative() {
            std::env::current_dir()
                .map(|cwd| cwd.join(&path).components().collect())
                .unwrap_or(path)
        } else {
            path
        };
        if path.parent().is_none() && !options.enable_fs_root_scanning {
            error!("Refusing to index filesystem root: {}", path.display());
            return Err(Error::FilesystemRoot(path));
        }
        if !options.enable_home_dir_scanning
            && Some(path.as_os_str()) == dirs::home_dir().as_ref().map(|p| p.as_os_str())
        {
            error!("Refusing to index home directory: {}", path.display());
            return Err(Error::FilesystemRoot(path));
        }

        let has_explicit_budget = options.cache_budget.is_some();
        let initial_budget = options.cache_budget.unwrap_or_default();

        let trace_id = crate::log::generate_trace_id();
        let trace_span = crate::log::trace_span(&trace_id, "picker");

        Ok(FilePicker {
            background_watcher: None,
            git_status_worker: crate::git_status_worker::GitStatusWorker::new(),
            base_path: path,
            cache_budget: Arc::new(initial_budget),
            has_explicit_cache_budget: has_explicit_budget,
            signals: crate::scan::ScanSignals::default(),
            index_version: 1,
            scanned_files_count: Arc::new(AtomicUsize::new(0)),
            sync_data: FileSync::new(),
            classification_owner: None,
            watch: options.watch,
            follow_symlinks: options.follow_symlinks,
            enable_fs_root_scanning: options.enable_fs_root_scanning,
            enable_home_dir_scanning: options.enable_home_dir_scanning,
            git_recency_config: options.git_recency,
            trace_span,
            trace_id,
        })
    }

    /// Publish a picker with a reserved scan, then start background indexing
    /// and filesystem monitoring. This is the default entry point.
    pub fn new_with_shared_state(
        shared_picker: SharedFilePicker,
        shared_frecency: SharedFrecency,
        options: FilePickerOptions,
    ) -> Result<(), Error> {
        let mut picker = Self::new(options)?;
        picker.classification_owner = Some(shared_picker.weaken());

        info!(
            "Spawning background threads: base_path={}",
            picker.base_path.display()
        );

        let watch = picker.watch;
        let follow_symlinks = picker.follow_symlinks;
        let enable_fs_root_scanning = picker.enable_fs_root_scanning;
        let enable_home_dir_scanning = picker.enable_home_dir_scanning;

        let signals = picker.scan_signals();
        let scanned_files_counter = picker.scanned_files_counter();
        let path = picker.base_path.clone();
        let trace_span = picker.trace_span.clone();

        // Construct the owning reservation before publication, so a waiter
        // cannot observe an idle picker between publication and scheduling.
        let job = ScanJob::new_initial(
            shared_picker.clone(),
            shared_frecency,
            path,
            signals,
            scanned_files_counter,
            trace_span,
            ScanConfig {
                watch,
                auto_cache_budget: true,
                follow_symlinks,
                enable_fs_root_scanning,
                enable_home_dir_scanning,
            },
        );
        {
            let mut guard = shared_picker.write()?;
            *guard = Some(picker);
            // Dropping the old picker cancels its background work.
        }
        job.spawn();

        Ok(())
    }

    /// Synchronous fixture scan — populates `self` without background threads.
    ///
    /// Use this when you need direct access to the picker without shared state:
    /// ```ignore
    /// let mut picker = FilePicker::new(options)?;
    /// picker.collect_files()?;
    /// // picker.get_files() is now populated
    /// ```
    #[cfg(test)]
    pub fn collect_files(&mut self) -> Result<(), Error> {
        self.signals.scanning.store(true, Ordering::Relaxed);
        self.scanned_files_count.store(0, Ordering::Relaxed);

        let git_workdir = FileSync::discover_git_workdir(&self.base_path);
        let git_handle = git_workdir.clone().map(FileSync::spawn_git_status);

        let empty_frecency = SharedFrecency::default();
        let sync = FileSync::walk_filesystem(
            &self.base_path,
            git_workdir,
            &self.scanned_files_count,
            &empty_frecency,
            self.follow_symlinks,
        )?;

        self.sync_data = sync;

        if !self.has_explicit_cache_budget {
            let file_count = self.sync_data.files().len();
            self.cache_budget = Arc::new(ContentCacheBudget::new_for_repo(file_count));
        } else {
            self.cache_budget.reset();
        }

        if let Some(handle) = git_handle
            && let Ok(Some(git_cache)) = handle.join()
        {
            let mut path_buf = [0u8; crate::simd_path::PATH_BUF_SIZE];

            let arena = self.arena_base_ptr();
            for file in self.sync_data.files.iter_mut() {
                file.git_status = git_cache.lookup_status(file.write_absolute_path(
                    arena,
                    &self.base_path,
                    &mut path_buf,
                ));
            }
        }

        if let Some(workdir) = self.sync_data.git_workdir.clone()
            && let Ok(repo) = Repository::open(&workdir)
                .inspect_err(|e| debug!(?e, ?workdir, "git recency: failed to open repo"))
        {
            let recency =
                git_recency::compute_git_recency(&repo, &self.git_recency_config, &self.base_path);
            self.apply_git_recency(recency.as_ref());
        }

        self.signals.scanning.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// Perform fuzzy search on files with a pre-parsed query.
    ///
    /// The query should be parsed using [`crate::FFFQuery`] before calling
    /// this function. If a [`crate::QueryTracker`] is provided, the search will
    /// automatically look up the last selected file for this query and boost it
    #[tracing::instrument(skip_all, name = "Fuzzy file search", fields(query = query.raw_query))]
    pub fn fuzzy_search<'q>(
        &self,
        query: &'q FFFQuery<'q>,
        query_tracker: Option<&QueryTracker>,
        options: FuzzySearchOptions<'q>,
    ) -> SearchResult<'_> {
        let files = self.get_files();
        let max_threads = if options.max_threads == 0 {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
        } else {
            options.max_threads
        };

        debug!(
            raw_query = ?query.raw_query,
            pagination = ?options.pagination,
            ?max_threads,
            current_file = ?options.current_file,
            "Fuzzy search",
        );

        let total_files = self.live_file_count();
        let location = query.location;

        // Get effective query for max_typos calculation (without location suffix)
        let effective_query = match &query.fuzzy_query {
            fff_query_parser::FuzzyQuery::Text(t) => *t,
            fff_query_parser::FuzzyQuery::Parts(parts) if !parts.is_empty() => parts[0],
            _ => query.raw_query.trim(),
        };

        // small queries with a large number of results can match absolutely everything
        let max_typos = (effective_query.len() as u16 / 4).clamp(2, 6);
        // Look up the last file selected for this query (combo-boost scoring)
        let last_same_query_entry =
            query_tracker
                .zip(options.project_path)
                .and_then(|(tracker, project_path)| {
                    tracker
                        .get_last_query_entry(
                            query.raw_query,
                            project_path,
                            options.min_combo_count,
                        )
                        .ok()
                        .flatten()
                });

        let context = ScoringContext {
            query,
            max_typos,
            max_threads,
            project_path: options.project_path,
            current_file: options.current_file,
            last_same_query_match: last_same_query_entry,
            combo_boost_score_multiplier: options.combo_boost_score_multiplier,
            min_combo_count: options.min_combo_count,
            pagination: options.pagination,
        };

        let time = std::time::Instant::now();

        let base_arena = self.sync_data.arena_base_ptr();
        let overflow_arena = self.sync_data.arena_overflow_ptr();

        let (items, scores, total_matched) = fuzzy_match_and_score_files(
            files,
            &context,
            self.sync_data.base_count,
            base_arena,
            overflow_arena,
        );
        info!(
            ?query,
            completed_in = ?time.elapsed(),
            total_matched,
            returned_count = items.len(),
            pagination = ?options.pagination,
            "Fuzzy search completed",
        );

        SearchResult {
            items,
            scores,
            total_matched,
            total_files,
            location,
        }
    }

    /// Perform fuzzy search on indexed directories.
    ///
    /// Returns directories ranked by fuzzy match quality + frecency.
    pub fn fuzzy_search_directories<'q>(
        &self,
        query: &'q FFFQuery<'q>,
        options: FuzzySearchOptions<'q>,
    ) -> DirSearchResult<'_> {
        let dirs = self.get_dirs();
        let max_threads = if options.max_threads == 0 {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
        } else {
            options.max_threads
        };

        let total_dirs = self.sync_data.live_dirs_count;

        let effective_query = match &query.fuzzy_query {
            fff_query_parser::FuzzyQuery::Text(t) => *t,
            fff_query_parser::FuzzyQuery::Parts(parts) if !parts.is_empty() => parts[0],
            _ => query.raw_query.trim(),
        };

        let max_typos = (effective_query.len() as u16 / 4).clamp(2, 6);

        let context = ScoringContext {
            query,
            max_typos,
            max_threads,
            project_path: options.project_path,
            current_file: options.current_file,
            last_same_query_match: None,
            combo_boost_score_multiplier: 0,
            min_combo_count: 0,
            pagination: options.pagination,
        };

        let arena = self.sync_data.arena_base_ptr();
        let overflow_arena = self.sync_data.arena_overflow_ptr();
        let time = std::time::Instant::now();

        let (items, scores, total_matched) =
            crate::score::fuzzy_match_and_score_dirs(dirs, &context, arena, overflow_arena);

        info!(
            ?query,
            completed_in = ?time.elapsed(),
            total_matched,
            returned_count = items.len(),
            "Directory search completed",
        );

        DirSearchResult {
            items,
            scores,
            total_matched,
            total_dirs,
        }
    }

    /// Perform a mixed fuzzy search across both files and directories.
    ///
    /// Returns a single flat list where files and directories are interleaved
    /// by total score in descending order.
    ///
    /// If the raw query ends with a path separator (`/`), only directories
    /// are searched — files are skipped entirely. The caller should parse the
    /// query with `DirSearchConfig` so that trailing `/` is kept as fuzzy
    /// text instead of becoming a `PathSegment` constraint.
    pub fn fuzzy_search_mixed<'q>(
        &self,
        query: &'q FFFQuery<'q>,
        query_tracker: Option<&QueryTracker>,
        options: FuzzySearchOptions<'q>,
    ) -> MixedSearchResult<'_> {
        let location = query.location;
        let page_offset = options.pagination.offset;
        let page_limit = if options.pagination.limit > 0 {
            options.pagination.limit
        } else {
            100
        };

        let dirs_only =
            query.raw_query.ends_with(std::path::MAIN_SEPARATOR) || query.raw_query.ends_with('/');

        // Run file search and dir search with no pagination (we merge then paginate).
        let internal_limit = page_offset.saturating_add(page_limit).saturating_mul(2);

        let dir_options = FuzzySearchOptions {
            pagination: PaginationArgs {
                offset: 0,
                limit: internal_limit,
            },
            ..options
        };
        let dir_results = self.fuzzy_search_directories(query, dir_options);

        if dirs_only {
            let total_matched = dir_results.total_matched;
            let total_dirs = dir_results.total_dirs;

            let mut merged: Vec<(MixedItemRef<'_>, Score)> =
                Vec::with_capacity(dir_results.items.len());
            for (dir, score) in dir_results.items.into_iter().zip(dir_results.scores) {
                merged.push((MixedItemRef::Dir(dir), score));
            }

            if page_offset >= merged.len() {
                return MixedSearchResult {
                    items: vec![],
                    scores: vec![],
                    total_matched,
                    total_files: self.live_file_count(),
                    total_dirs,
                    location,
                };
            }

            let end = (page_offset + page_limit).min(merged.len());
            let page = merged.drain(page_offset..end);
            let (items, scores): (Vec<_>, Vec<_>) = page.unzip();

            return MixedSearchResult {
                items,
                scores,
                total_matched,
                total_files: self.live_file_count(),
                total_dirs,
                location,
            };
        }

        let file_options = FuzzySearchOptions {
            pagination: PaginationArgs {
                offset: 0,
                limit: internal_limit,
            },
            ..options
        };
        let file_results = self.fuzzy_search(query, query_tracker, file_options);

        // Merge by score descending.
        let total_matched = file_results.total_matched + dir_results.total_matched;
        let total_files = file_results.total_files;
        let total_dirs = dir_results.total_dirs;

        let mut merged: Vec<(MixedItemRef<'_>, Score)> =
            Vec::with_capacity(file_results.items.len() + dir_results.items.len());

        for (file, score) in file_results.items.into_iter().zip(file_results.scores) {
            merged.push((MixedItemRef::File(file), score));
        }
        for (dir, score) in dir_results.items.into_iter().zip(dir_results.scores) {
            merged.push((MixedItemRef::Dir(dir), score));
        }

        // Sort merged results by total score descending.
        merged.sort_unstable_by_key(|b| std::cmp::Reverse(b.1.total));

        // Paginate.
        if page_offset >= merged.len() {
            return MixedSearchResult {
                items: vec![],
                scores: vec![],
                total_matched,
                total_files,
                total_dirs,
                location,
            };
        }

        let end = (page_offset + page_limit).min(merged.len());
        let page = merged.drain(page_offset..end);
        let (items, scores): (Vec<_>, Vec<_>) = page.unzip();

        MixedSearchResult {
            items,
            scores,
            total_matched,
            total_files,
            total_dirs,
            location,
        }
    }

    /// Glob search: filter indexed files by a single glob pattern, rank by
    /// frecency, and paginate. Bypasses the regular query parser entirely —
    /// useful when callers already have a literal glob (`*.rs`, `**/*.test.ts`)
    /// and want neither fuzzy matching nor multi-token constraint parsing.
    ///
    /// Pipeline: `apply_constraints(Glob) → score_filtered_by_frecency → sort_and_paginate`.
    /// Same ranking semantics as `fuzzy_search` when the fuzzy query is empty.
    pub fn glob<'p>(
        &'p self,
        pattern: &'p str,
        options: FuzzySearchOptions<'p>,
    ) -> SearchResult<'p> {
        let query = FFFQuery {
            raw_query: pattern,
            constraints: vec![fff_query_parser::Constraint::Glob(pattern)],
            fuzzy_query: fff_query_parser::FuzzyQuery::Empty,
            location: None,
        };

        // `fuzzy_search` short-circuits to `score_filtered_by_frecency` when
        // `fuzzy_query` is `Empty`, then runs the same `sort_and_paginate`
        // path. Reusing it keeps the ranking guarantees identical without
        // exposing the private scoring helpers.
        self.fuzzy_search(&query, None, options)
    }

    /// Search an explicit content pattern and already-parsed file constraints.
    /// This entry does not infer filenames, split/trim the pattern,
    /// decode escapes, or retry without constraints. Invalid regex syntax still
    /// falls back to the unchanged literal pattern with a compilation error.
    pub fn grep_pattern(
        &self,
        pattern: &str,
        constraints: &[fff_query_parser::Constraint<'_>],
        options: &GrepSearchOptions,
    ) -> GrepResult<'_> {
        let arena = self.arena_base_ptr();
        let overflow_arena = self.sync_data.arena_overflow_ptr();
        let cancel = options
            .abort_signal
            .as_deref()
            .unwrap_or(&self.signals.cancelled);

        SEARCH_THREAD_POOL.install(|| {
            crate::grep::grep_search_pattern(
                self.get_files(),
                pattern,
                constraints,
                options,
                self.cache_budget(),
                cancel,
                &self.base_path,
                arena,
                overflow_arena,
            )
        })
    }

    /// Multi-pattern grep search, reporting automaton construction failures.
    pub fn multi_grep(
        &self,
        patterns: &[&str],
        constraints: &[fff_query_parser::Constraint<'_>],
        options: &GrepSearchOptions,
    ) -> Result<GrepResult<'_>, aho_corasick::BuildError> {
        let arena = self.arena_base_ptr();
        let overflow_arena = self.sync_data.arena_overflow_ptr();
        let cancel = options
            .abort_signal
            .as_deref()
            .unwrap_or(&self.signals.cancelled);

        SEARCH_THREAD_POOL.install(|| {
            multi_grep_search(
                self.get_files(),
                patterns,
                constraints,
                options,
                self.cache_budget(),
                cancel,
                &self.base_path,
                arena,
                overflow_arena,
            )
        })
    }

    pub(crate) fn advance_index_version(&mut self) {
        self.index_version = self.index_version.saturating_add(1);
    }

    pub fn scan_error(&self) -> Option<String> {
        self.signals.error.lock().clone()
    }

    pub fn git_status_error(&self) -> Option<String> {
        if self.has_git_repo() {
            self.git_status_worker.error()
        } else {
            None
        }
    }

    pub fn get_scan_progress(&self) -> ScanProgress {
        let scanned_count = self.scanned_files_count.load(Ordering::Relaxed);
        let is_scanning = self.signals.scanning.load(Ordering::Acquire);
        let scan_error = self.scan_error();

        ScanProgress {
            index_version: self.index_version,
            git_status_error: self.git_status_error(),
            scanned_files_count: scanned_count,
            is_scanning,
            is_watcher_ready: self.is_watcher_ready(),
            is_ready: !is_scanning
                && scan_error.is_none()
                && !self.signals.rescan_pending.load(Ordering::Acquire)
                && !self.is_post_scan_active()
                && (!self.watch || self.is_watcher_ready()),
            scan_error,
        }
    }

    pub(crate) fn scan_signals(&self) -> crate::scan::ScanSignals {
        self.signals.clone()
    }

    pub(crate) fn scanned_files_counter(&self) -> Arc<AtomicUsize> {
        Arc::clone(&self.scanned_files_count)
    }

    /// Reserve a post-scan job before publishing scanning=false. The token
    /// contains no live FileItem references; each IO batch copies its inputs
    /// under a short picker read lock and validates identity/revision on return.
    pub(crate) fn post_scan_snapshot(&self) -> Option<PostScanSnapshot> {
        if self
            .signals
            .post_scan_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            tracing::error!("Can not acquire post scan snapshot, someone already acquired it");
            return None;
        }

        Some(PostScanSnapshot {
            identity: Arc::clone(&self.sync_data.identity),
            base_count: self.sync_data.base_count,
            post_scan_flag: Arc::clone(&self.signals.post_scan_active),
        })
    }

    fn binary_task(&self, index: usize) -> Option<BinaryTask> {
        let file = self.sync_data.files.get(index)?;
        if file.is_deleted() {
            return None;
        }
        Some(BinaryTask {
            identity: Arc::clone(&self.sync_data.identity),
            index,
            revision: file.content_revision,
            input: BinaryInput::new(file.absolute_path(self, &self.base_path), file.size),
        })
    }

    pub(crate) fn binary_batch(
        &self,
        snapshot: &PostScanSnapshot,
        range: std::ops::Range<usize>,
    ) -> Vec<BinaryTask> {
        if !Arc::ptr_eq(&snapshot.identity, &self.sync_data.identity) {
            return Vec::new();
        }
        range.filter_map(|index| self.binary_task(index)).collect()
    }

    fn classification_target(&self, task: &BinaryTask) -> Option<&FileItem> {
        if self.signals.cancelled.load(Ordering::Acquire)
            || !Arc::ptr_eq(&task.identity, &self.sync_data.identity)
        {
            return None;
        }
        self.sync_data
            .files
            .get(task.index)
            .filter(|file| !file.is_deleted() && file.content_revision == task.revision)
    }

    pub(crate) fn apply_classification(&mut self, classified: ClassifiedFile) {
        if let Some(binary) = classified.binary
            && let Some(file) = self.classification_target(&classified.task)
        {
            file.set_binary(binary);
        }
    }

    fn classify_file(&mut self, index: usize) {
        let Some(task) = self.binary_task(index) else {
            return;
        };
        let cancelled = Arc::clone(&self.signals.cancelled);
        if let Some(owner) = self.classification_owner.clone() {
            BACKGROUND_THREAD_POOL.spawn(move || {
                // Busy queues can retain old revisions or an entire replaced
                // index. Reject those before IO, but release the read guard
                // before opening the file and revalidate again when applying.
                let current = owner.upgrade().is_some_and(|shared| {
                    shared.read().ok().is_some_and(|guard| {
                        guard
                            .as_ref()
                            .is_some_and(|picker| picker.classification_target(&task).is_some())
                    })
                });
                if !current {
                    return;
                }
                let classified = task.run(&cancelled);
                if !cancelled.load(Ordering::Acquire)
                    && let Some(shared) = owner.upgrade()
                    && let Ok(mut guard) = shared.write()
                    && let Some(picker) = guard.as_mut()
                {
                    picker.apply_classification(classified);
                }
            });
        } else {
            // Standalone pickers have no concurrent/shared owner. Keep their
            // synchronous API useful for the inherited unit fixtures.
            self.apply_classification(task.run(&cancelled));
        }
    }

    pub(crate) fn commit_new_sync(&mut self, sync: FileSync) {
        self.sync_data = sync;
        self.cache_budget.reset();
    }

    #[inline]
    pub(crate) fn arena_base_ptr(&self) -> ArenaPtr {
        self.sync_data.arena_base_ptr()
    }

    /// Update git statuses for files, using the provided shared frecency tracker.
    pub(crate) fn update_git_statuses(
        &mut self,
        status_cache: GitStatusCache,
        shared_frecency: &SharedFrecency,
    ) -> Result<(), Error> {
        debug!(
            statuses_count = status_cache.statuses_len(),
            "Updating git status",
        );

        let bp = self.base_path.clone();
        let frecency = shared_frecency.read()?;

        status_cache
            .into_iter()
            .try_for_each(|(path, status)| -> Result<(), Error> {
                if let Some((arena, file)) = self.get_mut_file_by_path(&path) {
                    file.git_status = Some(status);
                    if let Some(ref f) = *frecency {
                        file.update_frecency_scores(f, arena, &bp)?;
                    }
                    // Update parent dir frecency inline. `DirItem` has an
                    // interior-mutable atomic score, so `&self` access is
                    // enough — no write aliasing against Arc clones.
                    let score = file.access_frecency_score as i32;
                    let dir_idx = file.parent_dir_index as usize;
                    if let Some(dir) = self.sync_data.dirs.get(dir_idx) {
                        dir.update_frecency_if_larger(score);
                    }
                } else {
                    // Expected on sparse checkouts: git reports a status for
                    // a path that isn't materialized on disk and therefore
                    // isn't in the file index. Don't spam the log (#404).
                    debug!(?path, "Git status for path not in index, skipping");
                }
                Ok(())
            })?;

        Ok(())
    }

    // Replaces every recency score with a freshly computed set. `None` zeroes
    // them, so a vanished window (orphan HEAD, repo gone) leaves no stale boost.
    pub(crate) fn apply_git_recency(&mut self, scores: Option<&AHashMap<String, i16>>) {
        if !self.git_recency_config.enabled {
            return;
        }

        for file in self.sync_data.files.iter_mut() {
            file.git_recency_score = 0;
        }

        let Some(scores) = scores else { return };

        let mut applied = 0usize;
        for (relative_path, score) in scores {
            if let Some(index) = self.sync_data.find_by_relative_path(relative_path)
                && let Some((_, file)) = self.sync_data.get_file_mut(index)
            {
                file.git_recency_score = *score;
                applied += 1;
            }
        }

        debug!(files_scored = applied, "Git recency scores applied");
    }

    pub fn update_single_file_frecency(
        &mut self,
        file_path: impl AsRef<Path>,
        frecency_tracker: &FrecencyTracker,
    ) -> Result<(), Error> {
        let path = file_path.as_ref();

        let Some(index) = self.sync_data.find_file_index(path, &self.base_path) else {
            return Ok(());
        };

        if let Some((arena, file)) = self.sync_data.get_file_mut(index) {
            file.update_frecency_scores(frecency_tracker, arena, &self.base_path)?;

            // Update parent dir frecency inline (atomic, &self access).
            let score = file.access_frecency_score as i32;
            let dir_idx = file.parent_dir_index as usize;
            if let Some(dir) = self.sync_data.dirs.get(dir_idx) {
                dir.update_frecency_if_larger(score);
            }
        }

        Ok(())
    }

    pub fn get_file_by_path(&self, path: impl AsRef<Path>) -> Option<&FileItem> {
        self.sync_data
            .find_file_index(path.as_ref(), &self.base_path)
            .and_then(|index| self.sync_data.files().get(index))
    }

    pub fn get_mut_file_by_path(
        &mut self,
        path: impl AsRef<Path>,
    ) -> Option<(ArenaPtr, &mut FileItem)> {
        let path = path.as_ref();
        let index = self.sync_data.find_file_index(path, &self.base_path);
        index.and_then(|i| self.sync_data.get_file_mut(i))
    }

    /// Handle the event of certain file being modified or adds a neww file if it is not added
    /// If this function returns `None` it means that picker is in the invalid state, or the capacity
    /// of index is exhausted and a new rescan needs to be triggered.
    #[tracing::instrument(skip(self),level = Level::DEBUG)]
    pub fn handle_create_or_modify(&mut self, path: impl AsRef<Path> + Debug) -> Option<&FileItem> {
        let path = path.as_ref();

        if let Some(idx) = self.sync_data.find_file_index(path, &self.base_path) {
            let slot = if idx < self.sync_data.base_count {
                FileSlot::Base(idx)
            } else {
                FileSlot::Overflow(idx)
            };

            return self.handle_file_modify(path, slot);
        }

        self.add_new_file(path)
    }

    #[tracing::instrument(skip_all, fields(path = ?path), level = Level::DEBUG)]
    fn handle_file_modify(&mut self, path: &Path, slot: FileSlot) -> Option<&FileItem> {
        let pos = slot.index();

        // this is the only way to actually know if the file is on disk, we CAN NOT
        // rely on the watcher to proive the latest state of the file, do the actual check
        let metadata = match std::fs::metadata(path) {
            Ok(m) if m.is_file() => {
                self.untombstone_file(pos);

                m
            }
            _ => {
                self.tombstone_file(pos);
                return None;
            }
        };

        let (_arena, file) = self.sync_data.get_file_mut(pos)?;

        let size = metadata.len();
        let modified_time = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        file.update_metadata(&self.cache_budget, modified_time, Some(size));
        // Every content event gets a fresh classification, including previously
        // binary unknown extensions. Shared pickers perform all content IO off-lock.
        self.classify_file(pos);

        self.sync_data.files().get(pos)
    }

    /// Adds a new file to picker, if the file can not be added returns `None`
    /// which indicates that it's time to trigger a new sync
    #[tracing::instrument(skip(self))]
    pub fn add_new_file(&mut self, path: &Path) -> Option<&FileItem> {
        let metadata = std::fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let (mut file_item, rel_path) =
            FileItem::new_with_metadata(path.to_path_buf(), &self.base_path, None, Some(&metadata));

        let builder = self.sync_data.overflow_builder.get_or_insert_with(|| {
            // we know that overflow would never create more files during the file
            crate::simd_path::ChunkedPathStoreBuilder::new(MAX_OVERFLOW_FILES)
        });

        file_item.set_path(builder.add_file_immediate(&rel_path, file_item.path.filename_offset));
        file_item.set_overflow(true);

        // Keep the dir table consistent: register (or revive) the parent dir
        // so directory search reflects watcher-added files immediately.
        let dir_rel = crate::path_utils::to_canonical_slashes(
            &rel_path[..file_item.path.filename_offset as usize],
        );

        if let Some(dir_idx) = self.sync_data.find_or_add_dir(&dir_rel) {
            file_item.parent_dir_index = dir_idx;
        }
        let parent_dir = file_item.parent_dir_index;

        if !self.sync_data.files.push(file_item) {
            return None;
        }

        self.sync_data.live_count += 1;
        // Dir may have been tombstoned by an earlier removal; a new file
        // under it proves it exists again.
        self.sync_data.revive_dir(parent_dir);
        self.classify_file(self.sync_data.files.len() - 1);
        self.sync_data.files.last()
    }

    fn tombstone_file(&mut self, index: usize) {
        let file = &mut self.sync_data.files[index];
        if file.is_deleted() {
            return;
        }

        file.content_revision = file
            .content_revision
            .checked_add(1)
            .expect("content revision exhausted");
        file.set_deleted(true);
        file.invalidate_mmap(&self.cache_budget);
        file.git_status = None;

        self.sync_data.live_count -= 1;
    }

    fn untombstone_file(&mut self, index: usize) {
        let file = &mut self.sync_data.files[index];
        if !file.is_deleted() {
            return;
        }
        file.set_deleted(false);
        let parent_dir = file.parent_dir_index;

        self.sync_data.live_count += 1;
        // The path exists on disk again, so its parent dir does too.
        self.sync_data.revive_dir(parent_dir);
    }

    /// Marks file as deleted, make sure that if you call this yourself these changes can be reverted
    /// by the internal mechanics if the file actually exists on the disk, use only if you know that
    /// the file going to be disapperaed or if you do not have the watcher installed
    pub fn remove_file_by_path(&mut self, path: impl AsRef<Path>) -> bool {
        let path = path.as_ref();
        if let Some(index) = self.sync_data.find_file_index(path, &self.base_path) {
            self.tombstone_file(index);
            true
        } else {
            false
        }
    }

    pub fn remove_all_files_in_dir(&mut self, dir: impl AsRef<Path>) -> usize {
        self.remove_all_files_in_dirs(std::iter::once(dir.as_ref()))
    }

    /// Tombstones files under any of `dirs` in a single index scan.
    pub(crate) fn remove_all_files_in_dirs<'a>(
        &mut self,
        dirs: impl IntoIterator<Item = &'a Path>,
    ) -> usize {
        let mut dir_prefixes = Vec::new();
        for dir_path in dirs {
            let Some(relative_dir) = self
                .to_relative_path(dir_path)
                .map(|path| path.into_owned())
            else {
                continue;
            };

            if relative_dir.is_empty() {
                dir_prefixes.push(String::new());
            } else {
                // Stored relative paths are '/'-canonical on every platform.
                dir_prefixes.push(format!("{relative_dir}/"));
            }
        }

        if dir_prefixes.is_empty() {
            return 0;
        }

        let cache_budget = &self.cache_budget;
        let tombstoned = self.sync_data.tombstone_files_with_arena(
            |file, arena| {
                dir_prefixes
                    .iter()
                    .any(|prefix| file.relative_path_starts_with(arena, prefix))
            },
            |file, _arena| file.invalidate_mmap(cache_budget),
        );

        // The whole subtree is gone: tombstone the dirs too so directory
        // search stops surfacing them.
        let mut dir_buf = [0u8; crate::simd_path::PATH_BUF_SIZE];
        self.sync_data.tombstone_dirs_with_arena(|dir, arena| {
            let rel = dir.read_relative_path(arena, &mut dir_buf);
            dir_prefixes.iter().any(|prefix| rel.starts_with(prefix))
        });

        tombstoned
    }

    /// Use this to prevent any substantial background threads from acquiring the locks
    pub fn cancel(&self) {
        self.signals.cancelled.store(true, Ordering::Release);
    }

    /// Stop the background filesystem watcher. Non-blocking.
    pub fn stop_background_monitor(&mut self) {
        if let Some(mut watcher) = self.background_watcher.take() {
            watcher.stop();
        }
    }

    /// Quick way to check if scan is going without acquiring a lock for [Self::get_scan_progress]
    pub fn is_scan_active(&self) -> bool {
        self.signals.scanning.load(Ordering::Relaxed)
    }

    pub fn is_post_scan_active(&self) -> bool {
        self.signals.post_scan_active.load(Ordering::Acquire)
    }

    /// Convert an absolute path to a relative path string (relative to base_path).
    /// Returns None if the path doesn't start with base_path.
    fn to_relative_path<'a>(&self, path: &'a Path) -> Option<std::borrow::Cow<'a, str>> {
        if let Ok(stripped) = path.strip_prefix(&self.base_path)
            && let Some(s) = stripped.to_str()
        {
            // Callers compare against '/'-canonical stored paths.
            return Some(crate::path_utils::to_canonical_slashes(s));
        }

        None
    }
}

impl Drop for FilePicker {
    fn drop(&mut self) {
        // Cancel any in-flight ScanJob bound to this picker's signals so
        // it cannot mutate the replacement picker after a swap.
        self.signals.cancelled.store(true, Ordering::Release);
        // Wake the git-status consumer so it exits; never joined (it takes
        // the picker write lock, a blocking join here could deadlock).
        self.git_status_worker.signal_shutdown();
    }
}

#[derive(Debug, Clone, Copy)]
enum FileSlot {
    Base(usize),
    Overflow(usize),
}

impl FileSlot {
    fn index(self) -> usize {
        match self {
            FileSlot::Base(i) | FileSlot::Overflow(i) => i,
        }
    }
}

/// Job reservation and identity only; never aliases the live file storage.
pub(crate) struct PostScanSnapshot {
    identity: Arc<()>,
    pub(crate) base_count: usize,
    post_scan_flag: Arc<AtomicBool>,
}

impl Drop for PostScanSnapshot {
    fn drop(&mut self) {
        self.post_scan_flag.store(false, Ordering::Release);
    }
}

pub(crate) struct BinaryTask {
    identity: Arc<()>,
    index: usize,
    revision: u64,
    input: BinaryInput,
}

pub(crate) struct ClassifiedFile {
    task: BinaryTask,
    binary: Option<bool>,
}

impl BinaryTask {
    pub(crate) fn run(self, cancelled: &AtomicBool) -> ClassifiedFile {
        let binary = self.input.classify(cancelled, &mut scratch());
        ClassifiedFile { task: self, binary }
    }
}

/// A point-in-time snapshot of the file-scanning progress.
///
/// Returned by [`FilePicker::get_scan_progress`]. Useful for displaying
/// a progress indicator while the initial scan is running.
#[derive(Debug, Clone)]
pub struct ScanProgress {
    pub scanned_files_count: usize,
    pub is_scanning: bool,
    pub is_watcher_ready: bool,
    /// Current walk, classification, subscriptions and initial Git attempt are
    /// done, not a drain of all future watcher work. Git failures are disclosed.
    pub is_ready: bool,
    pub scan_error: Option<String>,
    pub git_status_error: Option<String>,
    pub index_version: u64,
}

impl FileSync {
    pub(crate) fn discover_git_workdir(base_path: &Path) -> Option<PathBuf> {
        let git_workdir = Repository::discover(base_path)
            .ok()
            .and_then(|repo| repo.workdir().map(Path::to_path_buf))
            .map(crate::path_utils::normalize);

        match &git_workdir {
            Some(workdir) => debug!("Git repository found at: {}", workdir.display()),
            None => warn!("No git repository found for path: {}", base_path.display()),
        }

        git_workdir
    }

    #[cfg(test)]
    pub(crate) fn spawn_git_status(git_workdir: PathBuf) -> JoinHandle<Option<GitStatusCache>> {
        std::thread::spawn(move || {
            GitStatusCache::read_git_status(
                Some(git_workdir.as_path()),
                &mut crate::git::initial_scan_status_options(),
            )
        })
    }

    /// Collect files without blocking on Git IO. The scan job subsequently
    /// publishes status/recency through its separately acknowledged worker.
    #[tracing::instrument(skip_all, name = "walk_filesystem", level = Level::INFO)]
    pub(crate) fn walk_filesystem(
        base_path: &Path,
        git_workdir: Option<PathBuf>,
        synced_files_count: &Arc<AtomicUsize>,
        shared_frecency: &SharedFrecency,
        follow_symlinks: bool,
    ) -> Result<FileSync, Error> {
        let scan_start = std::time::Instant::now();
        info!("SCAN: Starting filesystem walk");
        // The walker prunes inaccessible paths, including a vanished root.
        // Distinguish that failure from a genuinely empty readable directory.
        let check_root = || {
            std::fs::read_dir(base_path).map(|_| ()).map_err(|error| {
                Error::WalkFailed(format!(
                    "Cannot read index root {}: {error}",
                    base_path.display()
                ))
            })
        };
        check_root()?;

        // Walk files (the fast part, typically 2-3s even on huge repos).
        let is_git_repo = git_workdir.is_some();
        let bg_threads = BACKGROUND_THREAD_POOL.current_num_threads();

        let WalkOutput {
            dirs: mut walked_dirs,
            mut pairs,
            ignore_rules,
        } = crate::walk::walk_collect_files(
            base_path,
            is_git_repo,
            follow_symlinks,
            bg_threads,
            synced_files_count,
        )?;
        check_root()?;
        let ignore_rules = ignore_rules.map(Arc::new);

        // group walked dirs and files with a dir part to the same order
        BACKGROUND_THREAD_POOL.install(|| {
            rayon::join(
                || {
                    pairs.par_sort_unstable_by(|(a, path_a), (b, path_b)| {
                        // SAFETY: `filename_offset` is always at a character boundary
                        let (a_dir, a_file) = path_a.split_at(a.path.filename_offset as usize);
                        let (b_dir, b_file) = path_b.split_at(b.path.filename_offset as usize);
                        a_dir.cmp(b_dir).then_with(|| a_file.cmp(b_file))
                    });
                },
                || walked_dirs.par_sort_unstable(),
            );
        });
        walked_dirs.dedup();

        let mut builder = crate::simd_path::ChunkedPathStoreBuilder::new(pairs.len());
        let dirs = populates_dirs_files_chunked_storage(&mut pairs, &walked_dirs, &mut builder);
        drop(walked_dirs);

        let mut files: Vec<FileItem> = pairs.into_iter().map(|(file, _)| file).collect();
        let chunked_paths = builder.finish();
        let arena = chunked_paths.as_arena_ptr();

        // Apply frecency scores (access-based only — git status not yet available).
        // DirItem.max_access_frecency is AtomicI32, so parallel threads write directly.
        let frecency = shared_frecency
            .read()
            .map_err(|_| Error::AcquireFrecencyLock)?;

        if let Some(frecency) = frecency.as_ref() {
            let dirs_ref = &dirs;
            BACKGROUND_THREAD_POOL.install(|| {
                files.par_iter_mut().for_each(|file| {
                    let _ = file.update_frecency_scores(frecency, arena, base_path);
                    let score = file.access_frecency_score as i32;
                    if score > 0 {
                        let dir_idx = file.parent_dir_index as usize;
                        if let Some(dir) = dirs_ref.get(dir_idx) {
                            dir.update_frecency_if_larger(score);
                        }
                    }
                });
            });
        }
        drop(frecency);

        // un-indexable files that are binary or not fitting the size cap has to beplaced in the end
        let is_indexable = |f: &FileItem| {
            !f.is_binary()
                && f.size > 0
                && f.size <= crate::constants::MAX_INDEXABLE_FILE_SIZE as u64
        };

        BACKGROUND_THREAD_POOL.install(|| {
            files.par_sort_unstable_by(|a, b| {
                (!is_indexable(a))
                    .cmp(&!is_indexable(b))
                    // this just makes it faster in terms of allocation - we store the dir indexes
                    .then_with(|| a.parent_dir_index.cmp(&b.parent_dir_index))
                    .then_with(|| a.file_name(arena).cmp(&b.file_name(arena)))
            });
        });
        let indexable_count = files.partition_point(is_indexable);

        let file_item_size = std::mem::size_of::<FileItem>();
        let files_vec_bytes = files.len() * file_item_size;
        let dir_table_bytes = dirs.len() * std::mem::size_of::<DirItem>()
            + dirs
                .iter()
                .map(|d| d.relative_path(arena).len())
                .sum::<usize>();

        let total_time = scan_start.elapsed();
        info!(
            "SCAN: Walk completed in {:?} ({} files, {} dirs, \
         chunked_store={:.2}MB, files_vec={:.2}MB, dirs={:.2}MB, FileItem={}B)",
            total_time,
            files.len(),
            dirs.len(),
            chunked_paths.heap_bytes() as f64 / 1_048_576.0,
            files_vec_bytes as f64 / 1_048_576.0,
            dir_table_bytes as f64 / 1_048_576.0,
            file_item_size,
        );

        let base_count = files.len();
        let base_dirs_count = dirs.len();

        Ok(FileSync {
            identity: Arc::new(()),
            files: StableVec::from_vec_with_reserve(files, MAX_OVERFLOW_FILES),
            indexable_count,
            base_count,
            live_count: base_count,
            dirs: StableVec::from_vec_with_reserve(dirs, MAX_OVERFLOW_FILES),
            base_dirs_count,
            live_dirs_count: base_dirs_count,
            overflow_builder: None,
            git_workdir,
            chunked_paths: Some(Arc::new(chunked_paths)),
            ignore_rules,
        })
    }
}

/// This does both thing (yes sorry all the OOP morons)
/// in one go: populates files chunked storage and builds the dir table from
/// `walked_dirs` (every dir the walker visited: sorted, '/'-terminated,
/// deduped), merging file parents in a single lockstep sweep so dirs with no
/// files (empty subtrees, pure ancestors) are indexed and searchable too.
fn populates_dirs_files_chunked_storage<'a>(
    pairs: &'a mut [(FileItem, String)],
    walked_dirs: &[String],
    chunk_storage: &mut crate::simd_path::ChunkedPathStoreBuilder,
) -> Vec<DirItem> {
    let mut dirs: Vec<DirItem> = Vec::with_capacity(walked_dirs.len() + 1);
    let mut dir_iter = walked_dirs.iter().peekable();

    // Root-level files sort first and their "" parent is never a walker dir.
    if pairs
        .first()
        .is_some_and(|(f, _)| f.path.filename_offset == 0)
    {
        push_dir_item(&mut dirs, chunk_storage, "");
    }

    // Detects contiguous same-dir runs (pairs are sorted by dir) so the
    // merge below runs once per directory, not once per file.
    let mut prev_dir: &'a str = "";
    let mut current_dir_idx: u32 = 0;

    for (file, rel) in pairs.iter_mut() {
        let rel: &'a str = rel;
        let dir_part: &'a str = &rel[..file.path.filename_offset as usize];

        if prev_dir != dir_part {
            // Flush walked dirs up to and including this file's parent,
            // keeping the table sorted for the find_dir_index binary search.
            while let Some(dir) = dir_iter.peek()
                && dir.as_str() < dir_part
            {
                push_dir_item(&mut dirs, chunk_storage, dir);
                dir_iter.next();
            }

            match dir_iter.peek() {
                Some(dir) if dir.as_str() == dir_part => {
                    push_dir_item(&mut dirs, chunk_storage, dir);
                    dir_iter.next();
                }
                // Parents the walker reported with a non-dir kind
                // (e.g. followed symlinks) aren't in the list.
                _ => push_dir_item(&mut dirs, chunk_storage, dir_part),
            }

            current_dir_idx = (dirs.len() - 1) as u32;
            prev_dir = dir_part;
        }

        file.path = chunk_storage.add_file_immediate(rel, file.path.filename_offset);
        file.parent_dir_index = current_dir_idx;
    }

    for dir in dir_iter {
        push_dir_item(&mut dirs, chunk_storage, dir);
    }

    dirs
}

fn push_dir_item(
    dirs: &mut Vec<DirItem>,
    chunk_storage: &mut crate::simd_path::ChunkedPathStoreBuilder,
    dir_part: &str,
) {
    let dir_string = chunk_storage.add_dir_immediate(dir_part);

    // Compute last-segment offset: for "src/components/" -> 4 (points to "components/")
    let last_seg = if dir_part.is_empty() {
        0
    } else {
        let trimmed = dir_part.trim_end_matches(std::path::is_separator);
        trimmed
            .rfind(std::path::is_separator)
            .map(|i| i + 1)
            .unwrap_or(0) as u16
    };

    dirs.push(DirItem::new(dir_string, last_seg));
}

/// Fast extension-based binary detection. Avoids opening files during scan.
/// Covers the vast majority of binary files in typical repositories.
#[inline]
#[doc(hidden)]
pub fn is_known_binary_extension(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    is_binary_extension_str(ext)
}

/// Like [`is_known_binary_extension`] but takes a basename string directly,
/// avoiding `Path::extension()` overhead. Mirrors `Path::extension()`
/// semantics: dotfiles with no other dots → no extension. Used by the zlob
/// walker, which already has the basename slice from traversal.
#[inline]
pub(crate) fn is_known_binary_extension_basename(name: &str) -> bool {
    match name.rfind('.') {
        Some(pos) if pos > 0 && pos < name.len() - 1 => is_binary_extension_str(&name[pos + 1..]),
        _ => false,
    }
}

#[inline]
fn is_binary_extension_str(ext: &str) -> bool {
    matches!(
        ext,
        // Images
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "ico" | "webp" | "tiff" | "tif" | "avif" |
        "heic" | "heif" | "jxl" | "jp2" | "j2k" | "psd" | "icns" | "cur" | "cr2" |
        "nef" | "dng" | "tga" |
        // GPU / VFX texture formats
        "rgbe" | "hdr" | "exr" | "dds" | "ktx" | "ktx2" | "pvr" | "astc" |
        // Adobe Illustrator (PDF wrapper) / Apple webarchive / MIME HTML archive
        "ai" | "webarchive" | "mhtml" |
        // Video/Audio
        "mp4" | "avi" | "mov" | "wmv" | "mkv" | "mp3" | "wav" | "flac" | "ogg" | "m4a" |
        "aac" | "webm" | "flv" | "mpg" | "mpeg" | "wma" | "opus" | "pcm" | "reapeaks" |
        // Compressed/Archives
        "zip" | "tar" | "gz" | "bz2" | "xz" | "7z" | "rar" | "zst" | "lz4" | "lzma" |
        "cab" | "cpio" | "jsonlz4" |
        // Packages/Installers
        "deb" | "rpm" | "apk" | "dmg" | "msi" | "iso" | "nupkg" | "whl" | "egg" |
        "appimage" | "flatpak" | "crx" | "pak" |
        // Executables/Libraries
        "exe" | "dll" | "so" | "dylib" | "o" | "a" | "lib" | "bin" | "elf" |
        // Documents (binary office formats)
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" |
        // Databases
        "db" | "sqlite" | "sqlite3" | "mdb" |
        // SQLite / LevelDB auxiliary files
        "sqlite-wal" | "sqlite-shm" | "sqlite3-wal" | "sqlite3-shm" |
        "db-wal" | "db-shm" | "ldb" |
        // Fonts
        "ttf" | "otf" | "woff" | "woff2" | "eot" |
        // Compiled/Runtime
        "class" | "pyc" | "pyo" | "wasm" | "dex" | "jar" | "war" |
        // OCaml / Swift / Objective-C build artefacts
        "cmi" | "cmt" | "cmti" | "cmx" | "nib" |
        "swiftdeps" | "swiftdeps~" | "swiftdoc" | "swiftmodule" | "swiftsourceinfo" |
        // ML/Data Science
        "npy" | "npz" | "h5" | "hdf5" | "pt" | "onnx" |
        "safetensors" | "tfrecord" | "tflite" | "gguf" | "ggml" | "joblib" |
        // 3D/Game assets
        "glb" | "blend" | "blp" |
        // Gzipped-XML / binary maps
        "dia" | "bcmap" |
        // Protobuf wire format
        "pb" |
        // Data/serialized
        "parquet" | "arrow" |
        // IDE/OS metadata
        "suo"
    )
}

/// Length of the longest shared directory prefix of two relative dir
/// paths (without a trailing separator), measured as the number of bytes
/// up to and including the last shared separator — plus the full shorter
/// path when it is itself a directory prefix of the longer one.
///
/// Examples:
///   `"src/components"` vs `"src/routes"`   → 4  (`"src/"` emitted once)
///   `"lib/deep/nested"` vs `"lib/deep"`   → 8  (`"lib/deep"` is a prefix)
///   `"lib/deep"` vs `"lib/deeper"`        → 4  (only `"lib/"` is shared)
///   `"lib"` vs `"src"`                    → 0
///
/// Used by [`FilePicker::for_each_watch_dir`] to avoid re-emitting
/// ancestors that were already yielded for the previous (sorted) sibling.
fn common_dir_prefix_len(a: &str, b: &str) -> usize {
    let max = a.len().min(b.len());
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let mut last_sep = 0;
    let mut i = 0;
    while i < max && a_bytes[i] == b_bytes[i] {
        if std::path::is_separator(a_bytes[i] as char) {
            last_sep = i + 1;
        }
        i += 1;
    }
    // If one string is a prefix of the other and the next byte in the
    // longer one is a separator, the full shorter path is a shared dir.
    if i == max && i > 0 {
        let longer = if a.len() > b.len() { a_bytes } else { b_bytes };
        if i < longer.len() && std::path::is_separator(longer[i] as char) {
            return i;
        }
    }
    last_sep
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The watcher must watch every ancestor directory up to `base_path`,
    /// not just the immediate parents of indexed files. The dir table is
    /// built from the walker's visited dirs, so pure ancestors (dirs that
    /// contain only subdirectories) must be present and emitted exactly once.
    #[test]
    fn extract_watch_dirs_includes_pure_ancestor_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let base_buf = crate::path_utils::canonicalize(dir.path()).unwrap();
        let base = base_buf.as_path();

        // Tree:
        //   base/src/components/button.txt    (src/components has a file)
        //   base/src/routes/home.txt          (src/routes has a file)
        //   base/lib/deep/nested/util.txt     (lib and lib/deep have no files)
        for rel in [
            "src/components/button.txt",
            "src/routes/home.txt",
            "lib/deep/nested/util.txt",
        ] {
            let path = base.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"x").unwrap();
        }

        let mut picker = FilePicker::new(FilePickerOptions {
            base_path: base.to_str().unwrap().into(),
            watch: false,
            ..Default::default()
        })
        .unwrap();
        picker.collect_files().unwrap();

        let mut watch_dirs: Vec<PathBuf> = Vec::new();
        picker.for_each_dir(|p| {
            watch_dirs.push(p.to_path_buf());
            std::ops::ControlFlow::Continue(())
        });
        let watch_set: std::collections::HashSet<PathBuf> = watch_dirs.iter().cloned().collect();

        // Immediate parents (in sync_data.dirs) must be present.
        for rel in ["src/components", "src/routes", "lib/deep/nested"] {
            assert!(
                watch_set.contains(&base.join(rel)),
                "expected immediate parent {rel} in watch dirs, got {watch_set:?}",
            );
        }

        // Pure-ancestor dirs (NOT in sync_data.dirs) must also be present.
        for rel in ["src", "lib", "lib/deep"] {
            assert!(
                watch_set.contains(&base.join(rel)),
                "expected pure-ancestor {rel} in watch dirs, got {watch_set:?}",
            );
        }

        // No duplicates — streaming dedup must not emit the same dir twice.
        assert_eq!(
            watch_dirs.len(),
            watch_set.len(),
            "duplicate watch dir emitted: {watch_dirs:?}",
        );

        // Base path itself is NOT walked into the result — the walker stops
        // at `current == base`. The outer `debouncer.watch(base_path, ...)`
        // call in create_debouncer covers it separately.
        assert!(
            !watch_set.contains(base),
            "base path must not be in watch dirs (covered by the top-level watch call)",
        );
    }

    /// Regression guard for #725: dirs that are EMPTY at scan time are merged
    /// into `sync_data.dirs` so they are searchable and get an inotify watch;
    /// files created in them later must be detected.
    #[test]
    fn for_each_dir_includes_empty_directories() {
        let dir = tempfile::tempdir().unwrap();
        let base_buf = crate::path_utils::canonicalize(dir.path()).unwrap();
        let base = base_buf.as_path();

        // Tree:
        //   base/init.lua                  (file directly under base)
        //   base/commands/                 (empty at scan — the #725 repro)
        //   base/src/main.rs               (src is indexed)
        //   base/src/plugins/extra/        (empty chain under an indexed dir)
        std::fs::create_dir_all(base.join("commands")).unwrap();
        std::fs::create_dir_all(base.join("src/plugins/extra")).unwrap();
        std::fs::write(base.join("init.lua"), b"x").unwrap();
        std::fs::write(base.join("src/main.rs"), b"x").unwrap();

        let mut picker = FilePicker::new(FilePickerOptions {
            base_path: base.to_str().unwrap().into(),
            watch: false,
            ..Default::default()
        })
        .unwrap();
        picker.collect_files().unwrap();

        let mut watch_dirs: Vec<PathBuf> = Vec::new();
        picker.for_each_dir(|p| {
            watch_dirs.push(p.to_path_buf());
            std::ops::ControlFlow::Continue(())
        });
        let watch_set: std::collections::HashSet<PathBuf> = watch_dirs.iter().cloned().collect();

        for rel in ["commands", "src/plugins", "src/plugins/extra", "src"] {
            assert!(
                watch_set.contains(&base.join(rel)),
                "expected {rel} in watch dirs, got {watch_set:?}",
            );
        }

        // Dirs covered by indexed files must not be duplicated.
        assert_eq!(
            watch_dirs.len(),
            watch_set.len(),
            "duplicate watch dir emitted: {watch_dirs:?}",
        );
    }

    #[test]
    fn dir_table_merges_walked_dirs_with_file_parents() {
        let mut pairs: Vec<(FileItem, String)> = ["src/main.rs", "src/deep/lib.rs", "root.txt"]
            .iter()
            .map(|p| {
                let (item, rel) = FileItem::new(PathBuf::from(p), Path::new(""), None);
                (item, rel)
            })
            .collect();
        pairs.sort_by(|(a, pa), (b, pb)| {
            pa[..a.path.filename_offset as usize]
                .cmp(&pb[..b.path.filename_offset as usize])
                .then_with(|| pa.cmp(pb))
        });

        // Sorted '/'-terminated walker output: file parents + an empty dir +
        // a sibling sharing a prefix with a file parent.
        let walked: Vec<String> = ["empty/", "src/", "src/deep/", "src/deeper/"]
            .iter()
            .map(|s| s.to_string())
            .collect();

        let mut builder = crate::simd_path::ChunkedPathStoreBuilder::new(pairs.len());
        let dirs = populates_dirs_files_chunked_storage(&mut pairs, &walked, &mut builder);
        let store = builder.finish();
        let arena = store.as_arena_ptr();

        let table: Vec<String> = dirs.iter().map(|d| d.relative_path(arena)).collect();
        // Sorted: "" (root files) first, all walked dirs present exactly once.
        assert_eq!(table, ["", "empty/", "src/", "src/deep/", "src/deeper/"]);

        // Every file's parent_dir_index points at its own dir entry.
        for (file, _) in &pairs {
            let dir = &dirs[file.parent_dir_index as usize];
            let rel = file.relative_path(arena);
            assert!(
                rel.starts_with(&dir.relative_path(arena)),
                "file {rel} must live under its parent dir",
            );
        }
    }

    #[test]
    fn common_dir_prefix_len_cases() {
        assert_eq!(common_dir_prefix_len("", ""), 0);
        assert_eq!(common_dir_prefix_len("", "src"), 0);
        assert_eq!(common_dir_prefix_len("lib", "src"), 0);
        assert_eq!(common_dir_prefix_len("src/components", "src/routes"), 4);
        assert_eq!(common_dir_prefix_len("lib/deep/nested", "lib/deep"), 8);
        assert_eq!(common_dir_prefix_len("lib/deep", "lib/deep/nested"), 8);
        assert_eq!(common_dir_prefix_len("lib/deep", "lib/deeper"), 4);
        assert_eq!(common_dir_prefix_len("src", "src"), 0);
        // "src" is emitted-as-dir; "src/x" extends it — full "src" is shared.
        assert_eq!(common_dir_prefix_len("src", "src/x"), 3);
    }

    #[test]
    fn directory_removal_counts_each_tombstone_once() {
        let dir = tempfile::tempdir().unwrap();
        let base = crate::path_utils::canonicalize(dir.path()).unwrap();
        let removed_dir = base.join("removed");
        let kept = base.join("kept.txt");
        let first = removed_dir.join("a.txt");
        let second = removed_dir.join("nested/b.txt");
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        std::fs::write(&first, b"a").unwrap();
        std::fs::write(&second, b"b").unwrap();
        std::fs::write(&kept, b"kept").unwrap();

        let mut picker = FilePicker::new(FilePickerOptions {
            base_path: base.to_string_lossy().into_owned(),
            watch: false,
            ..Default::default()
        })
        .unwrap();
        picker.collect_files().unwrap();

        assert_eq!(
            picker.remove_all_files_in_dirs(std::iter::once(removed_dir.as_path())),
            2
        );
        assert_eq!(picker.remove_all_files_in_dir(&removed_dir), 0);
        assert_eq!(picker.sync_data.live_count, 1);
        assert!(picker.get_file_by_path(&kept).is_some());

        let outside = base.parent().unwrap().join("outside");
        assert_eq!(picker.remove_all_files_in_dir(&outside), 0);
        assert!(picker.get_file_by_path(&kept).is_some());
    }
}
