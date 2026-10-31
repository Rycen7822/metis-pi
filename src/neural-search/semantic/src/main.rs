mod cache;
mod codechunker;
mod corpus;
mod diagnostics;
mod index;
mod readiness;
mod request;
mod rg_input;
mod scope_index;
mod semantic;
mod service;
mod splitter;
mod storage;

use clap::{Parser, ValueEnum};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::LazyLock;

type Error = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Copy, PartialEq, ValueEnum)]
enum ModelChoice {
    Auto,
    Code,
    Text,
}
static CAMEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());
static STOP: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    concat!(
        "a an and are as at be been but by can do does for from had has have how i if in into is it its me not of on or our ",
        "should so that the their them there these they this to use using was we what when where which who will with would ",
        "you your function description purpose input output"
    ).split_whitespace().collect()
});

#[derive(Parser)]
#[command(
    version,
    about = "Search code and text with ripgrep and local CPU semantic models."
)]
struct Args {
    /// Store models, parsers and search indexes under this directory.
    #[arg(long, value_name = "DIR")]
    cache_dir: Option<PathBuf>,
    /// Use the same-user model service; at most three requests run at once.
    #[arg(long)]
    shared_service: bool,
    /// Service idle shutdown, measured after all running/queued work finishes.
    #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u64).range(1..=86400))]
    idle_timeout_seconds: u64,
    /// Shared request deadline, including queue time.
    #[arg(long, default_value_t = 1800, value_parser = clap::value_parser!(u64).range(1..=3600))]
    service_timeout_seconds: u64,
    /// Recompute and replace this corpus's search index before searching.
    #[arg(long, conflicts_with = "no_cache")]
    refresh_cache: bool,
    /// Download assets into a disposable cache and compute embeddings without reuse.
    #[arg(long, conflicts_with = "cache_dir")]
    fresh_assets: bool,
    query: String,
    #[arg(default_value = ".")]
    path: PathBuf,
    #[arg(short = 'n', default_value_t = 5, value_parser = clap::value_parser!(u32).range(1..))]
    count: u32,
    #[arg(long)]
    json: bool,
    /// Auto uses text embeddings for prose-only candidates, code embeddings otherwise.
    #[arg(long, value_enum, default_value_t = ModelChoice::Auto)]
    model: ModelChoice,
    /// Add ripgrep --json matches and context from a file, or - for stdin.
    #[arg(long, value_name = "FILE")]
    rg_json: Option<PathBuf>,
    /// Rank only ripgrep --json passages read from standard input.
    #[arg(long, conflicts_with = "rg_json")]
    stdin: bool,
    /// Search without reading or writing the search index.
    #[arg(long)]
    no_cache: bool,
    /// Include lexical, semantic and fused scores in JSON output.
    #[arg(long, requires = "json")]
    explain: bool,
    /// Opt in to the Metis host wire contract; unsupported versions fail closed.
    #[arg(long, requires = "json", value_parser = clap::value_parser!(u8).range(1..=1))]
    metis_protocol: Option<u8>,
}

#[derive(Serialize, Deserialize)]
struct Chunk {
    path: String,
    start: usize,
    end: usize,
    content: String,
    #[serde(skip)]
    counts: HashMap<String, usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scores: Option<Scores>,
}

#[derive(Serialize, Deserialize)]
struct Scores {
    bm25: f64,
    semantic: f64,
    bm25_relative: f64,
    semantic_relative: f64,
    fused: f64,
    exact_identifier: bool,
}

