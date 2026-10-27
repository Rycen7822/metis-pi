use chonkie::{CharacterTokenizer, RecursiveChunker, RecursiveLevel, RecursiveRules};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

thread_local! {
    static PARSERS: RefCell<HashMap<&'static str, tree_sitter::Parser>> = RefCell::new(HashMap::new());
}

const SIZE: usize = 2048;

fn language(path: &Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "py" | "pyi" => "python",
            "c" => "c",
            "cs" => "csharp",
            "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
            "go" => "go",
            "java" => "java",
            "rs" => "rust",
            "ts" | "mts" | "cts" => "typescript",
            "tsx" => "tsx",
            "js" | "jsx" | "mjs" | "cjs" => "javascript",
            _ => return None,
        },
    )
}

pub fn byte_ranges(source: &str, path: &Path) -> super::Result<Vec<(usize, usize)>> {
    if let Some(language) = language(path) {
        // Chonkie 1.7.0 CodeChunker.chunk(), character tokenizer. Python's strip()
        // additionally treats the ASCII information separators as whitespace.
        if source
            .trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
            .is_empty()
        {
            return Ok(Vec::new());
        }
        let bytes_per_token = source.len() as f64 / source.chars().count() as f64;
        let max_bytes = ((SIZE as f64 * bytes_per_token) as usize).max(1);
        // The upstream splitter returns the entire source here, regardless of its AST.
        if source.len() <= max_bytes {
            return Ok(vec![(0, source.len())]);
        }
        if super::cache::offline() && !tree_sitter_language_pack::has_parser(language) {
            return Err(format!("The {language} parser is not cached; run once without HF_HUB_OFFLINE to download it").into());
        }
        PARSERS.with(|parsers| {
            let mut parsers = parsers.borrow_mut();
            let parser = match parsers.entry(language) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let mut parser = tree_sitter::Parser::new();
                    parser.set_language(&tree_sitter_language_pack::get_language(language)?)?;
                    entry.insert(parser)
                }
            };
            let tree = parser.parse(source, None).ok_or("Code parse cancelled")?;
            let chunks = super::codechunker::split_code(source, &tree, max_bytes);
            if chunks.is_empty() {
                Ok(vec![(0, source.len())])
            } else {
                Ok(chunks)
            }
        })
    } else {
        // Single-byte delimiters preserve the original whitespace and UTF-8 offsets.
        let levels = ["\n", ".?!", ";:", " \t"]
            .into_iter()
            .map(|chars| RecursiveLevel::new(chars.chars().map(|c| c.to_string()).collect(), false))
            .chain(std::iter::once(RecursiveLevel::default()))
            .collect();
        let chunker =
            RecursiveChunker::new(CharacterTokenizer::new(), SIZE, RecursiveRules::new(levels));
        let mut covered = 0;
        let mut ranges = Vec::new();
        for chunk in chunker.chunk(&source.to_owned()) {
            if chunk.start_index != covered
                || source.get(chunk.start_index..chunk.end_index) != Some(chunk.text.as_str())
            {
                return Err("Text splitter changed source text or offsets".into());
            }
            covered = chunk.end_index;
            ranges.push((chunk.start_index, chunk.end_index));
        }
        if covered != source.len() {
            return Err("Text splitter omitted source text".into());
        }
        Ok(ranges)
    }
}

pub fn ranges(source: &str, path: &Path) -> super::Result<Vec<(usize, usize)>> {
    let mut starts = vec![0];
    starts.extend(source.match_indices('\n').map(|(i, _)| i + 1));
    let mut ranges: Vec<_> = byte_ranges(source, path)?
        .into_iter()
        .filter(|(start, end)| end > start)
        .map(|(start, end)| {
            (
                starts.partition_point(|&p| p <= start),
                starts.partition_point(|&p| p < end),
            )
        })
        .collect();
    ranges.sort_unstable();
    ranges.dedup();
    Ok(ranges)
}
