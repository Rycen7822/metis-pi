use std::path::Path;

/// Directories excluded when walking a non-git Linux root.
pub(crate) const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "__pycache__",
    "venv",
    ".venv",
    "target/debug",
    "target/release",
    "target/rust-analyzer",
    "target/criterion",
    "go/pkg/mod",
    ".cargo/registry",
    ".rustup/toolchains",
    ".gradle/caches",
    ".m2/repository",
    ".npm/_cacache",
    ".pub-cache",
    ".local/state",
];

pub(crate) fn is_non_code_directory(path: &Path) -> bool {
    let path_str = path.as_os_str().to_str().unwrap_or("");
    IGNORED_DIRS.iter().any(|&dir| {
        // Entries are gitignore patterns for the walker; this predicate uses
        // substrings, so strip a leading wildcard before checking.
        path_str.contains(dir.strip_prefix('*').unwrap_or(dir))
    })
}
