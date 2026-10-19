use super::prefilter::prefilter_files;
use super::regex::{RegexSink, build_regex};
use super::sink::{SinkState, debug_assert_newline_terminator};
use super::types::{GrepMatch, GrepMode, GrepResult, GrepSearchOptions};
use crate::simd_string_utils::memmem;
use crate::types::{ContentCacheBudget, FileItem, FileSliceExt};
use fff_grep::{
    Searcher, SearcherBuilder, Sink, SinkMatch,
    matcher::{Match, Matcher, NoError},
};
use fff_query_parser::Constraint;
use rayon::prelude::*;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tracing::Level;

#[allow(clippy::large_enum_variant)]
pub(super) enum NeedleFinder<'a> {
    CaseSensitive(memchr::memmem::Finder<'a>),
    /// Pre-lowered needle bytes for the SIMD case-insensitive search.
    CaseInsensitive(&'a [u8]),
}

impl<'a> NeedleFinder<'a> {
    fn new(needle: &'a [u8], case_insensitive: bool) -> Self {
        if case_insensitive {
            Self::CaseInsensitive(needle)
        } else {
            Self::CaseSensitive(memchr::memmem::Finder::new(needle))
        }
    }

    #[inline]
    fn find(&self, haystack: &[u8]) -> Option<usize> {
        match self {
            Self::CaseSensitive(finder) => finder.find(haystack),
            Self::CaseInsensitive(needle_lower) => memmem::find(haystack, needle_lower),
        }
    }

    #[inline]
    fn needle(&self) -> &[u8] {
        match self {
            Self::CaseSensitive(finder) => finder.needle(),
            Self::CaseInsensitive(needle_lower) => needle_lower,
        }
    }
}

struct PlainTextMatcher<'a> {
    finder: &'a NeedleFinder<'a>,
}

impl Matcher for PlainTextMatcher<'_> {
    type Error = NoError;

    #[inline]
    fn find_at(&self, haystack: &[u8], at: usize) -> Result<Option<Match>, NoError> {
        let hay = &haystack[at..];
        let needle_len = self.finder.needle().len();

        Ok(self
            .finder
            .find(hay)
            .map(|pos| Match::new(at + pos, at + pos + needle_len)))
    }

    #[inline]
    fn line_terminator(&self) -> Option<fff_grep::LineTerminator> {
        Some(fff_grep::LineTerminator::byte(b'\n'))
    }
}

struct PlainTextSink {
    state: SinkState,
}

impl Sink for PlainTextSink {
    type Error = std::io::Error;

    fn matched(&mut self, searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        debug_assert_newline_terminator(searcher);
        if self.state.max_matches != 0 && self.state.matches.len() >= self.state.max_matches {
            return Ok(false);
        }
        let (display, line_number) = SinkState::prepare_line(mat);
        let line_content = String::from_utf8_lossy(display).into_owned();
        let (before, after, truncated) = self.state.extract_context(mat);
        self.state
            .push_match(mat, line_number, line_content, before, after, truncated);
        Ok(true)
    }
}

