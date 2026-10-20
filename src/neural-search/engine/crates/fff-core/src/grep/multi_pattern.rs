use super::grep::{GrepContext, perform_grep};
use super::prefilter::prefilter_files;
use super::sink::SinkState;
use super::types::{GrepResult, GrepSearchOptions};
use crate::types::{ContentCacheBudget, FileItem, FileSliceExt};
use aho_corasick::AhoCorasick;
use fff_grep::{
    Searcher,
    matcher::{Match, Matcher, NoError},
};
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// A `grep_matcher::Matcher` backed by Aho-Corasick for multi-pattern search.
///
/// Finds the first occurrence of any pattern starting at the given offset.
/// Always reports `\n` as the line terminator for the fast candidate-line path.
struct AhoCorasickMatcher<'a> {
    ac: AhoCorasick,
    // Only mixed casing needs candidate verification; IDs preserve input order.
    exact: Vec<Option<&'a [u8]>>,
}

impl AhoCorasickMatcher<'_> {
    fn accepts(&self, haystack: &[u8], found: &aho_corasick::Match) -> bool {
        self.exact
            .get(found.pattern().as_usize())
            .copied()
            .flatten()
            .is_none_or(|pattern| &haystack[found.start()..found.end()] == pattern)
    }
}

impl Matcher for AhoCorasickMatcher<'_> {
    type Error = NoError;

    #[inline]
    fn find_at(&self, haystack: &[u8], at: usize) -> std::result::Result<Option<Match>, NoError> {
        let haystack = &haystack[at..];
        let found = if self.exact.is_empty() {
            self.ac.find(haystack)
        } else {
            // Overlap is necessary: an invalid folded candidate must not hide
            // a valid pattern starting inside it. Scan once, not once per group.
            self.ac
                .find_overlapping_iter(haystack)
                .find(|found| self.accepts(haystack, found))
        };
        Ok(found.map(|found| Match::new(at + found.start(), at + found.end())))
    }

    #[inline]
    fn line_terminator(&self) -> Option<fff_grep::LineTerminator> {
        Some(fff_grep::LineTerminator::byte(b'\n'))
    }
}

/// Multi-pattern OR search using Aho-Corasick.
///
/// A single automaton retains the uniform-casing fast path. Mixed smart-case
/// uses ASCII-folded candidates with per-pattern exact verification, rather
/// than repeated suffix scans or regex OR.
///
/// Returns the same `GrepResult` type as `grep_search_pattern`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn multi_grep_search<'a>(
    files: &'a [FileItem],
    patterns: &[&str],
    constraints: &[fff_query_parser::Constraint<'_>],
    options: &GrepSearchOptions,
    budget: &ContentCacheBudget,
    abort_signal: &AtomicBool,
    base_path: &Path,
    arena: crate::simd_path::ArenaPtr,
    overflow_arena: crate::simd_path::ArenaPtr,
) -> Result<GrepResult<'a>, aho_corasick::BuildError> {
    let total_files = files.live_count();
    let patterns: Vec<_> = patterns
        .iter()
        .copied()
        .filter(|pattern| !pattern.is_empty())
        .collect();
    if patterns.is_empty() {
        return Ok(GrepResult::empty(total_files, total_files));
    }

    // Constraints are separate from patterns, so a miss must not broaden the search.
    let (files_to_search, filtered_file_count) =
        prefilter_files(files, constraints, options, arena, overflow_arena);

    if files_to_search.is_empty() {
        return Ok(GrepResult::empty(total_files, filtered_file_count));
    }

    let casing = options.casing;
    let insensitive = patterns
        .iter()
        .any(|pattern| casing.is_insensitive_for(pattern));
    let mixed = insensitive
        && patterns
            .iter()
            .any(|pattern| !casing.is_insensitive_for(pattern));
    let exact = if mixed {
        patterns
            .iter()
            .map(|pattern| (!casing.is_insensitive_for(pattern)).then_some(pattern.as_bytes()))
            .collect()
    } else {
        Vec::new()
    };
    let ac = aho_corasick::AhoCorasickBuilder::new()
        .ascii_case_insensitive(insensitive)
        .build(&patterns)?;

    let searcher = Searcher::new();

    let ac_matcher = AhoCorasickMatcher { ac, exact };
    Ok(perform_grep(
        &files_to_search,
        options,
        &GrepContext {
            total_files,
            filtered_file_count,
            budget,
            base_path,
            arena,
            overflow_arena,
            prefilter: None, // no memmem prefilter for multi-pattern search
            abort_signal,
        },
        |file_bytes: &[u8], max_matches: usize| {
            let mut sink =
                SinkState::new(max_matches, options.before_context, options.after_context);

            if let Err(e) = searcher.search_slice(&ac_matcher, file_bytes, &mut sink) {
                tracing::error!(error = %e, "Grep (aho-corasick multi) search failed");
            }

            sink.matches
        },
    ))
}
