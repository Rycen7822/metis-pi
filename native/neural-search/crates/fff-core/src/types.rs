use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI32, AtomicU8, AtomicU64, AtomicUsize, Ordering};

use crate::constants::MIN_CACHED_CONTENT_SIZE;
use crate::constants::{MAX_CACHED_CONTENT_BYTES, MAX_FFFILE_SIZE, PATH_BUF_SIZE};
use crate::index::constraints::Constrainable;
use crate::query_tracker::QueryMatchEntry;
use crate::simd_path::ArenaPtr;
use fff_query_parser::FFFQuery;

/// Different sources of the string storage used by FFF
/// implements as a deduplicated 16-bytes alined heap
/// can be stored in RAM or on disk
pub trait FFFStringStorage {
    /// Resolve the arena for a [`FileItem`] (handles base vs overflow split).
    fn arena_for(&self, file: &FileItem) -> ArenaPtr;

    /// The base arena (scan-time paths).
    fn base_arena(&self) -> ArenaPtr;
    /// The overflow arena (paths added after the last full scan).
    fn overflow_arena(&self) -> ArenaPtr;
}

impl FFFStringStorage for ArenaPtr {
    #[inline]
    fn arena_for(&self, _file: &FileItem) -> ArenaPtr {
        *self
    }

    #[inline]
    fn base_arena(&self) -> ArenaPtr {
        *self
    }

    #[inline]
    fn overflow_arena(&self) -> ArenaPtr {
        *self
    }
}

pub trait FileSliceExt {
    fn live_count(&self) -> usize;
}

impl FileSliceExt for [FileItem] {
    #[inline]
    fn live_count(&self) -> usize {
        self.iter().filter(|f| !f.is_deleted()).count()
    }
}

pub struct FileItemFlags;

impl FileItemFlags {
    pub const BINARY: u8 = 1 << 0;
    /// Tombstone — deletion preserves slot identity for in-flight classifiers.
    pub const DELETED: u8 = 1 << 1;
    /// File was added after the last full reindex; its indices point
    /// into the overflow builder arena, not the base arena.
    pub const OVERFLOW: u8 = 1 << 2;
}

pub struct DirFlags;

impl DirFlags {
    pub const OVERFLOW: u8 = 1 << 0;
    pub const DELETED: u8 = 1 << 1;
}

/// A directory in the file index. Shares chunk arena with file paths.
#[derive(Debug)]
pub struct DirItem {
    flags: u8,
    pub(crate) path: crate::simd_path::ChunkedString,
    /// Byte offset where the last path segment begins (e.g. for `src/components/`
    /// this is 4, pointing to `components/`). Used for dirname-bonus scoring.
    last_segment_offset: u16,
    /// Maximum `access_frecency_score` among direct child files.
    /// Atomic so parallel frecency updates can write directly without juggling.
    max_access_frecency: AtomicI32,
}

impl Clone for DirItem {
    fn clone(&self) -> Self {
        Self {
            flags: self.flags,
            path: self.path.clone(),
            last_segment_offset: self.last_segment_offset,
            max_access_frecency: AtomicI32::new(self.max_access_frecency()),
        }
    }
}

impl DirItem {
    #[inline(always)]
    pub fn is_overflow(&self) -> bool {
        self.flags & DirFlags::OVERFLOW != 0
    }

    #[inline(always)]
    pub fn is_deleted(&self) -> bool {
        self.flags & DirFlags::DELETED != 0
    }

    /// Marks the dir deleted/restored. Returns `true` when the state changed.
    pub(crate) fn set_deleted(&mut self, deleted: bool) -> bool {
        if self.is_deleted() == deleted {
            return false;
        }
        if deleted {
            self.flags |= DirFlags::DELETED;
        } else {
            self.flags &= !DirFlags::DELETED;
        }
        true
    }

    pub(crate) fn new(path: crate::simd_path::ChunkedString, last_segment_offset: u16) -> Self {
        Self {
            path,
            flags: 0,
            last_segment_offset,
            max_access_frecency: AtomicI32::new(0),
        }
    }