fn identifier_pattern(query: &str) -> Result<Option<(Regex, Vec<&str>)>> {
    static IDENTIFIER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[\p{L}_$][\p{L}\p{M}\p{N}_$]*").unwrap());
    let query = query.trim();
    let literals: Vec<_> = IDENTIFIER
        .find_iter(query)
        .map(|m| m.as_str())
        .filter(|word| {
            *word == query
                || word.contains(['_', '$'])
                || CAMEL.is_match(word)
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

fn words(text: &str) -> Vec<String> {
    let text = CAMEL.replace_all(text, "${1} ${2}").to_lowercase();
    WORD.find_iter(&text)
        .map(|m| m.as_str())
        .filter(|w| w.chars().count() > 1 && !STOP.contains(w))
        .map(str::to_owned)
        .collect()
}

fn filename(bytes: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::OsStr::from_bytes(bytes).into()
    }
    #[cfg(not(unix))]
    {
        String::from_utf8_lossy(bytes).as_ref().into()
    }
}

fn source_files<'a>(
    path: &'a Path,
    filter: &storage::SourceFilter,
) -> Result<(&'a Path, Vec<PathBuf>)> {
    let root = if path.is_dir() {
        path
    } else {
        path.parent().unwrap()
    };
    let mut command = Command::new("rg");
    // File discovery must not create a second CPU pool. The caller also reads
    // stdout, and an existing native pool is asleep during final verification.
    command.args(["--no-config", "--threads", "1", "--files", "-0"]);
    let target = if path.is_dir() {
        Path::new(".")
    } else {
        Path::new(path.file_name().unwrap())
    };
    let result = request::output(command.arg("--").arg(target).current_dir(root))
        .map_err(|e| format!("ripgrep is required: {e}"))?;
    if !matches!(result.status.code(), Some(0 | 1)) {
        return Err(String::from_utf8_lossy(&result.stderr).into_owned().into());
    }
    let mut files: Vec<_> = result
        .stdout
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .map(filename)
        .collect();
    files.retain(|name| !filter.excludes(&root.join(name)));
    files.sort_unstable_by(|a, b| {
        a.as_os_str()
            .as_encoded_bytes()
            .cmp(b.as_os_str().as_encoded_bytes())
    });
    Ok((root, files))
}

fn chunk_counts(path: &str, content: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for word in words(content).into_iter().chain(words(path)) {
        *counts.entry(word).or_insert(0) += 1;
    }
    counts
}

fn make_chunk(path: String, start: usize, end: usize, content: String) -> Chunk {
    let counts = chunk_counts(&path, &content);
    Chunk {
        path,
        start,
        end,
        content,
        counts,
        scores: None,
    }
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

fn is_prose(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "md" | "mdx" | "txt" | "rst" | "adoc" | "org" | "text"
    )
}

fn inverse_document_frequency(corpus_len: usize, frequency: usize) -> f64 {
    if frequency == 0 {
        0.0
    } else {
        let df = frequency as f64;
        (1.0 + (corpus_len as f64 - df + 0.5) / (df + 0.5)).ln()
    }
}

fn term_score(idf: f64, count: usize, length: usize, average: f64) -> f64 {
    let count = count as f64;
    idf * count * 2.5 / (count + 1.5 * (0.25 + 0.75 * length as f64 / average))
}

fn search(args: &Args) -> Result<Vec<Chunk>> {
    for attempt in 0..2 {
        match search_once(args) {
            Err(error)
                if error.downcast_ref::<scope_index::SourceChanged>().is_some()
                    && attempt == 0
                    && !args.stdin =>
            {
                crate::request::diagnostic(format_args!(
                    "sgrep: source changed; retrying the complete request once"
                ))
            }
            result => return result,
        }
    }
    unreachable!("request retry has a fixed bound")
}

fn search_once(args: &Args) -> Result<Vec<Chunk>> {
    let started = std::time::Instant::now();
    let mut terms = words(&args.query);
    terms.sort();
    terms.dedup();
    if terms.is_empty() {
        return Err("query has no searchable words".into());
    }
    let path = args.path.canonicalize()?;
    if !path.is_file() && !path.is_dir() {
        return Err("not a file or directory".into());
    }
    let cache = cache::Cache::new(args.cache_dir.as_deref(), args.fresh_assets)?;
    let mut trace = diagnostics::RetrievalTrace::from_env(args)?;
    let index_cache = storage::IndexCache::new(args.cache_dir.as_deref())?;
    let filter = index_cache
        .as_ref()
        .map(storage::IndexCache::source_filter)
        .unwrap_or_default();
    // A cached result remains provisional until its stored source snapshot is
    // matched by the final complete content capture. No second hash up front.
    let cache_allowed = !args.no_cache
        && !args.fresh_assets
        && !args.stdin
        && args.rg_json.is_none()
        && index_cache.as_ref().is_some_and(|c| c.max_bytes > 0);
    let mut cached_scorer = None;
    if cache_allowed
        && !args.refresh_cache
        && let Some(config) = &index_cache
    {
        let target = config.target(&path, args.model);
        match scope_index::ScopeIndex::open(config, &target, &path, &cache, args.model, &terms) {
            Ok(index) => {
                let search_result = index.search(args, &cache, &mut cached_scorer, trace.as_mut());
                let verify_started = std::time::Instant::now();
                let search_result = match search_result {
                    Ok(result) => index.verify_source(&path, &filter).map(|_| result),
                    // An obsolete auto/code snapshot must not reject a current
                    // text scope by its different query-token budget.
                    Err(error) if error.is::<semantic::QueryTooLong>() => {
                        index.verify_source(&path, &filter).and(Err(error))
                    }
                    Err(error) => Err(error),
                };
                let source_verify_us = verify_started.elapsed().as_micros();
                match search_result {
                    Ok((results, work, phases)) => {
                        diagnostics::check_scope(work, index.len(), 0)?;

                        if let Some(trace) = trace {
                            trace.commit(work, index.len(), 0, true)?;
                        }
                        diagnostics::stages(
                            || {
                                serde_json::json!({
                                    "kind":"development_cli_stages_not_quality_or_cold_page_acceptance",
                                    "cache_hit":true,"chunks":index.len(),
                                    "manifest_capture_us":0,"source_snapshot_passes":1,"cache_phases":phases,
                                    "source_verify_us":source_verify_us,"search_total_us":started.elapsed().as_micros()
                                })
                            },
                            work,
                            index.len(),
                            0,
                        )?;
                        return Ok(results);
                    }
                    Err(error)
                        if error.is::<index::Corrupt>()
                            || error.is::<scope_index::SourceChanged>() =>
                    {
                        crate::request::diagnostic(format_args!(
                            "sgrep: cache miss during score consumption: {error}"
                        ));
                        if let Some(scorer) = &mut cached_scorer {
                            scorer.discard_cached_scores();
                        }
                        // A failed diagnostic capture is provisional too.
                        trace = diagnostics::RetrievalTrace::from_env(args)?;
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) if target.exists() => {
                crate::request::diagnostic(format_args!("sgrep: cache miss: {error}"))
            }
            Err(_) => {}
        }
    }
    let mut corpus = corpus::Corpus::scan(args, &path, &filter, &terms)?;
    let manifest = corpus.manifest.as_ref();
    if corpus.len() == 0 {
        corpus.verify_provided()?;
        if let Some(manifest) = manifest {
            manifest.verify(&path, &filter)?;
        }
        let work = cached_scorer
            .as_ref()
            .map(semantic::Scorer::work)
            .unwrap_or_default();
        if let Some(trace) = trace {
            trace.commit(work, 0, 0, false)?;
        }
        diagnostics::stages(
            || {
                serde_json::json!({"cache_hit":false,"chunks":0,
            "search_total_us":started.elapsed().as_micros()})
            },
            work,
            0,
            0,
        )?;
        return Ok(Vec::new());
    }
    let scope_chunks = if args.stdin { 0 } else { corpus.corpus_len };
    let extra_chunks = corpus.len() - scope_chunks;
    let lexical = corpus.lexical(terms.len());
    let source_ready = std::time::Instant::now();
    let mut scorer = match cached_scorer {
        Some(scorer)
            if scorer.kind() == semantic::Kind::for_scope(args.model, corpus.prose_only) =>
        {
            scorer
        }
        _ => semantic::Scorer::open(args.model, corpus.prose_only, &args.query, &cache)?,
    };
    let model_ready = std::time::Instant::now();
    let mut builder =
        if cache_allowed && let (Some(config), Some(manifest)) = (&index_cache, manifest) {
            match scope_index::Builder::begin(
                config,
                &config.target(&path, args.model),
                manifest.clone(),
                &cache,
                scorer.kind(),
                corpus.prose_only,
            ) {
                Ok(builder) => Some(builder),
                Err(error) => {
                    crate::request::diagnostic(format_args!(
                        "sgrep: cache admission unavailable; evaluating complete scope: {error}"
                    ));
                    None
                }
            }
        } else {
            None
        };
    let mut similarities = Vec::with_capacity(corpus.len());
    let scoring_source_peak = corpus.visit(|chunk| {
        let score = match builder.as_mut() {
            Some(builder) => builder.encode(&mut scorer, chunk)?,
            None => scorer.score_document(chunk.path, chunk.content)?,
        };
        similarities.push(score);
        Ok(())
    })?;
    let documents_ready = std::time::Instant::now();
    let work = scorer.work();
    diagnostics::check_scope(work, scope_chunks, extra_chunks)?;
    let exact = corpus.exact();
    let supplied = std::mem::take(&mut corpus.supplied);
    let mut reader = corpus::Reader::default();
    let result = rank(
        args,
        corpus.corpus_len,
        &lexical,
        &similarities,
        supplied,
        &exact,
        |i| reader.chunk(&corpus, i),
        trace.as_mut(),
    )?;
    drop(reader);
    corpus.verify_provided()?;
    if let Some(manifest) = manifest {
        manifest.verify(&path, &filter)?;
    }
    if let Some(builder) = builder {
        if let Err(error) = builder.finish() {
            crate::request::diagnostic(format_args!(
                "sgrep: complete index not published; search result retained: {error}"
            ));
        }
    }
    if let Some(trace) = trace {
        trace.commit(work, scope_chunks, extra_chunks, false)?;
    }
    diagnostics::stages(
        || {
            serde_json::json!({
                "kind": "development_cli_stages_not_quality_or_cold_page_acceptance",
                "chunks": similarities.len(),
                "streamed_source": true,
                "cache_hit": false,
                "source_metadata_estimate_bytes": corpus.metadata_bytes,
                "source_retained_buffer_peak_bytes": corpus.source_peak_bytes.max(scoring_source_peak),
                "source_lexical_us": source_ready.duration_since(started).as_micros(),
                "model_query_init_us": model_ready.duration_since(source_ready).as_micros(),
                "documents_us": documents_ready.duration_since(model_ready).as_micros(),
                "exact_rank_us": documents_ready.elapsed().as_micros(),
                "search_total_us": started.elapsed().as_micros()
            })
        },
        work,
        scope_chunks,
        extra_chunks,
    )?;
    Ok(result)
}

fn top200(scores: &[f64], mut order: Vec<usize>) -> Vec<usize> {
    // Both input lanes have ascending IDs: preserve stable ties explicitly.
    let compare = |&a: &usize, &b: &usize| scores[b].total_cmp(&scores[a]).then_with(|| a.cmp(&b));
    if order.len() > 200 {
        order.select_nth_unstable_by(200, compare);
        order.truncate(200);
    }
    order.sort_unstable_by(compare);
    order
}

fn rank(
    args: &Args,
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
    let mut order: Vec<_> = if args.stdin {
        (0..lexical.len()).collect()
    } else {
        let mut lexical_order = top200(
            lexical,
            (0..corpus_len).filter(|&i| lexical[i] > 0.0).collect(),
        );
        let semantic_order = top200(similarities, (0..corpus_len).collect());
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
    let score = |i: usize| 0.25 * bm25_relative[i] + 0.75 * semantic_relative[i];
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
        if args.explain {
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
        if output_bytes > 128 << 20 {
            return Err(
                "RAM_BUDGET: result text exceeds 128MiB; no partial output returned".into(),
            );
        }
        chunk.counts = HashMap::new(); // drop the table allocation as well as its keys
        if trace.is_some() {
            final_ids.push(order[i]);
        }
        results.push(chunk);
        if results.len() == args.count as usize {
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

fn run() -> Result<ExitCode> {
    if std::env::args().nth(1).as_deref() == Some("--service-control") {
        service::control()?;
        return Ok(ExitCode::SUCCESS);
    }
    let args = Args::parse();
    if args.shared_service {
        let (stdout, stderr, exit) = service::client(&args)?;
        io::stdout().lock().write_all(stdout.as_bytes())?;
        io::stderr().lock().write_all(stderr.as_bytes())?;
        return Ok(ExitCode::from(exit));
    }
    let results = search(&args)?;
    write_results(
        &args,
        &results,
        &mut io::BufWriter::new(io::stdout().lock()),
    )?;
    Ok(ExitCode::from(result_exit(&args, &results)))
}

// An empty host response is successful; ordinary CLI keeps its no-match status.
fn result_exit(args: &Args, results: &[Chunk]) -> u8 {
    u8::from(results.is_empty() && args.metis_protocol.is_none())
}

fn write_results(args: &Args, results: &[Chunk], mut out: impl Write) -> Result<()> {
    if let Some(protocol) = args.metis_protocol {
        #[derive(Serialize)]
        struct HostOutput<'a> {
            protocol: u8,
            results: &'a [Chunk],
        }
        // Serialize borrowed records directly; do not duplicate the result text
        // into an intermediate JSON Value or a second complete output string.
        serde_json::to_writer(
            &mut out,
            &HostOutput {
                protocol,
                results: &results,
            },
        )?;
        writeln!(out)?;
    } else if args.json {
        writeln!(out, "{}", serde_json::to_string(&results)?)?;
    } else {
        for c in results {
            writeln!(
                out,
                "{}:{}-{}\n{}\n",
                c.path,
                c.start,
                c.end,
                c.content.trim_end()
            )?;
        }
    }
    out.flush()?;
    Ok(())
}

fn format_results(args: &Args, results: &[Chunk]) -> Result<String> {
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self
                .0
                .len()
                .checked_add(bytes.len())
                .is_none_or(|n| n > 16 << 20)
            {
                return Err(io::Error::other(
                    "RAM_BUDGET: shared result exceeds16MiB; no partial output returned",
                ));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut out = Bounded(Vec::new());
    write_results(args, results, &mut out)?;
    Ok(String::from_utf8(out.0)?)
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(e) => {
            if e.downcast_ref::<io::Error>()
                .is_some_and(|e| e.kind() == io::ErrorKind::BrokenPipe)
            {
                return ExitCode::SUCCESS;
            }
            crate::request::diagnostic(format_args!("sgrep: {e}"));
            ExitCode::from(2)
        }
    }
}
