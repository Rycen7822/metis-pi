use crate::ConstraintVec;
use crate::config::ParserConfig;
use crate::constraints::{Constraint, GitStatusFilter, TextPartsBuffer};
use crate::glob_detect::has_wildcards;
use crate::location::{Location, parse_location};

#[derive(Debug, Clone, PartialEq)]
pub enum FuzzyQuery<'a> {
    Parts(TextPartsBuffer<'a>),
    Text(&'a str),
    Empty,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FFFQuery<'a> {
    /// The original raw query string before parsing
    pub raw_query: &'a str,
    /// Parsed constraints borrowing their text from the query.
    pub constraints: ConstraintVec<'a>,
    pub fuzzy_query: FuzzyQuery<'a>,
    /// Parsed location (e.g., file:12:4 -> line 12, col 4)
    pub location: Option<Location>,
}

impl<'a> FFFQuery<'a> {
    /// Parse query and execute, perfectly paired with configuration presets
    ///
    /// ```
    /// use fff_query_parser::{FFFQuery, FileSearchConfig};
    ///
    /// let query = FFFQuery::parse("file *.rs", FileSearchConfig);
    /// ```
    pub fn parse(query: &'a str, config: impl ParserConfig) -> Self {
        QueryParser::new(config).parse(query)
    }
}

/// Main query parser - zero-cost wrapper around configuration
#[derive(Debug)]
pub struct QueryParser<C: ParserConfig> {
    config: C,
}

impl<C: ParserConfig> QueryParser<C> {
    pub fn new(config: C) -> Self {
        Self { config }
    }

    /// Parse a field containing only constraints.
    pub fn parse_constraints<'a>(&self, query: &'a str) -> ConstraintVec<'a> {
        query
            .split_whitespace()
            .filter_map(|token| parse_token(token, &self.config))
            .collect()
    }

    pub fn parse<'a>(&self, query: &'a str) -> FFFQuery<'a> {
        let raw_query = query;
        let config: &C = &self.config;
        let mut constraints = ConstraintVec::new();
        let query = query.trim();

        // Single token - check if it's a constraint or plain text
        if !query.chars().any(char::is_whitespace) {
            // Try to parse as constraint first
            if let Some(constraint) = parse_token(query, config) {
                // Don't treat filename tokens (FilePath) as constraints in single-token
                // queries — the user is fuzzy-searching, not filtering. FilePath constraints
                // are only useful as filters in multi-token queries like "score.rs search".
                //
                // Path segments also stay text, so absolute paths can reach
                // location parsing below instead of becoming filters.
                if !matches!(
                    constraint,
                    Constraint::FilePath(_) | Constraint::PathSegment(_)
                ) {
                    constraints.push(constraint);
                    return FFFQuery {
                        raw_query,
                        constraints,
                        fuzzy_query: FuzzyQuery::Empty,
                        location: None,
                    };
                }
            }

            // Try to extract location from single token (e.g., "file:12")
            if config.enable_location() {
                let (query_without_loc, location) = parse_location(query);
                if location.is_some() {
                    return FFFQuery {
                        raw_query,
                        constraints,
                        fuzzy_query: FuzzyQuery::Text(query_without_loc),
                        location,
                    };
                }
            }

            // Plain text single token
            return FFFQuery {
                raw_query,
                constraints,
                fuzzy_query: if query.is_empty() {
                    FuzzyQuery::Empty
                } else {
                    FuzzyQuery::Text(query)
                },
                location: None,
            };
        }

        let mut text_parts = TextPartsBuffer::new();
        let tokens = query.split_whitespace();

        // Track the FilePath token position in constraints so we can promote
        // it back to text if the final query ends up with no fuzzy text.
        let mut file_path: Option<(usize, &str)> = None;
        for token in tokens {
            match parse_token(token, config) {
                Some(Constraint::FilePath(_)) => {
                    if file_path.is_some() {
                        // Only one FilePath constraint allowed; treat extra path
                        // tokens as literal text (e.g. an import path the user is
                        // searching for).
                        text_parts.push(token);
                    } else {
                        file_path = Some((constraints.len(), token));
                        constraints.push(Constraint::FilePath(token));
                    }
                }
                Some(constraint) => {
                    constraints.push(constraint);
                }
                None => {
                    text_parts.push(token);
                }
            }
        }

        // If the query produced a single FilePath and no fuzzy text parts, the
        // user isn't filtering by filename suffix — they're fuzzy-searching
        // for that name (the only other constraints are path-scoping like
        // PathSegment/Extension/Glob). Mirror the single-token rule at
        // parser.rs:48-64: promote FilePath → fuzzy text so e.g. `profile.h`
        // alongside `chrome/browser/profiles/` fuzzy-matches all `profile*.h`
        // files instead of only one file literally ending in `/profile.h`.
        if text_parts.is_empty()
            && let Some((idx, tok)) = file_path
        {
            constraints.remove(idx);
            text_parts.push(tok);
        }

        // Try to extract location from the last fuzzy token
        // e.g., "search file:12" -> fuzzy="search file", location=Line(12)
        let location = if config.enable_location() && !text_parts.is_empty() {
            let last_idx = text_parts.len() - 1;
            let (without_loc, loc) = parse_location(text_parts[last_idx]);
            if loc.is_some() {
                // Update the last part to be without the location suffix
                text_parts[last_idx] = without_loc;
                loc
            } else {
                None
            }
        } else {
            None
        };

        let fuzzy_query = if text_parts.is_empty() {
            FuzzyQuery::Empty
        } else if text_parts.len() == 1 {
            // If the only remaining text is empty after location extraction, treat as Empty
            if text_parts[0].is_empty() {
                FuzzyQuery::Empty
            } else {
                FuzzyQuery::Text(text_parts[0])
            }
        } else {
            // Filter out empty parts that might result from location extraction
            if text_parts.iter().all(|p| p.is_empty()) {
                FuzzyQuery::Empty
            } else {
                FuzzyQuery::Parts(text_parts)
            }
        };

        FFFQuery {
            raw_query,
            constraints,
            fuzzy_query,
            location,
        }
    }
}