    /// A dir appended after the initial scan; its path lives in the overflow arena.
    pub(crate) fn new_overflow(
        path: crate::simd_path::ChunkedString,
        last_segment_offset: u16,
    ) -> Self {
        Self {
            path,
            flags: DirFlags::OVERFLOW,
            last_segment_offset,
            max_access_frecency: AtomicI32::new(0),
        }
    }

    /// Byte offset of the last path segment within the directory path.
    #[inline]
    pub fn last_segment_offset(&self) -> u16 {
        self.last_segment_offset
    }

    /// Current max access frecency score.
    #[inline]
    pub fn max_access_frecency(&self) -> i32 {
        self.max_access_frecency.load(Ordering::Relaxed)
    }

    /// Atomically update the directory's frecency score if the given score is larger.
    /// Safe to call from parallel threads.
    #[inline]
    pub fn update_frecency_if_larger(&self, score: i32) {
        self.max_access_frecency.fetch_max(score, Ordering::Relaxed);
    }

    pub(crate) fn read_relative_path<'a>(&self, arena: ArenaPtr, buf: &'a mut [u8]) -> &'a str {
        self.path.read_to_buf(arena, buf)
    }

    /// Relative dir path as owned String (cold path).
    pub fn relative_path(&self, arena: impl FFFStringStorage) -> String {
        let mut out = String::new();
        let ptr = if self.is_overflow() {
            arena.overflow_arena()
        } else {
            arena.base_arena()
        };

        self.path.write_to_string(ptr, &mut out);
        out
    }

    pub(crate) fn read_dir_name<'a>(&self, arena: ArenaPtr, buf: &'a mut [u8]) -> &'a str {
        let total = self.path.byte_len as usize;
        let offset = self.last_segment_offset as usize;
        if offset >= total {
            return "";
        }
        let full = self.path.read_to_buf(arena, buf);
        &full[offset..]
    }

    /// Write the last segment (dirname) of this directory path to `out`.
    pub fn write_dir_name(&self, arena: ArenaPtr, out: &mut String) {
        out.clear();
        let mut buf = [0u8; PATH_BUF_SIZE];
        out.push_str(self.read_dir_name(arena, &mut buf));
    }

    /// The dirname (last segment) as an owned String. Cold path.
    pub fn dir_name(&self, arena: impl FFFStringStorage) -> String {
        let mut out = String::new();
        let ptr = if self.is_overflow() {
            arena.overflow_arena()
        } else {
            arena.base_arena()
        };
        self.write_dir_name(ptr, &mut out);
        out
    }
}

impl Constrainable for DirItem {
    #[inline]
    fn write_file_name(&self, arena: ArenaPtr, out: &mut String) {
        // For dirs, the "file name" equivalent is the last path segment
        self.write_dir_name(arena, out);
    }

    #[inline]
    fn write_relative_path(&self, arena: ArenaPtr, out: &mut String) {
        self.path.write_to_string(arena, out);
    }

    #[inline]
    fn git_status(&self) -> Option<git2::Status> {
        None
    }

    #[inline]
    fn is_overflow(&self) -> bool {
        DirItem::is_overflow(self)
    }
}

#[derive(Debug)]
pub struct FileItem {
    pub size: u64,
    pub modified: u64,
    pub access_frecency_score: i16,
    pub modification_frecency_score: i16,
    pub git_recency_score: i16,
    pub git_status: Option<git2::Status>,
    pub(crate) path: crate::simd_path::ChunkedString,
    pub(crate) parent_dir_index: u32,
    /// Incremented under the picker write lock on every content event, even
    /// equal-size rewrites within the same mtime second. Never an IO timestamp.
    pub(crate) content_revision: u64,
    flags: AtomicU8,
    /// Lazy immutable content snapshot, bounded by the shared cache budget.
    content: OnceLock<Box<[u8]>>,
}

impl Clone for FileItem {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            parent_dir_index: self.parent_dir_index,
            content_revision: self.content_revision,
            size: self.size,
            modified: self.modified,
            access_frecency_score: self.access_frecency_score,
            modification_frecency_score: self.modification_frecency_score,
            git_recency_score: self.git_recency_score,
            git_status: self.git_status,
            flags: AtomicU8::new(self.flags.load(Ordering::Relaxed)),
            // Clones never duplicate retained content.
            content: OnceLock::new(),
        }
    }
}

