use std::path::{Path, PathBuf};

pub fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path)
}

/// Stored Linux paths retain literal backslashes; `/` is the only separator.
#[inline]
pub fn to_canonical_slashes(rel: &str) -> std::borrow::Cow<'_, str> {
    std::borrow::Cow::Borrowed(rel)
}

/// Linux path reconstruction needs no separator rewriting.
#[inline]
pub fn nativize_slashes_in_place(_bytes: &mut [u8]) {}

pub fn normalize(path: PathBuf) -> PathBuf {
    path
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(stripped) = path.strip_prefix("~/")
        && let Some(home_dir) = dirs::home_dir()
    {
        return home_dir.join(stripped);
    }

    PathBuf::from(path)
}

/// Calculate distance penalty based on directory proximity.
/// Returns a negative penalty score based on how far the candidate is from the current file.
///
/// `candidate_dir` is the directory portion of the candidate path (e.g. `"src/components/"`).
/// It may have a trailing `/` which is stripped internally.
///
/// Zero-allocation: walks both directory part iterators in lockstep.
pub fn calculate_distance_penalty(current_file: Option<&str>, candidate_dir: &str) -> i32 {
    let Some(current_path) = current_file else {
        return 0;
    };

    let current_dir = Path::new(current_path).parent().unwrap_or(Path::new(""));
    let candidate = Path::new(candidate_dir);

    if current_dir == candidate {
        return 0;
    }

    let mut current_parts = current_dir.components();
    let mut candidate_parts = candidate.components();

    let mut common_len = 0usize;
    let mut current_total = 0usize;

    loop {
        match (current_parts.next(), candidate_parts.next()) {
            (Some(a), Some(b)) => {
                current_total += 1;
                if a == b {
                    common_len += 1;
                } else {
                    current_total += current_parts.count();
                    break;
                }
            }
            (Some(_), None) => {
                current_total += 1 + current_parts.count();
                break;
            }
            (None, _) => {
                break;
            }
        }
    }

    let depth_from_common = current_total - common_len;
    if depth_from_common == 0 {
        return 0;
    }

    (-(depth_from_common as i32)).max(-20)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_distance_penalty() {
        // candidate_dir is now just the directory portion (with or without trailing /)
        assert_eq!(calculate_distance_penalty(None, "examples/user/test/"), 0);
        // Same directory
        assert_eq!(
            calculate_distance_penalty(Some("examples/user/test/main.rs"), "examples/user/test/"),
            0
        );
        //
        // One level apart
        assert_eq!(
            calculate_distance_penalty(
                Some("examples/user/test/subdir/file.rs"),
                "examples/user/test/"
            ),
            -1
        );
        //
        // Different subdirectories (same parent)
        assert_eq!(
            calculate_distance_penalty(
                Some("examples/user/test/dir1/file.rs"),
                "examples/user/test/dir2/"
            ),
            -1
        );

        assert_eq!(
            calculate_distance_penalty(
                Some("examples/audio-announce/src/lib/audio-announce.rs"),
                "examples/audio-announce/src/"
            ),
            -1
        );

        assert_eq!(
            calculate_distance_penalty(
                Some("examples/audio-announce/src/audio-announce.rs"),
                "examples/pixel/src/"
            ),
            -2
        );

        // Root level files (empty dir)
        assert_eq!(calculate_distance_penalty(Some("main.rs"), ""), 0);
    }
}
