use super::sink::{SinkState, debug_assert_newline_terminator, split_multiline_blob};
use super::types::Casing;
use fff_grep::{
    Searcher, Sink, SinkMatch,
    matcher::{Match, Matcher, NoError},
};

pub(super) fn build_regex(pattern: &str, casing: Casing) -> Result<CompiledRegex, String> {
    if pattern.is_empty() {
        return Err("empty pattern".to_string());
    }

    let case_insensitive = casing.is_insensitive_for(pattern);

    let regex = regex::bytes::RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .multi_line(true)
        .unicode(false)
        .build()
        .map_err(|e| e.to_string())?;
    // This is a native syntax capability, not a data-dependent second search.
    let hir = regex_syntax::ParserBuilder::new()
        .case_insensitive(case_insensitive)
        .multi_line(true)
        .unicode(false)
        .utf8(false)
        .build()
        .parse(pattern)
        .map_err(|e| e.to_string())?;
    Ok(CompiledRegex {
        regex,
        may_match_lf: may_match_lf(&hir),
        legacy_multiline: pattern.contains('\n') || has_newline_escape(pattern),
    })
}

fn may_match_lf(hir: &regex_syntax::hir::Hir) -> bool {
    use regex_syntax::hir::{Class, HirKind};
    match hir.kind() {
        HirKind::Literal(literal) => literal.0.contains(&b'\n'),
        HirKind::Class(Class::Bytes(class)) => class
            .iter()
            .any(|range| range.start() <= b'\n' && b'\n' <= range.end()),
        HirKind::Class(Class::Unicode(class)) => class
            .iter()
            .any(|range| range.start() <= '\n' && '\n' <= range.end()),
        HirKind::Repetition(repetition) if repetition.max == Some(0) => false,
        kind => kind.subs().iter().any(may_match_lf),
    }
}

pub(super) struct CompiledRegex {
    regex: regex::bytes::Regex,
    may_match_lf: bool,
    // Preserve the existing block/coalescing policy independently of capability.
    pub(super) legacy_multiline: bool,
}

/// This compatibility selector is not proof that a pattern consumes LF.
fn has_newline_escape(text: &str) -> bool {
    let mut escaped = false;
    for byte in text.bytes() {
        if escaped && byte == b'n' {
            return true;
        }
        escaped = byte == b'\\' && !escaped;
    }
    false
}

impl Matcher for CompiledRegex {
    type Error = NoError;

    #[inline]
    fn find_at(&self, haystack: &[u8], at: usize) -> Result<Option<Match>, NoError> {
        Ok(self
            .regex
            .find_at(haystack, at)
            .map(|m| Match::new(m.start(), m.end())))
    }

    #[inline]
    fn line_terminator(&self) -> Option<fff_grep::LineTerminator> {
        if self.may_match_lf || self.legacy_multiline {
            None
        } else {
            Some(fff_grep::LineTerminator::byte(b'\n'))
        }
    }
}

pub(super) struct RegexSink {
    pub(super) state: SinkState,
}

impl Sink for RegexSink {
    type Error = std::io::Error;

    fn matched(&mut self, searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        debug_assert_newline_terminator(searcher);
        if self.state.max_matches != 0 && self.state.matches.len() >= self.state.max_matches {
            return Ok(false);
        }
        let (display, line_number) = SinkState::prepare_line(mat);
        let (first_line, extra_after) = split_multiline_blob(display);
        let line_content = String::from_utf8_lossy(first_line).into_owned();
        let (before, mut after, truncated) = self.state.extract_context(mat);
        let after = if extra_after.is_empty() {
            after
        } else {
            let mut combined = extra_after;
            combined.append(&mut after);
            combined
        };
        self.state
            .push_match(mat, line_number, line_content, before, after, truncated);
        Ok(true)
    }
}