/// Single-block read used by the binary classifier. Most binaries reveal a
/// NUL byte within the first filesystem block, so 16 KB lets one read settle
/// the classification for typical files while keeping the scratch buffer
/// small enough to live on the stack.
pub const BINARY_CLASSIFICATION_CHUNK_SIZE: usize = 16 * 1024;

/// A file is treated as binary if any NUL byte appears in the scanned prefix.
#[inline]
pub(crate) fn detect_binary_content(content: &[u8]) -> bool {
    memchr::memchr(0, content).is_some()
}

impl FileItem {
    pub fn new_raw(
        filename_start: u16,
        size: u64,
        modified: u64,
        git_status: Option<git2::Status>,
        is_binary: bool,
    ) -> Self {
        let mut flags = 0u8;
        if is_binary {
            flags |= FileItemFlags::BINARY;
        }

        let mut path = crate::simd_path::ChunkedString::empty();
        path.filename_offset = filename_start;

        Self {
            path,
            parent_dir_index: u32::MAX,
            content_revision: 0,
            size,
            modified,
            access_frecency_score: 0,
            modification_frecency_score: 0,
            git_recency_score: 0,
            git_status,
            flags: AtomicU8::new(flags),
            content: OnceLock::new(),
        }
    }

    /// Returns an absolute path of the file
    pub fn absolute_path(&self, arena: impl FFFStringStorage, base_path: &Path) -> PathBuf {
        let mut buf = [0u8; PATH_BUF_SIZE];
        let rel = self.path.read_to_buf(arena.arena_for(self), &mut buf);
        base_path.join(rel)
    }

    pub(crate) fn set_path(&mut self, path: crate::simd_path::ChunkedString) {
        self.path = path;
    }

    pub(crate) fn write_dir_str(&self, arena: ArenaPtr, out: &mut String) {
        self.path.write_dir_to(arena, out);
    }

    pub fn file_name(&self, arena: impl FFFStringStorage) -> String {
        let mut s = String::with_capacity(32);
        self.path.write_filename_to(arena.arena_for(self), &mut s);
        s
    }

    pub(crate) fn write_file_name_from_arena(&self, arena: ArenaPtr, out: &mut String) {
        self.path.write_filename_to(arena, out);
    }

    pub fn relative_path(&self, arena: impl FFFStringStorage) -> String {
        let mut s = String::with_capacity(64);
        self.path.write_to_string(arena.arena_for(self), &mut s);
        s
    }

    pub(crate) fn write_relative_path_from_arena(&self, arena: ArenaPtr, out: &mut String) {
        self.path.write_to_string(arena, out);
    }

    pub fn filename_offset_in_relative_path(&self) -> usize {
        self.path.filename_offset as usize
    }

    pub(crate) fn relative_path_eq(&self, arena: ArenaPtr, other: &str) -> bool {
        if other.len() != self.path.byte_len as usize {
            return false;
        }
        let mut buf = [0u8; PATH_BUF_SIZE];
        let mine = self.path.read_to_buf(arena, &mut buf);
        mine == other
    }

    pub(crate) fn relative_path_starts_with(&self, arena: ArenaPtr, prefix: &str) -> bool {
        let mut buf = [0u8; PATH_BUF_SIZE];
        let path = self.path.read_to_buf(arena, &mut buf);
        path.starts_with(prefix)
    }

