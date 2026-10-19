use super::types::GrepMatch;
use fff_grep::{Searcher, SinkMatch};

/// Maximum bytes of a matched line to keep for display. Prevents minified
/// JS or huge single-line files from blowing up memory.
pub(super) const MAX_LINE_DISPLAY_LEN: usize = 512;

#[inline]
pub(super) fn debug_assert_newline_terminator(searcher: &Searcher) {
    debug_assert_eq!(
        searcher.line_terminator(),
        fff_grep::LineTerminator::byte(b'\n'),
        "sink helpers assume \\n line terminators (see module invariant)"
    );
}

#[inline]
pub(super) fn strip_line_terminators(bytes: &[u8]) -> &[u8] {
    let mut len = bytes.len();
    while len > 0 && matches!(bytes[len - 1], b'\n' | b'\r') {
        len -= 1;
    }
    &bytes[..len]
}

pub(super) struct SinkState {
    pub(super) matches: Vec<GrepMatch>,
    pub(super) max_matches: usize,
    pub(super) before_context: usize,
    pub(super) after_context: usize,
}

impl SinkState {
    pub(super) fn new(max_matches: usize, before_context: usize, after_context: usize) -> Self {
        Self {
            matches: Vec::with_capacity(4),
            max_matches,
            before_context,
            after_context,
        }
    }

    #[inline]
    pub(super) fn prepare_line<'a>(mat: &'a SinkMatch<'_>) -> (&'a [u8], u64) {
        let trimmed = strip_line_terminators(mat.bytes());
        (truncate_display_bytes(trimmed), mat.line_number())
    }

    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn push_match(
        &mut self,
        mat: &SinkMatch<'_>,
        line_number: u64,
        line_content: String,
        context_before: Vec<String>,
        context_after: Vec<String>,
        context_truncated: bool,
    ) {
        let raw = strip_line_terminators(mat.bytes());
        // Exclude only the structural final LF; coalesced blank rows still count.
        let covered = mat.bytes().strip_suffix(b"\n").unwrap_or(mat.bytes());
        self.matches.push(GrepMatch {
            native_multiline_limited: mat.may_cross_line() || covered.contains(&b'\n'),
            native_output_truncated: context_truncated
                || raw.len() > truncate_display_bytes(raw).len(),
            file_index: 0,
            line_number,
            line_content,
            context_before,
            context_after,
        });
    }

    /// Extract context lines from the full buffer around a matched region.
    pub(super) fn extract_context(&self, mat: &SinkMatch<'_>) -> (Vec<String>, Vec<String>, bool) {
        if self.before_context == 0 && self.after_context == 0 {
            return (Vec::new(), Vec::new(), false);
        }
        let mut output_truncated = false;

        let buffer = mat.buffer();
        let range = mat.bytes_range_in_buffer();

        let mut before = Vec::new();
        if self.before_context > 0 && range.start > 0 {
            // Walk backward from the start of the match line to find preceding lines
            let mut pos = range.start;
            let mut lines_found = 0;
            while lines_found < self.before_context && pos > 0 {
                // Skip the newline just before our current position
                pos -= 1;
                // Find the previous newline
                let line_start = match memchr::memrchr(b'\n', &buffer[..pos]) {
                    Some(nl) => nl + 1,
                    None => 0,
                };
                let line = &buffer[line_start..pos];
                // Trim trailing \r
                let line = if line.last() == Some(&b'\r') {
                    &line[..line.len() - 1]
                } else {
                    line
                };
                let truncated = truncate_display_bytes(line);
                output_truncated |= truncated.len() < line.len();
                before.push(String::from_utf8_lossy(truncated).into_owned());
                pos = line_start;
                lines_found += 1;
            }
            before.reverse();
        }

        let mut after = Vec::new();
        if self.after_context > 0 && range.end < buffer.len() {
            let mut pos = range.end;
            let mut lines_found = 0;
            while lines_found < self.after_context && pos < buffer.len() {
                // Find the next newline
                let line_end = match memchr::memchr(b'\n', &buffer[pos..]) {
                    Some(nl) => pos + nl,
                    None => buffer.len(),
                };
                let line = &buffer[pos..line_end];
                // Trim trailing \r
                let line = if line.last() == Some(&b'\r') {
                    &line[..line.len() - 1]
                } else {
                    line
                };
                let truncated = truncate_display_bytes(line);
                output_truncated |= truncated.len() < line.len();
                after.push(String::from_utf8_lossy(truncated).into_owned());
                pos = if line_end < buffer.len() {
                    line_end + 1 // skip past \n
                } else {
                    buffer.len()
                };
                lines_found += 1;
            }
        }

        (before, after, output_truncated)
    }
}

/// Truncate a byte slice for display, respecting UTF-8 char boundaries.
#[inline]
pub(super) fn truncate_display_bytes(bytes: &[u8]) -> &[u8] {
    if bytes.len() <= MAX_LINE_DISPLAY_LEN {
        bytes
    } else {
        let mut end = MAX_LINE_DISPLAY_LEN;
        while end > 0 && !is_utf8_char_boundary(bytes[end]) {
            end -= 1;
        }
        &bytes[..end]
    }
}

/// Split a multiline match blob (from the MultiLine searcher strategy) into
/// the first line and the remaining lines so `line_content` stays single-line.
pub(super) fn split_multiline_blob(display_bytes: &[u8]) -> (&[u8], Vec<String>) {
    match memchr::memchr(b'\n', display_bytes) {
        None => (display_bytes, Vec::new()),
        Some(pos) => {
            let first = strip_line_terminators(&display_bytes[..pos + 1]);
            let extra = display_bytes[pos + 1..]
                .split(|&b| b == b'\n')
                .map(|l| String::from_utf8_lossy(strip_line_terminators(l)).into_owned())
                .collect();
            (first, extra)
        }
    }
}

// copied from the rust u8 private method
#[inline]
const fn is_utf8_char_boundary(b: u8) -> bool {
    (b as i8) >= -0x40
}
