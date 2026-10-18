//! Filesystem traversal using zlob's native parallel walker.

use crate::types::FileItem;
use std::path::Path;

mod zlob;
pub(crate) use zlob::walk_collect_files;

pub(crate) struct WalkOutput {
    pub(crate) pairs: Vec<(FileItem, String)>,
    /// Every non-ignored directory the walk visited, relative, ending with /
    pub(crate) dirs: Vec<String>,
    pub(crate) ignore_rules: Option<WalkIgnoreRules>,
}

pub(crate) struct WalkIgnoreRules {
    inner: ::zlob::walk::WalkerOutcomeRules,
}

// SAFETY: the underlying storage is immutable, heap-owned, and thread-safe to
// read from concurrently (mirrors zlob's `IgnoreRules: Send + Sync`).
unsafe impl Send for WalkIgnoreRules {}
unsafe impl Sync for WalkIgnoreRules {}

impl std::fmt::Debug for WalkIgnoreRules {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WalkIgnoreRules")
    }
}

impl WalkIgnoreRules {
    /// Returns `true` if the provided path is ignored by the collected rule set
    ///
    /// `relative_path` has to be relative to the walker's provided base path
    pub(crate) fn is_ignored(&self, relative_path: &Path) -> bool {
        self.inner
            .rules()
            .is_some_and(|rules| rules.is_ignored(relative_path))
    }

    // The old `is_ignored_untrusted` variant was folded away when zlob's
    // ignore matcher moved to full ancestor enumeration — trailing-slash
    // sniffing on the input is now sufficient for external queries.
}

#[cfg(test)]
mod tests {
    use super::walk_collect_files;
    use std::fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // The walker must respect .gitignore and surface the expected file set
    // with a correct synced count.
    #[test]
    fn collects_files_respecting_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::write(root.join("Cargo.toml"), "x").unwrap();
        fs::write(root.join("debug.log"), "").unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("target/out.bin"), "bin").unwrap();

        let counter = Arc::new(AtomicUsize::new(0));
        let out = walk_collect_files(root, true, false, 1, &counter).unwrap();

        let mut names: Vec<String> = out.pairs.into_iter().map(|(_, rel)| rel).collect();
        names.sort();

        assert!(names.contains(&"Cargo.toml".to_string()));
        assert!(names.iter().any(|n| n.ends_with("main.rs")));
        // target/ and *.log are gitignored; .git/ is skipped.
        assert!(!names.iter().any(|n| n.contains("target")));
        assert!(!names.iter().any(|n| n.ends_with(".log")));
        assert!(!names.iter().any(|n| n.contains(".git/")));
        assert_eq!(counter.load(Ordering::Relaxed), names.len());
    }

    // Non-git roots prune known non-code directories (node_modules).
    #[test]
    fn prunes_non_code_dirs_for_non_git_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/lib.js"), "x").unwrap();
        fs::write(root.join("index.js"), "x").unwrap();

        let counter = Arc::new(AtomicUsize::new(0));
        let out = walk_collect_files(root, false, false, 1, &counter).unwrap();
        let names: Vec<String> = out.pairs.into_iter().map(|(_, rel)| rel).collect();

        assert!(names.iter().any(|n| n.ends_with("index.js")));
        assert!(!names.iter().any(|n| n.contains("node_modules")));
    }

    // Reusable ignore rules must match the same tree the walk respected.
    #[test]
    fn surfaces_reusable_ignore_rules() {
        use std::path::Path;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::write(root.join("Cargo.toml"), "x").unwrap();

        let counter = Arc::new(AtomicUsize::new(0));
        let out = walk_collect_files(root, true, false, 1, &counter).unwrap();

        let rules = out.ignore_rules.expect("zlob surfaces ignore rules");
        assert!(rules.is_ignored(Path::new("target/")));
        assert!(rules.is_ignored(Path::new("debug.log")));
        assert!(!rules.is_ignored(Path::new("Cargo.toml")));
    }
}