/// Search an explicit pattern without decoding or interpreting file-filter syntax.
/// Regex compilation failure is metadata only: the Metis adapter owns the one
/// canonical literal retry, including its LF encoding and unchanged constraints.
#[allow(clippy::too_many_arguments)]
pub(crate) fn grep_search_pattern<'a>(
    files: &'a [FileItem],
    grep_text: &str,
    constraints: &[Constraint<'_>],
    options: &GrepSearchOptions,
    budget: &ContentCacheBudget,
    abort_signal: &AtomicBool,
    base_path: &Path,
    arena: crate::simd_path::ArenaPtr,
    overflow_arena: crate::simd_path::ArenaPtr,
) -> GrepResult<'a> {
    let total_files = files.live_count();
    if grep_text.is_empty() {
        return GrepResult::empty(total_files, total_files);
    }

    let casing = options.effective_casing();
    let case_insensitive = casing.is_insensitive_for(grep_text);
    let regex = match options.mode {
        GrepMode::PlainText => None,
        GrepMode::Fuzzy => {
            let (files_to_search, filtered_file_count) =
                prefilter_files(files, constraints, options, arena, overflow_arena);
            if files_to_search.is_empty() {
                return GrepResult::empty(total_files, filtered_file_count);
            }
            return super::fuzzy_grep::fuzzy_grep_search(
                grep_text,
                &files_to_search,
                options,
                total_files,
                filtered_file_count,
                case_insensitive,
                budget,
                abort_signal,
                base_path,
                arena,
                overflow_arena,
            );
        }
        GrepMode::Regex => match build_regex(grep_text, casing) {
            Ok(compiled) => Some(compiled),
            Err(error) => {
                tracing::warn!(
                    "Regex compilation failed for {}. Error {}",
                    grep_text,
                    error
                );
                let mut result = GrepResult::empty(total_files, 0);
                result.regex_fallback_error = Some(error);
                return result;
            }
        },
    };

    let has_literal_lf = grep_text.contains('\n');
    let is_multiline = has_literal_lf
        || regex
            .as_ref()
            .is_some_and(|compiled| compiled.legacy_multiline);
    let after_context = if has_literal_lf && regex.is_none() && options.after_context == 0 {
        grep_text.bytes().filter(|&b| b == b'\n').count()
    } else {
        options.after_context
    };
    let (files_to_search, filtered_file_count) =
        prefilter_files(files, constraints, options, arena, overflow_arena);
    if files_to_search.is_empty() {
        return GrepResult::empty(total_files, filtered_file_count);
    }
    let searcher = SearcherBuilder::new().multi_line(is_multiline).build();
    let context = GrepContext {
        total_files,
        filtered_file_count,
        budget,
        base_path,
        arena,
        overflow_arena,
        prefilter: None,
        abort_signal,
    };

    if let Some(compiled) = regex {
        perform_grep(
            &files_to_search,
            options,
            &context,
            |file_bytes, max_matches| {
                let mut sink = RegexSink {
                    state: SinkState::new(max_matches, options.before_context, after_context),
                };
                if let Err(error) = searcher.search_slice(&compiled, file_bytes, &mut sink) {
                    tracing::error!(%error, "Grep (regex) search failed");
                }
                sink.state.matches
            },
        )
    } else {
        // Only literal searches need the pattern buffer, finder and prefilter.
        let pattern = if case_insensitive {
            grep_text.as_bytes().to_ascii_lowercase()
        } else {
            grep_text.as_bytes().to_vec()
        };
        let finder = NeedleFinder::new(&pattern, case_insensitive);
        let matcher = PlainTextMatcher { finder: &finder };
        perform_grep(
            &files_to_search,
            options,
            &GrepContext {
                prefilter: Some(&finder),
                ..context
            },
            |file_bytes, max_matches| {
                let mut sink = PlainTextSink {
                    state: SinkState::new(max_matches, options.before_context, after_context),
                };
                if let Err(error) = searcher.search_slice(&matcher, file_bytes, &mut sink) {
                    tracing::error!(%error, "Grep (plain text) search failed");
                }
                sink.state.matches
            },
        )
    }
}

#[derive(Clone, Copy)]
pub(super) struct GrepContext<'a, 'b> {
    pub(super) total_files: usize,
    pub(super) filtered_file_count: usize,
    pub(super) budget: &'a ContentCacheBudget,
    pub(super) base_path: &'a Path,
    pub(super) arena: crate::simd_path::ArenaPtr,
    pub(super) overflow_arena: crate::simd_path::ArenaPtr,
    pub(super) prefilter: Option<&'a NeedleFinder<'b>>,
    pub(super) abort_signal: &'a AtomicBool,
}

impl GrepContext<'_, '_> {
    #[inline]
    fn arena_for_file(&self, file: &FileItem) -> crate::simd_path::ArenaPtr {
        if file.is_overflow() {
            self.overflow_arena
        } else {
            self.arena
        }
    }
}