    /// Write `base_path + '/' + relative_path` into `buf` and return it
    /// as `&Path`. Takes a fixed-size array so the buffer can live on
    /// the stack (no heap allocation, no bounds checks in the hot loop).
    pub(crate) fn write_absolute_path<'a>(
        &self,
        arena: ArenaPtr,
        base_path: &Path,
        buf: &'a mut [u8; PATH_BUF_SIZE],
    ) -> &'a Path {
        let base = base_path.as_os_str().as_encoded_bytes();
        let base_len = base.len();
        buf[..base_len].copy_from_slice(base);
        let sep_len = if base_len > 0 && base[base_len - 1] != std::path::MAIN_SEPARATOR as u8 {
            buf[base_len] = std::path::MAIN_SEPARATOR as u8;
            1
        } else {
            0
        };

        let base_end_idx = base_len + sep_len;
        let relative_portion_str = self.path.read_to_buf(arena, &mut buf[base_end_idx..]);
        let rel_len = relative_portion_str.len();
        let total = base_end_idx + rel_len;
        // Linux uses the same stored bytes for IO, Git keys and frecency paths.
        Path::new(unsafe { std::str::from_utf8_unchecked(&buf[..total]) })
    }

    #[inline]
    pub fn total_frecency_score(&self) -> i32 {
        self.access_frecency_score as i32 + self.modification_frecency_score as i32
    }

    #[inline]
    pub fn is_binary(&self) -> bool {
        self.flags.load(Ordering::Relaxed) & FileItemFlags::BINARY != 0
    }

    #[inline]
    pub fn set_binary(&self, val: bool) {
        if val {
            self.flags
                .fetch_or(FileItemFlags::BINARY, Ordering::Relaxed);
        } else {
            self.flags
                .fetch_and(!FileItemFlags::BINARY, Ordering::Relaxed);
        }
    }

    #[inline]
    pub fn is_deleted(&self) -> bool {
        self.flags.load(Ordering::Relaxed) & FileItemFlags::DELETED != 0
    }

    #[inline]
    #[doc(hidden)]
    /// Don't use it, use FilePicker::delete_file
    pub fn set_deleted(&self, val: bool) {
        if val {
            self.flags
                .fetch_or(FileItemFlags::DELETED, Ordering::Relaxed);
        } else {
            self.flags
                .fetch_and(!FileItemFlags::DELETED, Ordering::Relaxed);
        }
    }

    #[inline]
    pub fn is_overflow(&self) -> bool {
        self.flags.load(Ordering::Relaxed) & FileItemFlags::OVERFLOW != 0
    }

    #[inline]
    pub fn set_overflow(&self, val: bool) {
        if val {
            self.flags
                .fetch_or(FileItemFlags::OVERFLOW, Ordering::Relaxed);
        } else {
            self.flags
                .fetch_and(!FileItemFlags::OVERFLOW, Ordering::Relaxed);
        }
    }
}

impl FileItem {
    /// Retire the immutable snapshot under the picker write lock.
    pub fn invalidate_content(&mut self, budget: &ContentCacheBudget) {
        if let Some(content) = self.content.take() {
            budget.release(content.len() as u64);
        }
    }

    pub fn update_metadata(
        &mut self,
        budget: &ContentCacheBudget,
        modified_secs: Option<u64>,
        new_size: Option<u64>,
    ) {
        self.content_revision = self
            .content_revision
            .checked_add(1)
            .expect("content revision exhausted");
        if let Some(modified) = modified_secs {
            self.modified = modified;
        }

        self.invalidate_content(budget);

        if let Some(size) = new_size {
            self.size = size;
        }
    }

    /// Read an indexed-length immutable snapshot of an eligible regular file.
    /// Cache exhaustion disables retention, not searching. A concurrent shrink
    /// yields a short-read miss; growth is observed after managed invalidation.
    #[inline]
    pub(crate) fn get_content_for_search<'a>(
        &'a self,
        buf: &'a mut Option<Vec<u8>>,
        arena: ArenaPtr,
        base_path: &Path,
        budget: &ContentCacheBudget,
    ) -> Option<&'a [u8]> {
        if let Some(content) = self.content.get() {
            return Some(content);
        }
        if self.is_binary() || self.size == 0 || self.size > budget.max_file_size {
            return None;
        }

        let len = usize::try_from(self.size).ok()?;
        let mut file = open_regular_file(&self.absolute_path(arena, base_path)).ok()?;
        // Retain the first cold read's capacity policy, but allocate nothing for
        // a cache-only job. Some(empty) remains after transferring bytes to cache.
        let buf = buf.get_or_insert_with(|| Vec::with_capacity(64 * 1024));
        buf.clear();
        buf.try_reserve_exact(len).ok()?;
        buf.resize(len, 0);
        file.read_exact(buf).ok()?;

        if self.size >= MIN_CACHED_CONTENT_SIZE && budget.try_reserve(self.size) {
            // Move, rather than copy, the successful read into the cache.
            if self
                .content
                .set(std::mem::take(buf).into_boxed_slice())
                .is_err()
            {
                // Another reader published first; its reservation owns the entry.
                budget.release(self.size);
            }
            return self.content.get().map(|content| content.as_ref());
        }
        Some(buf.as_slice())
    }
}

