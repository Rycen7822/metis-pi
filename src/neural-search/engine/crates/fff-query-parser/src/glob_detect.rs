//! Glob wildcard detection using the delivered zlob backend.
#[inline]
pub fn has_wildcards(s: &str) -> bool {
    zlob::has_wildcards(s, zlob::ZlobFlags::RECOMMENDED)
}
