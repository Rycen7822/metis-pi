/// Largest file whose full content fff will touch: the default grep read cap
/// (`GrepSearchOptions::max_file_size`) and the content-cache read cap
/// (`ContentCacheBudget::max_file_size`). Binary detection also streams up to
/// this far so nothing grep would read is left unclassified.
pub const MAX_FFFILE_SIZE: u64 = 10 * 1024 * 1024;

/// Historical scan partition boundary. Keep the original indexable/non-indexable
/// layout and inherited stable tie order even without a content index.
pub const MAX_INDEXABLE_FILE_SIZE: usize = 2 * 1024 * 1024;

/// Total bytes the persistent immutable content cache may hold for a small repo.
pub const MAX_CACHED_CONTENT_BYTES: u64 = 512 * 1024 * 1024;

/// Preserve small-file cache admission: sub-4 KiB reads use scratch buffers
/// without consuming the finite persistent-entry budget.
pub const MIN_CACHED_CONTENT_SIZE: u64 = 4 * 1024;

/// Watcher overflow capacity reserved after the initial scan
pub const MAX_OVERFLOW_FILES: usize = 1024;

/// Minimum delay between watcher-initiated rescans.
pub const RESCAN_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Rescan delay for large indexes.
pub const RESCAN_MIN_INTERVAL_LARGE_INDEX: std::time::Duration =
    std::time::Duration::from_secs(5 * 60);

/// Live-file count at which [`RESCAN_MIN_INTERVAL_LARGE_INDEX`] takes over.
pub const LARGE_INDEX_FILE_COUNT: usize = 1_000_000;

// Longest indexed relative/absolute path the stack buffers accept. Linux uses
// the kernel limit; Windows MAX_PATH is 260 UTF-16 units, which can expand to
// three UTF-8 bytes per unit, so keep a separate, larger byte budget.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub const PATH_BUF_SIZE: usize = libc::PATH_MAX as usize;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub const PATH_BUF_SIZE: usize = 4096;