/// Open without waiting for a FIFO writer, then validate the actual descriptor.
/// Index metadata alone cannot protect against a path changing type before IO.
pub(crate) fn open_regular_file(path: &Path) -> std::io::Result<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "not a regular file",
        ));
    }
    Ok(file)
}

impl Constrainable for FileItem {
    #[inline]
    fn write_file_name(&self, arena: ArenaPtr, out: &mut String) {
        self.path.write_filename_to(arena, out);
    }

    #[inline]
    fn write_relative_path(&self, arena: ArenaPtr, out: &mut String) {
        self.path.write_to_string(arena, out);
    }

    #[inline]
    fn git_status(&self) -> Option<git2::Status> {
        self.git_status
    }

    #[inline]
    fn is_overflow(&self) -> bool {
        FileItem::is_overflow(self)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Score {
    pub total: i32,
}

#[derive(Debug, Clone, Copy)]
pub struct PaginationArgs {
    pub offset: usize,
    pub limit: usize,
}

impl Default for PaginationArgs {
    fn default() -> Self {
        Self {
            offset: 0,
            limit: 100,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ScoringContext<'a> {
    pub query: &'a FFFQuery<'a>,
    pub project_path: Option<&'a Path>,
    pub current_file: Option<&'a str>,
    pub max_typos: u16,
    pub max_threads: usize,
    pub last_same_query_match: Option<QueryMatchEntry>,
    pub combo_boost_score_multiplier: i32,
    pub min_combo_count: u32,
    pub pagination: PaginationArgs,
}

#[derive(Debug, Clone, Default)]
pub struct SearchResult<'a> {
    pub items: Vec<&'a FileItem>,
    pub scores: Vec<Score>,
    pub total_matched: usize,
    pub total_files: usize,
}

/// Search result for directory-only fuzzy search.
#[derive(Debug, Clone, Default)]
pub struct DirSearchResult<'a> {
    pub items: Vec<&'a DirItem>,
    pub scores: Vec<Score>,
    pub total_matched: usize,
    pub total_dirs: usize,
}

/// A single item in a mixed (files + directories) search result.
#[derive(Debug, Clone)]
pub enum MixedItemRef<'a> {
    File(&'a FileItem),
    Dir(&'a DirItem),
}

/// Search result for mixed (files + directories) fuzzy search.
/// Items are interleaved by total score in descending order.
#[derive(Debug, Clone, Default)]
pub struct MixedSearchResult<'a> {
    pub items: Vec<MixedItemRef<'a>>,
    pub scores: Vec<Score>,
    pub total_matched: usize,
    pub total_files: usize,
    pub total_dirs: usize,
}

#[derive(Debug)]
pub struct ContentCacheBudget {
    pub max_files: usize,
    pub max_bytes: u64,
    pub max_file_size: u64,
    pub cached_count: AtomicUsize,
    pub cached_bytes: AtomicU64,
}

impl ContentCacheBudget {
    /// Reserve both caps before publication; concurrent readers cannot exceed them.
    fn try_reserve(&self, bytes: u64) -> bool {
        if self
            .cached_count
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                count.checked_add(1).filter(|&next| next <= self.max_files)
            })
            .is_err()
        {
            return false;
        }
        if self
            .cached_bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                used.checked_add(bytes)
                    .filter(|&next| next <= self.max_bytes)
            })
            .is_err()
        {
            self.cached_count.fetch_sub(1, Ordering::Relaxed);
            return false;
        }
        true
    }

    fn release(&self, bytes: u64) {
        self.cached_bytes.fetch_sub(bytes, Ordering::Relaxed);
        self.cached_count.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn unlimited() -> Self {
        Self {
            max_files: usize::MAX,
            max_bytes: u64::MAX,
            max_file_size: MAX_FFFILE_SIZE,
            cached_count: AtomicUsize::new(0),
            cached_bytes: AtomicU64::new(0),
        }
    }

    pub fn zero() -> Self {
        Self {
            max_files: 0,
            max_bytes: 0,
            max_file_size: 0,
            cached_count: AtomicUsize::new(0),
            cached_bytes: AtomicU64::new(0),
        }
    }

    // Byte budget
    pub fn is_exhausted(&self) -> bool {
        self.cached_count.load(Ordering::Relaxed) >= self.max_files
            || self.cached_bytes.load(Ordering::Relaxed) >= self.max_bytes
    }

    pub fn new_for_repo(file_count: usize) -> Self {
        let max_files = if file_count > 50_000 {
            5_000
        } else if file_count > 10_000 {
            10_000
        } else {
            30_000 // effectively unlimited for small repos
        };

        let max_bytes = if file_count > 50_000 {
            128 * 1024 * 1024 // 128 MB
        } else if file_count > 10_000 {
            256 * 1024 * 1024 // 256 MB
        } else {
            MAX_CACHED_CONTENT_BYTES // 512 MB
        };

        Self {
            max_files,
            max_bytes,
            max_file_size: MAX_FFFILE_SIZE,
            cached_count: AtomicUsize::new(0),
            cached_bytes: AtomicU64::new(0),
        }
    }

    /// Apply an explicit file cap verbatim, keeping the default byte caps.
    /// `0` means no persistent caching at all — files stay searchable through
    /// the temporary owned buffers that grep releases after each call.
    pub fn with_max_files(max_files: usize) -> Self {
        Self {
            max_files,
            ..Self::default()
        }
    }

    /// Build a budget from caller-supplied overrides.
    ///
    /// Each argument is a cap; `0` means "use the library default for that
    /// cap" (inherits from [`Self::default`], which is `new_for_repo(30_000)`).
    /// Returns `None` when every cap is `0`, signalling to the picker that it
    /// should auto-size the budget from the final scanned file count rather
    /// than applying an explicit override.
    pub fn from_overrides(max_files: usize, max_bytes: u64, max_file_size: u64) -> Option<Self> {
        if max_files == 0 && max_bytes == 0 && max_file_size == 0 {
            return None;
        }

        let mut budget = Self::default();
        if max_files > 0 {
            budget.max_files = max_files;
        }
        if max_bytes > 0 {
            budget.max_bytes = max_bytes;
        }
        if max_file_size > 0 {
            budget.max_file_size = max_file_size;
        }
        Some(budget)
    }

    pub fn reset(&self) {
        self.cached_count.store(0, Ordering::Relaxed);
        self.cached_bytes.store(0, Ordering::Relaxed);
    }
}