impl Default for QueryParser<crate::FileSearchConfig> {
    fn default() -> Self {
        Self::new(crate::FileSearchConfig)
    }
}

#[inline]
fn parse_token<'a, C: ParserConfig>(token: &'a str, config: &C) -> Option<Constraint<'a>> {
    match token.as_bytes().first()? {
        b'!' => parse_negation(token, config),
        // Positive incomplete extension patterns stay text. Negated patterns
        // deliberately still reach glob detection (e.g. !* in file search).
        b'*' if config.enable_extension() && (token == "*" || token == "*.") => None,
        _ => parse_constraint_token(token, config, TokenContext::Positive),
    }
}

/// Parse extension pattern: *.rs -> Extension("rs")
#[inline]
fn parse_extension(token: &str) -> Option<Constraint<'_>> {
    if token.len() > 2 && token.starts_with("*.") {
        Some(Constraint::Extension(&token[2..]))
    } else {
        None
    }
}

/// Parse negation pattern: !*.rs -> Not(Extension("rs")), !test -> Not(Text("test"))
/// This allows negating any constraint type
#[inline]
fn parse_negation<'a, C: ParserConfig>(token: &'a str, config: &C) -> Option<Constraint<'a>> {
    if token.len() <= 1 {
        return None;
    }

    let inner_token = &token[1..];

    // Try to parse the inner token as any constraint
    if let Some(inner_constraint) =
        parse_constraint_token(inner_token, config, TokenContext::Negated)
    {
        // Wrap it in a Not constraint
        return Some(Constraint::Not(Box::new(inner_constraint)));
    }

    // Negated text (!test) requires ≥3 inner chars with at least one alphanumeric,
    // so operators like `!=`, `!==`, `!!` stay literal search text.
    if inner_token.len() < 3 || !inner_token.chars().any(|c| c.is_alphanumeric()) {
        return None;
    }
    Some(Constraint::Not(Box::new(Constraint::Text(inner_token))))
}

enum TokenContext {
    Positive,
    Negated,
}

/// Shared, non-recursive constraint grammar. Filename precedence deliberately
/// differs: positive tokens prefer filenames over globs/key:value, while
/// negated tokens only try filenames after those forms have been considered.
#[inline]
fn parse_constraint_token<'a, C: ParserConfig>(
    token: &'a str,
    config: &C,
    context: TokenContext,
) -> Option<Constraint<'a>> {
    // Backslash escape: \token stays literal, including its original backslash.
    // Content needles bypass this parser entirely.
    if token.starts_with('\\') && token.len() > 1 {
        return None;
    }

    let first_byte = token.as_bytes().first()?;

    match first_byte {
        b'*' if config.enable_extension() => {
            // Try extension first (*.rs) - simple patterns without additional wildcards
            if let Some(constraint) = parse_extension(token) {
                let ext_part = &token[2..];
                if !has_wildcards(ext_part) {
                    return Some(constraint);
                }
            }
            // Has wildcards -> use config-specific glob detection
            if config.is_glob_pattern(token) {
                return Some(Constraint::Glob(token));
            }
            None
        }
        _ if config.enable_path_segments() && (token.starts_with('/') || token.ends_with('/')) => {
            parse_path_segment(token)
        }
        _ if matches!(context, TokenContext::Positive)
            && config.enable_filename_constraint()
            && !token.ends_with('/')
            && Constraint::is_filename_constraint_token(token) =>
        {
            Some(Constraint::FilePath(token))
        }
        _ => {
            // Check for glob patterns using config-specific detection
            if config.is_glob_pattern(token) {
                return Some(Constraint::Glob(token));
            }

            // Check for key:value patterns
            if let Some((key, value)) = token.split_once(':') {
                match key {
                    "type" if config.enable_type_filter() => {
                        return Some(Constraint::FileType(value));
                    }
                    "status" | "st" | "g" | "git" if config.enable_git_status() => {
                        return parse_git_status(value);
                    }
                    _ => {}
                }
            }

            if matches!(context, TokenContext::Negated)
                && config.enable_filename_constraint()
                && Constraint::is_filename_constraint_token(token)
            {
                return Some(Constraint::FilePath(token));
            }

            None
        }
    }
}

