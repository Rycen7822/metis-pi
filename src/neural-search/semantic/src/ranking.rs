//! Lexical scoring and deterministic lexical/semantic result fusion.
use crate::{Chunk, Result, Scores, diagnostics};
use regex::Regex;
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

// Each retrieval lane supplies its best 200; exact/provided matches join later.
const LANE_CANDIDATE_LIMIT: usize = 200;
// Keep the upstream 25% lexical / 75% semantic fusion and operation order.
const LEXICAL_FUSION_WEIGHT: f64 = 0.25;
const SEMANTIC_FUSION_WEIGHT: f64 = 0.75;
// Retained text, paths and Chunk structs; not a process-wide RSS ceiling.
const MAX_RETAINED_RESULT_BYTES: usize = 128 * 1024 * 1024;

pub(crate) struct RankingOptions {
    pub provided_only: bool,
    pub result_limit: usize,
    pub include_scores: bool,
}

static CAMEL_CASE_BOUNDARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
static LEXICAL_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());
static STOP_WORDS: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    concat!(
        "a an and are as at be been but by can do does for from had has have how i if in into is it its me not of on or our ",
        "should so that the their them there these they this to use using was we what when where which who will with would ",
        "you your function description purpose input output"
    ).split_whitespace().collect()
});

pub(crate) fn exact_identifier_pattern(query: &str) -> Result<Option<(Regex, Vec<&str>)>> {
    static IDENTIFIER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[\p{L}_$][\p{L}\p{M}\p{N}_$]*").unwrap());
    let query = query.trim();
    let literals: Vec<_> = IDENTIFIER
        .find_iter(query)
        .map(|m| m.as_str())
        .filter(|word| {
            *word == query
                || word.contains(['_', '$'])
                || CAMEL_CASE_BOUNDARY.is_match(word)
                || word.chars().any(char::is_numeric)
        })
        .collect();
    if literals.is_empty() {
        return Ok(None);
    }
    let alternatives = literals
        .iter()
        .map(|s| regex::escape(s))
        .collect::<Vec<_>>()
        .join("|");
    let pattern = Regex::new(&format!(
        r"(?:^|[^\p{{L}}\p{{M}}\p{{N}}_$])(?:{alternatives})(?:$|[^\p{{L}}\p{{M}}\p{{N}}_$])"
    ))?;
    Ok(Some((pattern, literals)))
}

pub(crate) fn lexical_terms(text: &str) -> Vec<String> {
    let text = CAMEL_CASE_BOUNDARY
        .replace_all(text, "${1} ${2}")
        .to_lowercase();
    LEXICAL_WORD
        .find_iter(&text)
        .map(|m| m.as_str())
        .filter(|w| w.chars().count() > 1 && !STOP_WORDS.contains(w))
        .map(str::to_owned)
        .collect()
}

pub(crate) fn term_counts(path: &str, content: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for word in lexical_terms(content)
        .into_iter()
        .chain(lexical_terms(path))
    {
        *counts.entry(word).or_insert(0) += 1;
    }
    counts
}

fn relative_scores(scores: &[f64]) -> Vec<f64> {
    let min = scores.iter().copied().fold(f64::INFINITY, f64::min);
    let max = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    scores
        .iter()
        .map(|s| {
            if max > min {
                (s - min) / (max - min)
            } else {
                0.0
            }
        })
        .collect()
}

pub(crate) fn inverse_document_frequency(corpus_len: usize, frequency: usize) -> f64 {
    if frequency == 0 {
        0.0
    } else {
        let df = frequency as f64;
        (1.0 + (corpus_len as f64 - df + 0.5) / (df + 0.5)).ln()
    }
}

// BM25 k1=1.5 and b=0.75; keep the existing evaluation order.
// idf is inverse document frequency; count is the document's term frequency.
pub(crate) fn bm25_term_score(idf: f64, count: usize, length: usize, average: f64) -> f64 {
    let count = count as f64;
    idf * count * 2.5 / (count + 1.5 * (0.25 + 0.75 * length as f64 / average))
}