#[tracing::instrument(
    skip_all,
    level = Level::DEBUG,
    fields(prefiltered_count = files_to_search.len())
)]
pub(super) fn perform_grep<'a, F>(
    files_to_search: &[&'a FileItem],
    options: &GrepSearchOptions,
    ctx: &GrepContext<'_, '_>,
    search_file: F,
) -> GrepResult<'a>
where
    F: Fn(&[u8], usize) -> Vec<GrepMatch> + Sync,
{
    let time_budget = if options.time_budget_ms > 0 {
        Some(std::time::Duration::from_millis(options.time_budget_ms))
    } else {
        None
    };

    let search_start = std::time::Instant::now();
    let page_limit = options.page_limit;
    // Lowest index an abort skipped; everything below it was searched, so it is
    // the resume point for the next page. usize::MAX means no abort happened.
    let first_skipped = AtomicUsize::new(usize::MAX);

    let mut result_files: Vec<&'a FileItem> = Vec::new();
    let mut all_matches: Vec<GrepMatch> = Vec::new();
    let mut files_consumed: usize = 0;
    let mut page_filled = false;
    let mut aborted = false;

    // Each chunk is a rayon barrier. A flat small chunk over 500k files = ~7800
    // barriers; x2 growth makes it logarithmic. But a too-aggressive growth
    // over-scans: when a page fills mid-chunk, the whole submitted chunk still
    // runs.
    //
    // So only grow when the prefilter is weak (large candidate set);
    // when constraints cut the set in half, keep small chunks for cheap page-fill termination.
    let base_chunk = rayon::current_num_threads() * 4;
    let prefilter_strong = ctx.total_files > 0 && files_to_search.len() * 2 < ctx.total_files;
    let max_chunk = if prefilter_strong {
        base_chunk
    } else {
        (base_chunk * 256).max(8 * 1024)
    };
    let growth = if prefilter_strong { 1 } else { 2 };
    let mut chunk_size = base_chunk;
    let mut chunk_start = 0;

    while chunk_start < files_to_search.len() {
        let chunk_end = (chunk_start + chunk_size).min(files_to_search.len());
        let chunk = &files_to_search[chunk_start..chunk_end];
        chunk_start = chunk_end;
        chunk_size = (chunk_size * growth).min(max_chunk);
        let chunk_offset = files_consumed;

        // Unless enforced, the budget stays dormant until something matched.
        let budget = time_budget.filter(|_| options.enforce_time_budget || !all_matches.is_empty());

        let chunk_results: Vec<(usize, &'a FileItem, Vec<GrepMatch>)> = chunk
            .par_iter()
            .enumerate()
            .map_init(
                // Rayon job-local scratch is initialized only for an uncached read.
                || (None, false),
                |(buf, aborted), (local_idx, file)| {
                    // check the clock on every 8th file only; `aborted` latches for the
                    // rest of this worker's range. File 0 is never skipped so a page
                    // always consumes at least one file (cursor 0 means "done").
                    let idx = chunk_offset + local_idx;
                    if !*aborted && local_idx % 8 == 0 && idx > 0 {
                        *aborted = ctx.abort_signal.load(Ordering::Relaxed)
                            || budget.is_some_and(|b| search_start.elapsed() > b);
                    }
                    if *aborted {
                        first_skipped.fetch_min(idx, Ordering::Relaxed);
                        return None;
                    }

                    let content = file.get_content_for_search(
                        buf,
                        ctx.arena_for_file(file),
                        ctx.base_path,
                        ctx.budget,
                    )?;

                    // Fast whole-file memmem check before entering the
                    // grep-searcher machinery. Skips Vec alloc, Searcher
                    // setup, and line-splitting for files that can't match.
                    if let Some(pf) = ctx.prefilter
                        && pf.find(content).is_none()
                    {
                        return None;
                    }

                    let file_matches = search_file(content, options.max_matches_per_file);

                    if file_matches.is_empty() {
                        return None;
                    }

                    Some((idx, *file, file_matches))
                },
            )
            .flatten()
            .collect();

        // Every file in the chunk was visited unless an abort cut it short.
        let resume_at = first_skipped.load(Ordering::Relaxed);
        aborted = resume_at != usize::MAX;
        files_consumed = resume_at.min(chunk_offset + chunk.len());

        for (batch_idx, file, file_matches) in chunk_results {
            // Matches past the abort point are dropped; the next page re-searches them.
            if batch_idx >= resume_at {
                continue;
            }

            let file_result_idx = result_files.len();
            result_files.push(file);

            for mut m in file_matches {
                m.file_index = file_result_idx;
                all_matches.push(m);
            }

            if all_matches.len() >= page_limit {
                // Tighten files_consumed to the file that tipped us over so
                // the next page resumes right after it.
                files_consumed = batch_idx + 1;
                page_filled = true;
                break;
            }
        }

        if page_filled || aborted {
            break;
        }
    }

    // No match and no abort means the whole slice was searched.
    if result_files.is_empty() && !aborted {
        files_consumed = files_to_search.len();
    }

    let has_more = (aborted || page_filled) && files_consumed < files_to_search.len();

    let next_file_offset = if has_more {
        options.file_offset + files_consumed
    } else {
        0
    };

    GrepResult {
        matches: all_matches,
        files_with_matches: result_files.len(),
        files: result_files,
        total_files_searched: files_consumed,
        total_files: ctx.total_files,
        filtered_file_count: ctx.filtered_file_count,
        next_file_offset,
        regex_fallback_error: None,
    }
}