/// Parse path segment: /src/ -> PathSegment("src")
#[inline]
fn parse_path_segment(token: &str) -> Option<Constraint<'_>> {
    if token.len() > 1 && (token.starts_with('/') || token.ends_with('/')) {
        let segment = token.trim_matches('/');
        if !segment.is_empty() {
            Some(Constraint::PathSegment(segment))
        } else {
            None
        }
    } else {
        None
    }
}

/// Parse git status filter: modified|m|untracked|u|staged|s
#[inline]
fn parse_git_status(value: &str) -> Option<Constraint<'_>> {
    if value == "*" {
        return None;
    }

    if "modified".starts_with(value) {
        return Some(Constraint::GitStatus(GitStatusFilter::Modified));
    }

    if "untracked".starts_with(value) {
        return Some(Constraint::GitStatus(GitStatusFilter::Untracked));
    }

    if "staged".starts_with(value) {
        return Some(Constraint::GitStatus(GitStatusFilter::Staged));
    }

    if "clean".starts_with(value) {
        return Some(Constraint::GitStatus(GitStatusFilter::Unmodified));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AiGrepConfig, FileSearchConfig, GrepConfig};

    /// File-parser configuration exercising shared filename-constraint rules.
    struct FilenameConstraintConfig;

    impl ParserConfig for FilenameConstraintConfig {
        fn enable_filename_constraint(&self) -> bool {
            true
        }
    }

    #[test]
    fn test_parse_extension() {
        assert_eq!(parse_extension("*.rs"), Some(Constraint::Extension("rs")));
        assert_eq!(
            parse_extension("*.toml"),
            Some(Constraint::Extension("toml"))
        );
        assert_eq!(parse_extension("*"), None);
        assert_eq!(parse_extension("*."), None);
    }

    #[test]
    fn test_incomplete_patterns_ignored() {
        let config = FileSearchConfig;
        // Incomplete patterns should return None and be treated as noise
        assert_eq!(parse_token("*", &config), None);
        assert_eq!(parse_token("*.", &config), None);
    }

    #[test]
    fn test_parse_path_segment() {
        assert_eq!(
            parse_path_segment("/src/"),
            Some(Constraint::PathSegment("src"))
        );
        assert_eq!(
            parse_path_segment("/lib"),
            Some(Constraint::PathSegment("lib"))
        );
        assert_eq!(parse_path_segment("/"), None);
    }

    #[test]
    fn test_parse_path_segment_trailing() {
        assert_eq!(
            parse_path_segment("www/"),
            Some(Constraint::PathSegment("www"))
        );
        assert_eq!(
            parse_path_segment("src/"),
            Some(Constraint::PathSegment("src"))
        );
        // Multi-segment paths should work
        assert_eq!(
            parse_path_segment("src/lib/"),
            Some(Constraint::PathSegment("src/lib"))
        );
        assert_eq!(
            parse_path_segment("libswscale/aarch64/"),
            Some(Constraint::PathSegment("libswscale/aarch64"))
        );
        // Should not match without trailing slash
        assert_eq!(parse_path_segment("www"), None);
    }

    #[test]
    fn test_trailing_slash_in_query() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("www/ test");
        assert_eq!(result.constraints.len(), 1);
        assert!(matches!(
            result.constraints[0],
            Constraint::PathSegment("www")
        ));
        assert!(matches!(result.fuzzy_query, FuzzyQuery::Text("test")));
    }

    #[test]
    fn test_parse_git_status() {
        assert_eq!(
            parse_git_status("modified"),
            Some(Constraint::GitStatus(GitStatusFilter::Modified))
        );
        assert_eq!(
            parse_git_status("m"),
            Some(Constraint::GitStatus(GitStatusFilter::Modified))
        );
        assert_eq!(
            parse_git_status("untracked"),
            Some(Constraint::GitStatus(GitStatusFilter::Untracked))
        );
        assert_eq!(parse_git_status("invalid"), None);
    }

    #[test]
    fn test_negation_text() {
        let parser = QueryParser::new(FileSearchConfig);
        // Need two tokens for parsing to return Some
        let result = parser.parse("!test foo");
        assert_eq!(result.constraints.len(), 1);
        match &result.constraints[0] {
            Constraint::Not(inner) => {
                assert!(matches!(**inner, Constraint::Text("test")));
            }
            _ => panic!("Expected Not constraint"),
        }
    }

    #[test]
    fn test_negation_operators_stay_literal() {
        let parser = QueryParser::new(FileSearchConfig);
        // Operator-like tokens must not become exclusion constraints
        for query in [
            "Ordering::Acquire) != delivery.epoch",
            "a !== b",
            "x !! y",
            "foo !~ bar",
        ] {
            let result = parser.parse(query);
            assert!(
                result.constraints.is_empty(),
                "{query:?} produced constraints {:?}",
                result.constraints
            );
            assert_eq!(
                result.fuzzy_query,
                FuzzyQuery::Parts(query.split_whitespace().collect())
            );
        }
    }

    #[test]
    fn test_negation_short_text_stays_literal() {
        let parser = QueryParser::new(FileSearchConfig);
        // Inner text < 3 chars is not a Not constraint
        let result = parser.parse("!ab foo");
        assert!(result.constraints.is_empty());
        // Inner text >= 3 chars still is
        let result = parser.parse("!abc foo");
        assert_eq!(result.constraints.len(), 1);
        assert!(matches!(&result.constraints[0], Constraint::Not(_)));
    }

    #[test]
    fn test_negation_extension() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("!*.rs foo");
        assert_eq!(result.constraints.len(), 1);
        match &result.constraints[0] {
            Constraint::Not(inner) => {
                assert!(matches!(**inner, Constraint::Extension("rs")));
            }
            _ => panic!("Expected Not(Extension) constraint"),
        }
    }

    #[test]
    fn test_negation_path_segment() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("!/src/ foo");
        assert_eq!(result.constraints.len(), 1);
        match &result.constraints[0] {
            Constraint::Not(inner) => {
                assert!(matches!(**inner, Constraint::PathSegment("src")));
            }
            _ => panic!("Expected Not(PathSegment) constraint"),
        }
    }

    #[test]
    fn test_negation_git_status() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("!status:modified foo");
        assert_eq!(result.constraints.len(), 1);
        match &result.constraints[0] {
            Constraint::Not(inner) => {
                assert!(matches!(
                    **inner,
                    Constraint::GitStatus(GitStatusFilter::Modified)
                ));
            }
            _ => panic!("Expected Not(GitStatus) constraint"),
        }
    }

    #[test]
    fn test_negation_git_status_all_key_aliases() {
        let parser = QueryParser::new(FileSearchConfig);
        for key in ["status", "st", "g", "git"] {
            let query = format!("!{key}:modified foo");
            let result = parser.parse(&query);
            assert_eq!(
                result.constraints.len(),
                1,
                "!{key}:modified should produce exactly one constraint"
            );
            match &result.constraints[0] {
                Constraint::Not(inner) => assert!(
                    matches!(**inner, Constraint::GitStatus(GitStatusFilter::Modified)),
                    "!{key}:modified expected Not(GitStatus(Modified)), got Not({inner:?})"
                ),
                other => {
                    panic!("!{key}:modified expected Not(GitStatus), got {other:?}")
                }
            }
        }
    }

    #[test]
    fn test_backslash_escape_extension() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("\\*.rs foo");
        // \*.rs should NOT be parsed as an Extension constraint
        assert_eq!(result.constraints.len(), 0);
        // Both tokens should be text
        match result.fuzzy_query {
            FuzzyQuery::Parts(parts) => {
                assert_eq!(parts.len(), 2);
                assert_eq!(parts[0], "\\*.rs");
                assert_eq!(parts[1], "foo");
            }
            _ => panic!("Expected Parts, got {:?}", result.fuzzy_query),
        }
    }

    #[test]
    fn test_backslash_escape_path_segment() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("\\/src/ foo");
        assert_eq!(result.constraints.len(), 0);
        match result.fuzzy_query {
            FuzzyQuery::Parts(parts) => {
                assert_eq!(parts[0], "\\/src/");
                assert_eq!(parts[1], "foo");
            }
            _ => panic!("Expected Parts, got {:?}", result.fuzzy_query),
        }
    }

    #[test]
    fn test_backslash_escape_negation() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("\\!test foo");
        assert_eq!(result.constraints.len(), 0);
    }

    #[test]
    fn test_grep_question_mark_is_text() {
        let parser = QueryParser::new(GrepConfig);
        let result = parser.parse("foo?");
        assert!(result.constraints.is_empty());
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("foo?"));
    }

    #[test]
    fn test_grep_bracket_is_text() {
        let parser = QueryParser::new(GrepConfig);
        let result = parser.parse("arr[0] something");
        // arr[0] should NOT be a glob in grep mode
        assert_eq!(result.constraints.len(), 0);
    }

    #[test]
    fn test_grep_path_glob_is_constraint() {
        let parser = QueryParser::new(GrepConfig);
        let result = parser.parse("pattern src/**/*.rs");
        // src/**/*.rs contains / so it should be treated as a glob
        assert_eq!(result.constraints.len(), 1);
        assert!(matches!(
            result.constraints[0],
            Constraint::Glob("src/**/*.rs")
        ));
    }

    #[test]
    fn test_grep_brace_is_constraint() {
        let parser = QueryParser::new(GrepConfig);
        let result = parser.parse("pattern {src,lib}");
        assert_eq!(result.constraints.len(), 1);
        assert!(matches!(
            result.constraints[0],
            Constraint::Glob("{src,lib}")
        ));
    }

    #[test]
    fn test_grep_bare_star_is_text() {
        let parser = QueryParser::new(GrepConfig);
        // "a*b" contains * but no / or {} — should be text in grep mode
        let result = parser.parse("a*b something");
        assert_eq!(
            result.constraints.len(),
            0,
            "bare * without / should be text"
        );
    }

    #[test]
    fn test_grep_negated_text() {
        let parser = QueryParser::new(GrepConfig);
        let result = parser.parse("pattern !test");
        assert_eq!(result.constraints.len(), 1);
        match &result.constraints[0] {
            Constraint::Not(inner) => {
                assert!(
                    matches!(**inner, Constraint::Text("test")),
                    "Expected Not(Text(\"test\")), got Not({:?})",
                    inner
                );
            }
            other => panic!("Expected Not constraint, got {:?}", other),
        }
    }

    #[test]
    fn test_grep_negated_path_segment() {
        let parser = QueryParser::new(GrepConfig);
        let result = parser.parse("pattern !/src/");
        assert_eq!(result.constraints.len(), 1);
        match &result.constraints[0] {
            Constraint::Not(inner) => {
                assert!(
                    matches!(**inner, Constraint::PathSegment("src")),
                    "Expected Not(PathSegment(\"src\")), got Not({:?})",
                    inner
                );
            }
            other => panic!("Expected Not constraint, got {:?}", other),
        }
    }

    #[test]
    fn test_grep_negated_extension() {
        let parser = QueryParser::new(GrepConfig);
        let result = parser.parse("pattern !*.rs");
        assert_eq!(result.constraints.len(), 1);
        match &result.constraints[0] {
            Constraint::Not(inner) => {
                assert!(
                    matches!(**inner, Constraint::Extension("rs")),
                    "Expected Not(Extension(\"rs\")), got Not({:?})",
                    inner
                );
            }
            other => panic!("Expected Not constraint, got {:?}", other),
        }
    }

    #[test]
    fn test_ai_grep_detects_file_path() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("libswscale/input.c rgba32ToY");
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(
                result.constraints[0],
                Constraint::FilePath("libswscale/input.c")
            ),
            "Expected FilePath, got {:?}",
            result.constraints[0]
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("rgba32ToY"));
    }

    #[test]
    fn test_ai_grep_detects_nested_file_path() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("src/main.rs fn main");
        assert_eq!(result.constraints.len(), 1);
        assert!(matches!(
            result.constraints[0],
            Constraint::FilePath("src/main.rs")
        ));
        assert_eq!(result.fuzzy_query, FuzzyQuery::Parts(vec!["fn", "main"]));
    }

    #[test]
    fn test_ai_grep_no_false_positive_trailing_slash() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("src/ pattern");
        // Should be PathSegment, NOT FilePath
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(result.constraints[0], Constraint::PathSegment("src")),
            "Expected PathSegment, got {:?}",
            result.constraints[0]
        );
    }

    #[test]
    fn test_ai_grep_bare_filename_is_file_path() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("main.rs pattern");
        // Bare filename with valid extension → FilePath constraint
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(result.constraints[0], Constraint::FilePath("main.rs")),
            "Expected FilePath, got {:?}",
            result.constraints[0]
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("pattern"));
    }

    #[test]
    fn test_standalone_constraints_preserve_directory() {
        let result = QueryParser::new(AiGrepConfig).parse_constraints("scope-a/");
        assert_eq!(result.as_slice(), &[Constraint::PathSegment("scope-a")]);
    }

    #[test]
    fn test_plain_constraints_preserve_directory_only() {
        let directory = QueryParser::new(GrepConfig).parse_constraints("scope-a/");
        assert_eq!(directory.as_slice(), &[Constraint::PathSegment("scope-a")]);

        let file = QueryParser::new(GrepConfig).parse_constraints("scope-a/one.txt");
        assert!(file.is_empty());
    }

    #[test]
    fn test_standalone_constraints_preserve_file() {
        let result = QueryParser::new(AiGrepConfig).parse_constraints("scope-a/one.txt");
        assert_eq!(
            result.as_slice(),
            &[Constraint::FilePath("scope-a/one.txt")]
        );
    }

    #[test]
    fn test_standalone_constraints_preserve_file_without_search_text() {
        let result = QueryParser::new(AiGrepConfig).parse_constraints("scope-a/ scope-a/one.txt");
        assert_eq!(
            result.as_slice(),
            &[
                Constraint::PathSegment("scope-a"),
                Constraint::FilePath("scope-a/one.txt")
            ]
        );
    }

    #[test]
    fn test_ai_grep_filename_with_pathsegment_only_promotes_to_text() {
        // When the ONLY non-text constraints are path-scoping (PathSegment,
        // here), a bare filename token like `profile.h` should NOT be used as
        // a FilePath filter — the user is fuzzy-searching within that dir,
        // not asking for files named exactly `profile.h`.
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("chrome/browser/profiles/ profile.h");
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(
                result.constraints[0],
                Constraint::PathSegment("chrome/browser/profiles")
            ),
            "Expected single PathSegment, got {:?}",
            result.constraints
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("profile.h"));
    }

    #[test]
    fn test_ai_grep_leading_slash_path_alone_is_text_not_path_segment() {
        // A leading-slash multi-segment path like `/api/tests/` or `/api/tests`
        // used as the sole query token should be treated as fuzzy text, NOT as
        // a PathSegment constraint. The user is searching for files matching
        // that path string, not trying to scope results to a directory.
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);

        // With trailing slash
        let result = parser.parse("/api/tests/");
        assert_eq!(
            result.constraints.len(),
            0,
            "Expected no constraints for '/api/tests/', got {:?}",
            result.constraints
        );
        assert!(
            matches!(result.fuzzy_query, FuzzyQuery::Text("/api/tests/")),
            "Expected FuzzyQuery::Text, got {:?}",
            result.fuzzy_query
        );

        // Without trailing slash
        let result = parser.parse("/api/tests");
        assert_eq!(
            result.constraints.len(),
            0,
            "Expected no constraints for '/api/tests', got {:?}",
            result.constraints
        );
        assert!(
            matches!(result.fuzzy_query, FuzzyQuery::Text("/api/tests")),
            "Expected FuzzyQuery::Text, got {:?}",
            result.fuzzy_query
        );
    }

    #[test]
    fn test_grep_leading_slash_path_alone_is_text_not_path_segment() {
        // Same behavior for regular GrepConfig — single-token path-like
        // queries are search terms, not directory filters.
        let parser = QueryParser::new(GrepConfig);

        let result = parser.parse("/api/tests/");
        assert_eq!(
            result.constraints.len(),
            0,
            "GrepConfig: expected no constraints for '/api/tests/', got {:?}",
            result.constraints
        );
        assert!(
            matches!(result.fuzzy_query, FuzzyQuery::Text("/api/tests/")),
            "GrepConfig: expected FuzzyQuery::Text, got {:?}",
            result.fuzzy_query
        );

        let result = parser.parse("/api/tests");
        assert_eq!(
            result.constraints.len(),
            0,
            "GrepConfig: expected no constraints for '/api/tests', got {:?}",
            result.constraints
        );
        assert!(
            matches!(result.fuzzy_query, FuzzyQuery::Text("/api/tests")),
            "GrepConfig: expected FuzzyQuery::Text, got {:?}",
            result.fuzzy_query
        );
    }

    #[test]
    fn test_ai_grep_filename_with_extension_only_promotes_to_text() {
        // Same case with an Extension constraint — no fuzzy text means the
        // filename is what the user is searching for.
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("*.h profile.h");
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(result.constraints[0], Constraint::Extension("h")),
            "Expected Extension, got {:?}",
            result.constraints
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("profile.h"));
    }

    #[test]
    fn test_ai_grep_filename_with_other_text_keeps_filepath() {
        // Sanity: when there IS fuzzy text alongside the filename, the
        // filename stays a FilePath filter (the documented multi-token case).
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("main.rs pattern");
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(result.constraints[0], Constraint::FilePath("main.rs")),
            "Expected FilePath, got {:?}",
            result.constraints
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("pattern"));
    }

    #[test]
    fn test_ai_grep_bare_filename_schema_rs() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("schema.rs part_revisions");
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(result.constraints[0], Constraint::FilePath("schema.rs")),
            "Expected FilePath(schema.rs), got {:?}",
            result.constraints[0]
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("part_revisions"));
    }

    #[test]
    fn test_ai_grep_bare_word_no_extension_not_constraint() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("schema pattern");
        // No extension → not a file path, just text
        assert_eq!(result.constraints.len(), 0);
        assert_eq!(
            result.fuzzy_query,
            FuzzyQuery::Parts(vec!["schema", "pattern"])
        );
    }

    #[test]
    fn test_ai_grep_no_false_positive_no_extension() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("src/utils pattern");
        // No extension in last component → not a file path, just text
        assert_eq!(result.constraints.len(), 0);
        assert_eq!(
            result.fuzzy_query,
            FuzzyQuery::Parts(vec!["src/utils", "pattern"])
        );
    }

    #[test]
    fn test_ai_grep_wildcard_not_filepath() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("src/**/*.rs pattern");
        // Contains wildcards → should be a Glob, not FilePath
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(result.constraints[0], Constraint::Glob("src/**/*.rs")),
            "Expected Glob, got {:?}",
            result.constraints[0]
        );
    }

    #[test]
    fn test_ai_grep_star_text_star_is_glob() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("*quote* TODO");
        // `*quote*` should be recognised as a glob constraint in AI mode
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(result.constraints[0], Constraint::Glob("*quote*")),
            "Expected Glob(*quote*), got {:?}",
            result.constraints[0]
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("TODO"));
    }

    #[test]
    fn test_ai_grep_bare_star_not_glob() {
        use crate::AiGrepConfig;
        let parser = QueryParser::new(AiGrepConfig);
        let result = parser.parse("* pattern");
        // Bare `*` should NOT be treated as a glob (too broad)
        assert!(
            result.constraints.is_empty(),
            "Expected no constraints, got {:?}",
            result.constraints
        );
    }

    #[test]
    fn test_grep_no_location_parsing_single_token() {
        let parser = QueryParser::new(GrepConfig);
        // localhost:8080 should NOT be parsed as location -- it's a search pattern
        let result = parser.parse("localhost:8080");
        assert!(result.constraints.is_empty());
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("localhost:8080"));
    }

    #[test]
    fn test_grep_no_location_parsing_multi_token() {
        let q = QueryParser::new(GrepConfig).parse("*.rs localhost:8080");
        assert_eq!(q.fuzzy_query, FuzzyQuery::Text("localhost:8080"));
        assert!(
            q.location.is_none(),
            "Grep should not parse location from colon-number"
        );
    }

    #[test]
    fn test_grep_reversed_braces_does_not_panic() {
        // BUG PINING https://github.com/dmtrKovalenko/fff/issues/479
        // we should support any combination of different brackets without crashes
        for query in [
            "}{",
            "}{ foo",
            "foo }{",
            "a}{b",
            "}}{{",
            "} something {{{ {}}}d{ {}}}}{{{    }}}}}d{d    something {{}}}}}}",
        ] {
            let result = QueryParser::new(GrepConfig).parse(query);
            // A reversed-brace token must not be promoted to a Glob — there
            // is no comma+letters between `{` and `}`, so it's just text.
            assert!(
                !result
                    .constraints
                    .iter()
                    .any(|c| matches!(c, Constraint::Glob(_))),
                "GrepConfig: {query:?} produced a Glob constraint, got {:?}",
                result.constraints
            );

            let result = QueryParser::new(crate::AiGrepConfig).parse(query);
            assert!(
                !result
                    .constraints
                    .iter()
                    .any(|c| matches!(c, Constraint::Glob(_))),
                "AiGrepConfig: {query:?} produced a Glob constraint, got {:?}",
                result.constraints
            );
        }
    }

    #[test]
    fn test_grep_braces_without_comma_is_text() {
        let parser = QueryParser::new(GrepConfig);
        // Code patterns like format!("{}") should NOT be treated as brace expansion
        let result = parser.parse(r#"format!("{}\\AppData", home)"#);
        assert!(
            result.constraints.is_empty(),
            "Braces without comma should be text, got {:?}",
            result.constraints
        );
        assert_eq!(
            result.fuzzy_query,
            FuzzyQuery::Parts(vec![r#"format!("{}\\AppData","#, "home)"])
        );
    }

    #[test]
    fn test_grep_valid_brace_expansion_amid_junk_braces() {
        // A query mixing junk-brace tokens (`}{`, `{{}}`, `}}{{`, `{}`) with
        // a real brace-expansion glob (`{src,lib}`) must NOT panic and MUST
        // still surface the valid glob as a Glob constraint. Regression for
        // the `}{` slice-out-of-bounds panic at config.rs:175.
        let parser = QueryParser::new(GrepConfig);
        let result = parser.parse("}{ {{}} }}{{ {} {src,lib} pattern");

        let glob_constraints: Vec<&str> = result
            .constraints
            .iter()
            .filter_map(|c| match c {
                Constraint::Glob(p) => Some(*p),
                _ => None,
            })
            .collect();
        assert_eq!(
            glob_constraints,
            vec!["{src,lib}"],
            "Expected exactly one Glob({{src,lib}}), got {:?}",
            result.constraints
        );

        // Same scenario for AiGrepConfig (delegates to GrepConfig::is_glob_pattern).
        let parser = QueryParser::new(crate::AiGrepConfig);
        let result = parser.parse("}{ {{}} }}{{ {} {src,lib} pattern");
        let glob_constraints: Vec<&str> = result
            .constraints
            .iter()
            .filter_map(|c| match c {
                Constraint::Glob(p) => Some(*p),
                _ => None,
            })
            .collect();
        assert_eq!(
            glob_constraints,
            vec!["{src,lib}"],
            "AiGrepConfig: expected Glob({{src,lib}}), got {:?}",
            result.constraints
        );
    }

    #[test]
    fn test_grep_format_braces_not_glob() {
        let parser = QueryParser::new(GrepConfig);
        // Code like format!("{}\\path", var) must not have tokens eaten as glob constraints.
        // The trailing comma on the first token means both { } and , are present,
        // but the comma is outside the braces so it should NOT trigger brace expansion.
        let input = "format!(\"{}\\\\AppData\", home)";
        let result = parser.parse(input);
        assert!(
            result.constraints.is_empty(),
            "format! pattern should have no constraints, got {:?}",
            result.constraints
        );
    }

    #[test]
    fn test_grep_config_star_text_star_not_glob() {
        use crate::GrepConfig;
        let parser = QueryParser::new(GrepConfig);
        let result = parser.parse("*quote* TODO");
        // Regular grep mode should NOT treat `*quote*` as a glob
        assert!(
            result.constraints.is_empty(),
            "Expected no constraints in GrepConfig, got {:?}",
            result.constraints
        );
    }

    #[test]
    fn test_file_picker_bare_filename_constraint() {
        let parser = QueryParser::new(FilenameConstraintConfig);
        let result = parser.parse("score.rs file_picker");
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(result.constraints[0], Constraint::FilePath("score.rs")),
            "Expected FilePath(\"score.rs\"), got {:?}",
            result.constraints[0]
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("file_picker"));
    }

    #[test]
    fn test_file_picker_path_prefixed_filename_constraint() {
        let parser = QueryParser::new(FilenameConstraintConfig);
        let result = parser.parse("libswscale/slice.c lum_convert");
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(
                result.constraints[0],
                Constraint::FilePath("libswscale/slice.c")
            ),
            "Expected FilePath(\"libswscale/slice.c\"), got {:?}",
            result.constraints[0]
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("lum_convert"));
    }

    #[test]
    fn test_file_picker_single_token_filename_stays_fuzzy() {
        let parser = QueryParser::new(FileSearchConfig);
        // Single-token filename should NOT become a constraint -- it should
        // return FFFQuery with Text fuzzy query so the caller uses it for fuzzy matching.
        let result = parser.parse("score.rs");
        assert!(result.constraints.is_empty());
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("score.rs"));
    }

    #[test]
    fn test_absolute_path_with_location_not_path_segment() {
        let parser = QueryParser::new(FileSearchConfig);
        // Absolute file path with :line should parse as text + location,
        // NOT as a PathSegment constraint (which would eat the whole token).
        let result = parser.parse("/Users/neogoose/dev/fframes/src/renderer/concatenator.rs:12");
        assert!(
            result.constraints.is_empty(),
            "Absolute path with location should not become a constraint, got {:?}",
            result.constraints
        );
        assert_eq!(
            result.fuzzy_query,
            FuzzyQuery::Text("/Users/neogoose/dev/fframes/src/renderer/concatenator.rs")
        );
        assert_eq!(result.location, Some(Location::Line(12)));
    }

    #[test]
    fn test_file_picker_filename_with_multiple_fuzzy_parts() {
        let parser = QueryParser::new(FilenameConstraintConfig);
        let result = parser.parse("main.rs src components");
        assert_eq!(result.constraints.len(), 1);
        assert!(matches!(
            result.constraints[0],
            Constraint::FilePath("main.rs")
        ));
        assert_eq!(
            result.fuzzy_query,
            FuzzyQuery::Parts(vec!["src", "components"])
        );
    }

    #[test]
    fn test_file_picker_version_number_not_filename() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("v2.0 release");
        // v2.0 extension starts with digit → not a filename constraint
        assert!(
            result.constraints.is_empty(),
            "v2.0 should not be a FilePath constraint, got {:?}",
            result.constraints
        );
    }

    #[test]
    fn test_dotted_numbers_are_not_filename_constraints() {
        fn assert_dotted_numbers_stay_text<C: ParserConfig>(config: C, label: &str) {
            let parser = QueryParser::new(config);

            for query in ["192.168.1.1 timeout", "v2.0 release", "python 3.11"] {
                let result = parser.parse(query);
                assert!(
                    result.constraints.is_empty(),
                    "{label}: {query:?} must stay search text, got {:?}",
                    result.constraints
                );
            }

            // Real filenames still scope the search (passes before and after).
            assert_eq!(
                parser.parse("schema.rs users").constraints.as_slice(),
                [Constraint::FilePath("schema.rs")],
                "{label}: a bare filename must still be a constraint"
            );
            assert_eq!(
                parser
                    .parse("libswscale/input.c avframe")
                    .constraints
                    .as_slice(),
                [Constraint::FilePath("libswscale/input.c")],
                "{label}: a path-prefixed filename must still be a constraint"
            );
        }

        assert_dotted_numbers_stay_text(AiGrepConfig, "ai-grep");
        assert_dotted_numbers_stay_text(FilenameConstraintConfig, "filename-constraint");
    }

    #[test]
    fn test_file_picker_only_one_filepath_constraint() {
        let parser = QueryParser::new(FilenameConstraintConfig);
        let result = parser.parse("main.rs score.rs");
        // Only first filename becomes a constraint; second is text
        assert_eq!(result.constraints.len(), 1);
        assert!(matches!(
            result.constraints[0],
            Constraint::FilePath("main.rs")
        ));
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("score.rs"));
    }

    #[test]
    fn test_file_picker_filename_with_extension_constraint() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("main.rs *.lua");
        // With only path-scoping constraints (Extension) and no fuzzy text,
        // `main.rs` is promoted to fuzzy text — the user is fuzzy-searching
        // for "main.rs" among `.lua` files, not filtering by literal filename
        // suffix. Only the Extension constraint remains.
        assert_eq!(result.constraints.len(), 1);
        assert!(matches!(
            result.constraints[0],
            Constraint::Extension("lua")
        ));
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("main.rs"));
    }

    #[test]
    fn test_file_picker_dotfile_is_filename() {
        let parser = QueryParser::new(FilenameConstraintConfig);
        let result = parser.parse(".gitignore src");
        assert_eq!(result.constraints.len(), 1);
        assert!(
            matches!(result.constraints[0], Constraint::FilePath(".gitignore")),
            "Expected FilePath(\".gitignore\"), got {:?}",
            result.constraints[0]
        );
        assert_eq!(result.fuzzy_query, FuzzyQuery::Text("src"));
    }

    #[test]
    fn test_file_picker_no_extension_not_filename() {
        let parser = QueryParser::new(FileSearchConfig);
        let result = parser.parse("Makefile src");
        // No dot → not a filename constraint
        assert!(
            result.constraints.is_empty(),
            "Makefile should not be a FilePath constraint, got {:?}",
            result.constraints
        );
    }
}