impl Default for ContentCacheBudget {
    fn default() -> Self {
        Self::new_for_repo(30_000)
    }
}

#[cfg(test)]
mod content_cache_budget_tests {
    use super::*;

    #[test]
    fn with_max_files_applies_the_cap_verbatim() {
        // regression: the cap used to be routed through new_for_repo, which
        // read it as a repo file count and bucketed 2000 up to 30_000
        assert_eq!(ContentCacheBudget::with_max_files(2000).max_files, 2000);
        assert_eq!(ContentCacheBudget::with_max_files(7).max_files, 7);
        assert_eq!(
            ContentCacheBudget::with_max_files(1_000_000).max_files,
            1_000_000
        );
    }

    #[test]
    fn with_max_files_zero_disables_persistent_caching_but_keeps_grep() {
        let budget = ContentCacheBudget::with_max_files(0);
        assert_eq!(budget.max_files, 0);
        assert!(budget.is_exhausted());
        // Uncached grep is gated on max_file_size, which must survive
        assert_eq!(budget.max_file_size, MAX_FFFILE_SIZE);
        assert!(budget.max_bytes > 0);
    }

    #[test]
    fn with_max_files_keeps_default_byte_caps() {
        let budget = ContentCacheBudget::with_max_files(2000);
        let default = ContentCacheBudget::default();
        assert_eq!(budget.max_bytes, default.max_bytes);
        assert_eq!(budget.max_file_size, default.max_file_size);
    }
}
