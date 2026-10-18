/// Largest file whose full content fff will touch: the default grep read cap
/// (`GrepSearchOptions::max_file_size`) and the content-cache mmap cap
/// (`ContentCacheBudget::max_file_size`). Binary detection also streams up to
/// this far so nothing grep would read is left unclassified.
pub const MAX_FFFILE_SIZE: u64 = 10 * 1024 * 1024;

/// Historical scan partition boundary. Keep the original indexable/non-indexable
/// layout and inherited stable tie order even without a content index.
pub const MAX_INDEXABLE_FILE_SIZE: usize = 2 * 1024 * 1024;

/// Total bytes the persistent content mmap cache may hold for a small repo.
pub const MAX_CACHED_CONTENT_BYTES: u64 = 512 * 1024 * 1024;

/// Files below one page waste the remainder when mmapped, so the cache skips
/// them and falls back to chunked reads on Linux x64.
pub const MMAP_THRESHOLD: u64 = 4 * 1024;

/// Watcher overflow capacity reserved after the initial scan
pub const MAX_OVERFLOW_FILES: usize = 1024;

/// Minimum delay between watcher-initiated rescans.
pub const RESCAN_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Rescan delay for large indexes.
pub const RESCAN_MIN_INTERVAL_LARGE_INDEX: std::time::Duration =
    std::time::Duration::from_secs(5 * 60);

/// Live-file count at which [`RESCAN_MIN_INTERVAL_LARGE_INDEX`] takes over.
pub const LARGE_INDEX_FILE_COUNT: usize = 1_000_000;

/// Fresh-mmap threshold: files at or above this size get mmapped directly on
/// cache miss instead of chunked reads into Vec. Preserve the Linux x64 cutoff.
pub const FRESH_MMAP_THRESHOLD: u64 = 256 * 1024;

pub const PATH_BUF_SIZE: usize = libc::PATH_MAX as usize;
