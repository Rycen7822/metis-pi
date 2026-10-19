//! Live grep. `grep.rs` implements the main plain-text path, the parallel
//! scan engine, and the `grep_search_pattern` entry point that picks the matcher/sink
//! for every mode in one place; `regex`, `multi_pattern`, and `fuzzy_grep`
//! hold the mode-specific machinery on top of the shared `prefilter`/`sink`.

#[allow(clippy::module_inception)]
mod grep;
pub(crate) use grep::grep_search_pattern;

mod fuzzy_grep;
mod multi_pattern;
mod prefilter;
mod regex;
mod sink;
mod types;

pub(crate) use multi_pattern::multi_grep_search;
pub use types::*;

/// Pure chunk sizing plan: (base, maximum, growth factor). Each executor keeps
/// its own scan loop, cancellation checks, and result delivery boundaries.
fn chunk_plan(threads: usize, candidates: usize, total_files: usize) -> (usize, usize, usize) {
    let base = threads * 4;
    let prefilter_strong = total_files > 0 && candidates * 2 < total_files;
    let max = if prefilter_strong {
        base
    } else {
        (base * 256).max(8 * 1024)
    };
    let growth = if prefilter_strong { 1 } else { 2 };
    (base, max, growth)
}

#[cfg(test)]
mod grep_tests;
