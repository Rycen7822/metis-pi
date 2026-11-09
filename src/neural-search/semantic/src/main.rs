mod cache;
mod codechunker;
mod corpus;
mod diagnostics;
mod paths;
mod ranking;
mod readiness;
mod record;
mod request;
mod rg_input;
mod scope_index;
mod semantic;
mod service;
mod source_snapshot;
mod splitter;
mod storage;

use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

type Error = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Copy, PartialEq, ValueEnum)]
enum ModelChoice {
    Auto,
    Code,
    Text,
}
#[derive(Parser)]
#[command(
    version,
    about = "Search code and text with ripgrep and local CPU semantic models.",
    after_help = "Installation: --check-runtime loads and scores both prepared models without a corpus or service."
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

impl Args {
    fn ranking_options(&self) -> ranking::RankingOptions {
        ranking::RankingOptions {
            provided_only: self.stdin,
            result_limit: self.count as usize,
            include_scores: self.explain,
        }
    }
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

fn score_pending(
    scorer: &mut semantic::Scorer,
    writer: &mut Option<scope_index::ScopeIndexWriter>,
    pending: &mut Vec<Chunk>,
    similarities: &mut Vec<f64>,
) -> Result<()> {
    if pending.is_empty() {
        return Ok(());
    }
    let chunks = std::mem::take(pending);
    let scores = match writer {
        Some(writer) => writer.score_chunks(scorer, chunks)?,
        None => scorer.score_documents(chunks.into_iter().map(std::sync::Arc::new).collect())?,
    };
    similarities.extend(scores);
    Ok(())
}

fn make_chunk(path: String, start: usize, end: usize, content: String) -> Chunk {
    let counts = ranking::term_counts(&path, &content);
    Chunk {
        path,
        start,
        end,
        content,
        counts,
        scores: None,
    }
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

fn search(args: &Args) -> Result<Vec<Chunk>> {
    for attempt in 0..2 {
        match search_once(args) {
            Err(error)
                if error
                    .downcast_ref::<source_snapshot::SourceChanged>()
                    .is_some()
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
    let mut terms = ranking::lexical_terms(&args.query);
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
    let mut previous_source = None;
    if cache_allowed
        && !args.refresh_cache
        && let Some(config) = &index_cache
    {
        let target = config.target(&path, args.model);
        match scope_index::ScopeIndex::open(config, &target, &path, &cache, args.model, &terms) {
            Ok(index) => {
                let search_result = index.search(args, &cache, &mut cached_scorer, trace.as_mut());
                let complete = search_result.is_ok();
                let mut previous_scores = Vec::new();
                let verify_started = std::time::Instant::now();
                let search_result = match search_result {
                    Ok(mut result) => match index.verify_source(&path, &filter) {
                        Ok(()) => Ok(result),
                        Err(error) => {
                            previous_scores = std::mem::take(&mut result.similarities);
                            Err(error)
                        }
                    },
                    // An obsolete auto/code snapshot must not reject a current
                    // text scope by its different query-token budget.
                    Err(error) if error.is::<semantic::QueryTooLong>() => {
                        index.verify_source(&path, &filter).and(Err(error))
                    }
                    Err(error) => Err(error),
                };
                let source_verify_us = verify_started.elapsed().as_micros();
                match search_result {
                    Ok(scope_index::CachedSearch {
                        results,
                        work,
                        timings: phases,
                        ..
                    }) => {
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
                        if error.is::<record::CorruptRecord>()
                            || error.is::<source_snapshot::SourceChanged>() =>
                    {
                        crate::request::diagnostic(format_args!(
                            "sgrep: cache miss during score consumption: {error}"
                        ));
                        if let Some(scorer) = &mut cached_scorer {
                            scorer.discard_cached_scores();
                        }
                        if complete && error.is::<source_snapshot::SourceChanged>() {
                            previous_source =
                                scope_index::reuse::RebuildSource::new(index, previous_scores)?;
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
    let mut corpus = match corpus::Corpus::scan(args, &path, &filter, &terms, &mut previous_source)
    {
        Err(error) if error.is::<record::CorruptRecord>() => {
            crate::request::diagnostic(format_args!("sgrep: record reuse unavailable: {error}"));
            previous_source = None;
            corpus::Corpus::scan(args, &path, &filter, &terms, &mut previous_source)?
        }
        result => result?,
    };
    let source_snapshot = corpus.source_snapshot.as_ref();
    if corpus.len() == 0 {
        corpus.verify_provided()?;
        if let Some(source_snapshot) = source_snapshot {
            source_snapshot.verify(&path, &filter)?;
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
            if scorer.kind() == semantic::ModelKind::for_scope(args.model, corpus.prose_only) =>
        {
            scorer
        }
        _ => semantic::Scorer::open(args.model, corpus.prose_only, &args.query, &cache)?,
    };
    let model_ready = std::time::Instant::now();
    let mut index_writer = if cache_allowed
        && let (Some(config), Some(source_snapshot)) = (&index_cache, source_snapshot)
    {
        let mut index_writer = scope_index::ScopeIndexWriter::begin(
            config,
            &config.target(&path, args.model),
            source_snapshot.clone(),
            &cache,
            scorer.kind(),
            corpus.prose_only,
        )?;
        index_writer.reuse_records(previous_source);
        Some(index_writer)
    } else {
        None
    };
    let mut similarities = Vec::with_capacity(corpus.len());
    // Text workers need at least two full batches to be reused within this request.
    let batch_text = scorer.kind() == semantic::ModelKind::Text
        && corpus.len() >= 2 * semantic::MAX_TEXT_BATCH_DOCUMENTS;
    let source_batch_size = match scorer.kind() {
        semantic::ModelKind::Text if batch_text => semantic::MAX_TEXT_BATCH_DOCUMENTS,
        semantic::ModelKind::Text => 1,
        semantic::ModelKind::Code => semantic::MAX_BATCH_WINDOWS,
    };
    let mut pending = Vec::with_capacity(source_batch_size);
    const MAX_TEXT_SOURCE_BYTES: usize = 64 * 1024;
    let mut pending_source_bytes = 0;
    let mut buffered_source_peak = 0;
    let scoring_source_peak = corpus.visit(|id, reader| {
        if let Some((record, range)) = corpus.reused(id).filter(|_| index_writer.is_some()) {
            // Seal new records before a reused record so the scope retains corpus order.
            score_pending(
                &mut scorer,
                &mut index_writer,
                &mut pending,
                &mut similarities,
            )?;
            pending_source_bytes = 0;
            if let Some(score) = index_writer
                .as_mut()
                .ok_or("missing index writer")?
                .score_reused_record(&mut scorer, record, range, || reader.chunk(&corpus, id))?
            {
                similarities.push(score);
                return Ok(());
            }
        }
        let chunk = match reader.chunk(&corpus, id) {
            Ok(chunk) => chunk,
            Err(error) => {
                if batch_text {
                    // A later pre-read must not mask an earlier encode/record error.
                    score_pending(
                        &mut scorer,
                        &mut index_writer,
                        &mut pending,
                        &mut similarities,
                    )?;
                }
                return Err(error);
            }
        };
        let buffered: usize = pending
            .iter()
            .map(|chunk| chunk.path.capacity() + chunk.content.capacity())
            .sum();
        buffered_source_peak = buffered_source_peak.max(
            reader.retained_bytes() + buffered + chunk.path.capacity() + chunk.content.capacity(),
        );
        if batch_text {
            let source_bytes = chunk.path.len() + chunk.content.len();
            if !pending.is_empty() && pending_source_bytes + source_bytes > MAX_TEXT_SOURCE_BYTES {
                score_pending(
                    &mut scorer,
                    &mut index_writer,
                    &mut pending,
                    &mut similarities,
                )?;
                pending_source_bytes = 0;
            }
            pending_source_bytes += source_bytes;
        }
        pending.push(chunk);
        if pending.len() == source_batch_size
            || (batch_text && pending_source_bytes >= MAX_TEXT_SOURCE_BYTES)
        {
            score_pending(
                &mut scorer,
                &mut index_writer,
                &mut pending,
                &mut similarities,
            )?;
            pending_source_bytes = 0;
        }
        Ok(())
    })?;
    score_pending(
        &mut scorer,
        &mut index_writer,
        &mut pending,
        &mut similarities,
    )?;
    let scoring_source_peak = scoring_source_peak.max(buffered_source_peak);
    let documents_ready = std::time::Instant::now();
    let work = scorer.work();
    diagnostics::check_scope(work, scope_chunks, extra_chunks)?;
    let exact = corpus.exact();
    let supplied = std::mem::take(&mut corpus.supplied);
    let mut reader = corpus::ChunkReader::default();
    let result = ranking::rank(
        args.ranking_options(),
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
    if let Some(source_snapshot) = source_snapshot {
        source_snapshot.verify(&path, &filter)?;
    }
    if let Some(index_writer) = index_writer {
        if let Err(error) = index_writer.finish() {
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

fn check_runtime() -> Result<ExitCode> {
    let assets = cache::Cache::new(None, false)?;
    for model in [ModelChoice::Text, ModelChoice::Code] {
        let mut scorer = semantic::Scorer::open(model, false, "runtime installation", &assets)?;
        let document = std::sync::Arc::new(make_chunk(
            "runtime.txt".into(),
            1,
            1,
            "Prepared CPU model installation.".into(),
        ));
        let score = scorer
            .score_documents(vec![document])?
            .pop()
            .ok_or("missing runtime check score")?;
        if !score.is_finite() {
            return Err("ARTIFACT_MISMATCH: runtime check produced a non-finite score".into());
        }
    }
    println!(
        "{}",
        serde_json::json!({"runtime_check": 1, "models": ["bekko128", "lateon-edge"]})
    );
    Ok(ExitCode::SUCCESS)
}

fn run() -> Result<ExitCode> {
    if std::env::args().nth(1).as_deref() == Some("--check-runtime") {
        if std::env::args_os().count() != 2 {
            return Err("--check-runtime does not accept search arguments".into());
        }
        return check_runtime();
    }
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