fn top_lane_candidates(scores: &[f64], mut order: Vec<usize>) -> Vec<usize> {
    // Both input lanes have ascending IDs: preserve stable ties explicitly.
    let compare = |&a: &usize, &b: &usize| scores[b].total_cmp(&scores[a]).then_with(|| a.cmp(&b));
    if order.len() > LANE_CANDIDATE_LIMIT {
        order.select_nth_unstable_by(LANE_CANDIDATE_LIMIT, compare);
        order.truncate(LANE_CANDIDATE_LIMIT);
    }
    order.sort_unstable_by(compare);
    order
}

pub(crate) fn rank(
    options: RankingOptions,
    corpus_len: usize,
    lexical: &[f64],
    similarities: &[f64],
    supplied: Vec<usize>,
    exact: &HashSet<usize>,
    mut get_chunk: impl FnMut(usize) -> Result<Chunk>,
    mut trace: Option<&mut diagnostics::RetrievalTrace>,
) -> Result<Vec<Chunk>> {
    if let Some(trace) = trace.as_deref_mut() {
        trace.supplied = supplied.clone();
    }
    let mut order: Vec<_> = if options.provided_only {
        (0..lexical.len()).collect()
    } else {
        let mut lexical_order = top_lane_candidates(
            lexical,
            (0..corpus_len).filter(|&i| lexical[i] > 0.0).collect(),
        );
        let semantic_order = top_lane_candidates(similarities, (0..corpus_len).collect());
        if let Some(trace) = trace.as_deref_mut() {
            trace.lexical = lexical_order.clone();
            trace.semantic = semantic_order.clone();
        }
        lexical_order.extend(semantic_order);
        lexical_order.extend(supplied);
        let mut exact_order: Vec<_> = exact.iter().copied().collect();
        exact_order.sort_unstable();
        if let Some(trace) = trace.as_deref_mut() {
            trace.exact = exact_order.clone();
        }
        lexical_order.extend(exact_order);
        lexical_order
    };
    let mut selected = HashSet::new();
    order.retain(|&i| selected.insert(i));
    let semantic: Vec<_> = order.iter().map(|&i| similarities[i]).collect();
    let bm25_scores: Vec<_> = order.iter().map(|&i| lexical[i]).collect();
    let bm25_relative = relative_scores(&bm25_scores);
    let semantic_relative = relative_scores(&semantic);
    let score = |i: usize| {
        LEXICAL_FUSION_WEIGHT * bm25_relative[i] + SEMANTIC_FUSION_WEIGHT * semantic_relative[i]
    };
    let mut fused: Vec<_> = (0..order.len()).collect();
    fused.sort_by(|&a, &b| {
        exact
            .contains(&order[b])
            .cmp(&exact.contains(&order[a]))
            .then_with(|| score(b).total_cmp(&score(a)))
            .then_with(|| bm25_scores[b].total_cmp(&bm25_scores[a]))
    });
    let mut results: Vec<Chunk> = Vec::new();
    let mut final_ids = Vec::new();
    let mut output_bytes = 0usize;
    for i in fused {
        let mut chunk = get_chunk(order[i])?;
        if options.include_scores {
            chunk.scores = Some(Scores {
                bm25: bm25_scores[i],
                semantic: semantic[i],
                bm25_relative: bm25_relative[i],
                semantic_relative: semantic_relative[i],
                fused: score(i),
                exact_identifier: exact.contains(&order[i]),
            });
        }
        if results
            .iter()
            .any(|c| c.path == chunk.path && c.start <= chunk.start && chunk.end <= c.end)
        {
            continue;
        }
        output_bytes = output_bytes
            .checked_add(
                chunk.content.capacity() + chunk.path.capacity() + std::mem::size_of::<Chunk>(),
            )
            .ok_or("RAM_BUDGET: result size overflow")?;
        if output_bytes > MAX_RETAINED_RESULT_BYTES {
            return Err(
                "RAM_BUDGET: result text exceeds 128MiB; no partial output returned".into(),
            );
        }
        chunk.counts = HashMap::new(); // drop the table allocation as well as its keys
        if trace.is_some() {
            final_ids.push(order[i]);
        }
        results.push(chunk);
        if results.len() == options.result_limit {
            break;
        }
    }
    if let Some(trace) = trace {
        trace.capture(
            lexical,
            similarities,
            &order,
            &final_ids,
            exact,
            &mut get_chunk,
        )?;
    }
    Ok(results)
}
