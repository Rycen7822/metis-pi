use super::grep::{GrepContext, perform_grep};
use super::prefilter::prefilter_files;
use super::sink::{SinkState, debug_assert_newline_terminator};
use super::types::{GrepResult, GrepSearchOptions};
use crate::types::{ContentCacheBudget, FileItem, FileSliceExt};
use aho_corasick::AhoCorasick;
use fff_grep::{
    Searcher, SearcherBuilder, Sink, SinkMatch,
    matcher::{Match, Matcher, NoError},
};
use smallvec::SmallVec;
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

/// Sink for Aho-Corasick multi-pattern mode.
///
/// Collects all pattern match positions on each matched line for highlighting.
struct AhoCorasickSink<'a> {
    state: SinkState,
    matcher: &'a AhoCorasickMatcher<'a>,
}

impl Sink for AhoCorasickSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        debug_assert_newline_terminator(searcher);
        if self.state.max_matches != 0 && self.state.matches.len() >= self.state.max_matches {
            return Ok(false);
        }

        let line_bytes = mat.bytes();
        let (display_bytes, display_len, line_number, byte_offset) =
            SinkState::prepare_line(line_bytes, mat);

        let line_content = String::from_utf8_lossy(display_bytes).into_owned();
        let mut match_byte_offsets: SmallVec<[(u32, u32); 4]> = SmallVec::new();
        let mut col = 0usize;
        let mut first = true;

        let mut collect_match = |m: aho_corasick::Match| {
            let abs_start = m.start() as u32;
            let abs_end = (m.end() as u32).min(display_len);
            if first {
                col = abs_start as usize;
                first = false;
            }
            match_byte_offsets.push((abs_start, abs_end));
        };
        if self.matcher.exact.is_empty() {
            for found in self.matcher.ac.find_iter(display_bytes) {
                collect_match(found);
            }
        } else {
            let mut at = 0;
            for found in self.matcher.ac.find_overlapping_iter(display_bytes) {
                if found.start() >= at && self.matcher.accepts(display_bytes, &found) {
                    at = found.end();
                    collect_match(found);
                }
            }
        }

        let (context_before, context_after, context_truncated) = self.state.extract_context(mat);
        self.state.push_match(
            mat,
            line_number,
            col,
            byte_offset,
            line_content,
            match_byte_offsets,
            context_before,
            context_after,
            context_truncated,
        );
        Ok(true)
    }

    fn finish(&mut self, _: &Searcher, _: &fff_grep::SinkFinish) -> Result<(), Self::Error> {
        Ok(())
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

    let casing = options.effective_casing();
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

    let searcher = {
        let mut b = SearcherBuilder::new();
        b.line_number(true);
        b
    }
    .build();

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
            let state = SinkState {
                file_index: 0,
                matches: Vec::with_capacity(4),
                max_matches,
                before_context: options.before_context,
                after_context: options.after_context,
            };

            let mut sink = AhoCorasickSink {
                state,
                matcher: &ac_matcher,
            };

            if let Err(e) = searcher.search_slice(&ac_matcher, file_bytes, &mut sink) {
                tracing::error!(error = %e, "Grep (aho-corasick multi) search failed");
            }

            sink.state.matches
        },
    ))
}
