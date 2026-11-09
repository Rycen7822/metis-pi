//! Complete, versioned scope index. Record payloads are streamed to a budgeted
//! transaction; incomplete/stale/old/corrupt files are never usable hits.
use crate::{
    Args, Chunk, ModelChoice, Result,
    cache::Cache,
    record::{Record, RecordWriter},
    semantic::{ModelKind, Scorer},
    source_snapshot::SourceSnapshot,
    storage::{BudgetFile, IndexCache, IndexLease, MAX_BYTES},
};
use memmap2::Mmap;
mod lexical;
mod pages;
mod parallel;
pub(crate) mod reuse;
mod validation;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    os::unix::ffi::OsStrExt,
    path::Path,
};
// Format07/08 header: 8-byte magic followed by little-endian u64 fields.
// Offsets: records@8, metadata(offset,len)@16/24, record/term tables@32/40,
// term count@48, corpus term count@56, payload end@64, required flags@72/80 (both 1),
// uncompressed metadata bytes@88; remaining bytes are reserved.
const SCOPE_HEADER_BYTES: usize = 128;
// Each record-table entry is (byte offset, byte length), both u64.
const RECORD_LOCATION_BYTES: usize = 2 * size_of::<u64>();
const MAGIC: &[u8; 8] = b"SGREPS08";
const LEGACY_MAGIC: &[u8; 8] = b"SGREPS07";
const CONTRACT: &str = "cpu-semantic-scope-v3-counts-v1-query-policy-v1";
const LEGACY_CONTRACT: &str = "cpu-semantic-record-v2-lossless-v1-query-policy-v1";

fn artifact(assets: &Cache, kind: ModelKind) -> Result<serde_json::Value> {
    let model = match kind {
        ModelKind::Text => "bekko128",
        ModelKind::Code => "lateon-edge",
    };
    let model_manifest = serde_json::from_reader::<_, serde_json::Value>(BufReader::new(
        File::open(assets.model_directory(model)?.join("manifest.json"))?,
    ))?;
    Ok(serde_json::json!({
        "contract": CONTRACT, "source_policy": "lf-crlf-cr-v1", "scope_codec": "zstd-v1", "manifest": model_manifest
    }))
}
#[derive(Serialize, Deserialize)]
struct Metadata {
    #[serde(rename = "manifest")]
    source_snapshot: SourceSnapshot,
    artifact: serde_json::Value,
    kind: u8,
    prose_only: bool,
}
fn read_usize(data: &[u8], at: usize) -> Result<usize> {
    let bytes = data
        .get(at..at.checked_add(8).ok_or("index offset overflow")?)
        .ok_or("truncated scope header")?;
    Ok(usize::try_from(u64::from_le_bytes(bytes.try_into()?))?)
}
fn recoverable(error: &(dyn std::error::Error + 'static)) -> bool {
    error.downcast_ref::<io::Error>().is_some_and(|e| {
        !matches!(
            e.kind(),
            io::ErrorKind::InvalidData | io::ErrorKind::InvalidInput
        )
    }) || error
        .downcast_ref::<serde_json::Error>()
        .is_some_and(serde_json::Error::is_io)
}

pub struct ScopeIndexWriter {
    output: Option<BudgetFile>,
    offsets: Vec<(u64, u64)>,
    metadata: Metadata,
    total_length: usize,
    reuse: Option<reuse::RebuildSource>,
}
impl ScopeIndexWriter {
    pub fn begin(
        cache: &IndexCache,
        target: &Path,
        source_snapshot: SourceSnapshot,
        assets: &Cache,
        kind: ModelKind,
        prose_only: bool,
    ) -> Result<Self> {
        let metadata = Metadata {
            source_snapshot,
            artifact: artifact(assets, kind)?,
            kind: kind.stored_tag(),
            prose_only,
        };
        let admission = (|| -> Result<BudgetFile> {
            let mut output = cache.begin(target)?;
            output.write_all(&[0u8; SCOPE_HEADER_BYTES])?;
            Ok(output)
        })();
        let output = match admission {
            Ok(output) => Some(output),
            Err(error) => {
                crate::request::check()?;
                crate::request::diagnostic(format_args!(
                    "sgrep: cache admission unavailable; evaluating complete scope: {error}"
                ));
                None
            }
        };
        Ok(Self {
            output,
            offsets: Vec::new(),
            metadata,
            total_length: 0,
            reuse: None,
        })
    }
    pub fn reuse_records(&mut self, previous: Option<reuse::RebuildSource>) {
        self.reuse = previous.filter(|source| source.matches(&self.metadata));
    }
    pub fn score_reused_record(
        &mut self,
        scorer: &mut Scorer,
        record: reuse::ReusedRecord,
        range: (usize, usize),
        load_chunk: impl FnOnce() -> Result<Chunk>,
    ) -> Result<Option<f64>> {
        crate::request::check()?;
        let Some(source) = &self.reuse else {
            return Ok(None);
        };
        let relocated = if self.output.is_some() && range != (record.start, record.end) {
            let mut chunk = load_chunk()?;
            chunk.counts = crate::ranking::term_counts(&chunk.path, &chunk.content);
            Some(chunk)
        } else {
            None
        };
        if let Some(output) = &mut self.output {
            match source.copy(record, output, relocated.as_ref()) {
                Ok(location) => {
                    self.offsets.push(location);
                    self.total_length = self
                        .total_length
                        .checked_add(record.word_count)
                        .ok_or("corpus length overflow")?;
                }
                Err(error) => {
                    crate::request::check()?;
                    if !recoverable(error.as_ref()) {
                        return Err(error);
                    }
                    output.failure(&error);
                    self.output = None;
                    self.offsets.clear();
                    crate::request::diagnostic(format_args!(
                        "sgrep: cache copy disabled; scoring continues: {error}"
                    ));
                }
            }
        }
        scorer.accept_reused_score(record.scored_rows)?;
        Ok(Some(record.score))
    }
    pub fn score_chunks(
        &mut self,
        scorer: &mut Scorer,
        mut chunks: Vec<Chunk>,
    ) -> Result<Vec<f64>> {
        if self.output.is_some() {
            for chunk in &mut chunks {
                // The source reader carries no counts; persist them once per new record.
                chunk.counts = crate::ranking::term_counts(&chunk.path, &chunk.content);
            }
        }
        let chunks: Vec<_> = chunks.into_iter().map(std::sync::Arc::new).collect();
        let Some(output) = self.output.take() else {
            return scorer.score_documents(chunks);
        };
        let mut output = Some(output);
        let kind = scorer.kind();
        let mut active: Option<RecordWriter<'_>> = None;
        let mut document = None;
        let mut locations = Vec::with_capacity(chunks.len());
        let mut write_error = None;
        let scores = scorer.score_documents_with_completion(
            chunks.clone(),
            Some(&mut |index, block| {
                let result = (|| -> Result<()> {
                    let output = output.as_mut().ok_or("missing index output")?;
                    let Some(block) = block else {
                        // Text has one block; seal it before consuming the next result,
                        // but after the scorer has counted this successful document.
                        locations.push(
                            active
                                .take()
                                .ok_or("missing text record writer")?
                                .finish(output)?,
                        );
                        document = None;
                        return Ok(());
                    };
                    if document != Some(index) {
                        if index != locations.len() + usize::from(active.is_some()) {
                            return Err("out-of-order encoded document".into());
                        }
                        if let Some(writer) = active.take() {
                            locations.push(writer.finish(output)?);
                        }
                        let chunk = chunks
                            .get(index)
                            .ok_or("encoded document outside source batch")?;
                        active = Some(RecordWriter::begin(output, chunk, kind)?);
                        document = Some(index);
                    }
                    active
                        .as_mut()
                        .ok_or("missing record writer")?
                        .push(output, block)
                })();
                match result {
                    Ok(()) => Ok(crate::semantic::Delivery::Blocks),
                    Err(error) if recoverable(error.as_ref()) => {
                        if kind == ModelKind::Text {
                            if let Some(mut output) = output.take() {
                                output.failure(&error);
                            }
                            self.offsets.clear();
                            crate::request::diagnostic(format_args!(
                                "sgrep: cache write disabled; remaining scope still evaluated: {error}"
                            ));
                        }
                        write_error = Some(error);
                        Ok(crate::semantic::Delivery::ScoreOnly)
                    }
                    Err(error) => Err(error),
                }
            }),
        )?;
        if kind == ModelKind::Text && write_error.is_some() {
            return Ok(scores);
        }
        let mut output = output.ok_or("missing index output")?;
        if kind != ModelKind::Text && write_error.is_none() {
            let result = active
                .take()
                .ok_or("empty encoded document batch")?
                .finish(&mut output);
            match result {
                Ok(location) => locations.push(location),
                Err(error) if recoverable(error.as_ref()) => write_error = Some(error),
                Err(error) => return Err(error),
            }
        }
        if let Some(error) = write_error {
            output.failure(&error);
            self.offsets.clear();
            crate::request::diagnostic(format_args!(
                "sgrep: cache write disabled; remaining scope still evaluated: {error}"
            ));
            return Ok(scores);
        }
        if locations.len() != chunks.len() {
            return Err("incomplete encoded document batch".into());
        }
        for chunk in &chunks {
            self.total_length = self
                .total_length
                .checked_add(chunk.counts.values().sum::<usize>())
                .ok_or("corpus length overflow")?;
        }
        self.offsets.extend(locations);
        self.output = Some(output);
        Ok(scores)
    }
    pub fn finish(mut self) -> Result<()> {
        let Some(mut output) = self.output.take() else {
            return Ok(());
        };
        let result = (|| -> Result<()> {
            let records = output.stream_position()?;
            for &(start, length) in &self.offsets {
                output.write_all(&start.to_le_bytes())?;
                output.write_all(&length.to_le_bytes())?;
            }
            let terms = output.stream_position()?;
            let metadata_start = output.stream_position()?;
            let metadata_raw_bytes =
                crate::record::codec::write_scope_metadata(&mut output, &self.metadata)?;
            let end = output.stream_position()?;
            let values = [
                self.offsets.len() as u64,
                metadata_start,
                end - metadata_start,
                records,
                terms,
                0, // No duplicate lexical section: counts belong to records.
                self.total_length as u64,
                end,
                1,
                1,
                metadata_raw_bytes as u64,
            ];
            output.seek(SeekFrom::Start(0))?;
            output.write_all(MAGIC)?;
            for value in values {
                output.write_all(&value.to_le_bytes())?;
            }
            // CRC is format integrity, not a file-identity/hash gate. No full index Vec.
            output.seek(SeekFrom::Start(0))?;
            let mut crc = crc32fast::Hasher::new();
            let mut buffer = [0u8; 65536];
            let mut left = end;
            while left > 0 {
                let count = output.read(&mut buffer[..left.min(65536) as usize])?;
                if count == 0 {
                    return Err("truncated index transaction".into());
                }
                crc.update(&buffer[..count]);
                left -= count as u64;
            }
            output.seek(SeekFrom::Start(end))?;
            output.write_all(&crc.finalize().to_le_bytes())?;
            output.truncate(end + 4)?;
            Ok(())
        })();
        if let Err(error) = result {
            output.failure(&error);
            return Err(error);
        }
        output.publish()
    }
}

#[derive(Clone, Copy, Default, Serialize)]
pub struct HitTimings {
    read_crc_us: u128,
    metadata_us: u128,
    record_validation_us: u128,
    metadata_passes: usize,
    validation_worker_limit: usize,
    validation_batches: usize,
    model_query_init_us: u128,
    semantic_lexical_us: u128,
    rank_us: u128,
    scan_worker_limit: usize,
    scan_batches: usize,
}

pub struct CachedSearch {
    pub results: Vec<Chunk>,
    pub work: crate::semantic::Work,
    pub timings: HitTimings,
    pub similarities: Vec<f64>,
}

pub struct ScopeIndex {
    timings: HitTimings,
    map: Mmap,
    _lease: IndexLease,
    metadata: Metadata,
    count: usize,
    record_table: usize,
    term_table: usize,
    terms: usize,
    total_length: usize,
    query_idf: BTreeMap<String, f64>,
    fused_words: Option<Vec<String>>,
}
impl ScopeIndex {
    pub fn len(&self) -> usize {
        self.count
    }
    pub fn verify_source(&self, scope: &Path, filter: &crate::storage::SourceFilter) -> Result<()> {
        self.metadata.source_snapshot.verify(scope, filter)
    }
    pub fn open(
        cache: &IndexCache,
        target: &Path,
        scope: &Path,
        assets: &Cache,
        choice: ModelChoice,
        query_words: &[String],
    ) -> Result<Self> {
        let started = std::time::Instant::now();
        let file = cache.read(target)?;
        let size = file.metadata()?.len();
        if size < (SCOPE_HEADER_BYTES + 4) as u64 || size > MAX_BYTES {
            return Err("invalid scope index length".into());
        }
        let map = unsafe { Mmap::map(&*file)? };
        let legacy = map.get(..8) == Some(LEGACY_MAGIC);
        if (!legacy && map.get(..8) != Some(MAGIC))
            || read_usize(&map, 72)? != 1
            || read_usize(&map, 80)? != 1
        {
            return Err("old/incomplete scope index".into());
        }
        let count = read_usize(&map, 8)?;
        let metadata_start = read_usize(&map, 16)?;
        let metadata_len = read_usize(&map, 24)?;
        let record_table = read_usize(&map, 32)?;
        let term_table = read_usize(&map, 40)?;
        let terms = read_usize(&map, 48)?;
        let total_length = read_usize(&map, 56)?;
        let end = read_usize(&map, 64)?;
        if end.checked_add(4) != Some(map.len())
            || metadata_start.checked_add(metadata_len) != Some(end)
            || record_table < SCOPE_HEADER_BYTES
            || record_table
                .checked_add(count.checked_mul(16).ok_or("record count overflow")?)
                .is_none_or(|n| n > term_table)
            || term_table.checked_add(terms.checked_mul(8).ok_or("term count overflow")?)
                != Some(metadata_start)
            || (!legacy
                && (terms != 0 || record_table + count * RECORD_LOCATION_BYTES != term_table))
        {
            return Err("invalid scope index sections".into());
        }
        let read_ready = std::time::Instant::now();
        let decoded_metadata =
            crate::record::codec::scope_metadata(&map[metadata_start..end], read_usize(&map, 88)?)?;
        let metadata: Metadata = serde_json::from_slice(&decoded_metadata)?;
        drop(decoded_metadata);
        pages::release(&map, metadata_start, end)?;
        let kind = ModelKind::from_stored_tag(usize::from(metadata.kind))
            .ok_or("unknown semantic representation")?;
        let selected = ModelKind::for_scope(choice, metadata.prose_only);
        let mut expected_artifact = artifact(assets, kind)?;
        if legacy {
            expected_artifact["contract"] = LEGACY_CONTRACT.into();
        }
        if metadata.source_snapshot.scope != scope.as_os_str().as_bytes()
            || kind != selected
            || metadata.artifact != expected_artifact
        {
            return Err("stale scope/model/preprocessing manifest".into());
        }
        let metadata_ready = std::time::Instant::now();
        let expected = u32::from_le_bytes(map[end..].try_into()?);
        if pages::checksum(&map, end)? != expected {
            return Err("scope index CRC mismatch".into());
        }
        let crc_ready = std::time::Instant::now();
        let mut index = Self {
            timings: HitTimings {
                read_crc_us: read_ready.duration_since(started).as_micros()
                    + crc_ready.duration_since(metadata_ready).as_micros(),
                metadata_us: metadata_ready.duration_since(read_ready).as_micros(),
                ..HitTimings::default()
            },
            map,
            _lease: file,
            metadata,
            count,
            record_table,
            term_table,
            terms,
            total_length,
            query_idf: BTreeMap::new(),
            fused_words: None,
        };
        let mut query_df: BTreeMap<_, usize> =
            query_words.iter().cloned().map(|word| (word, 0)).collect();
        index.validate_layout()?;
        let fused = !legacy && lexical::Statistics::fits(count, &query_df);
        if !fused {
            let lexical_length = index.validate_records(&mut query_df)?;
            if lexical_length != total_length {
                return Err("inconsistent corpus length".into());
            }
        }
        if terms > 0 {
            let mut decoder = crate::record::codec::Decoder::new()?;
            let mut previous = None;
            let mut released = record_table + count * RECORD_LOCATION_BYTES;
            for i in 0..terms {
                crate::request::check()?;
                let (term, postings) = index.legacy_term(i, &mut decoder)?;
                if previous.as_ref().is_some_and(|p: &String| p >= &term) {
                    return Err("unsorted lexical dictionary".into());
                }
                let mut last = None;
                for [id, count, length] in postings {
                    if id >= index.count
                        || count == 0
                        || count > length
                        || last.is_some_and(|p| p >= id)
                    {
                        return Err("invalid lexical posting".into());
                    }
                    last = Some(id);
                }
                previous = Some(term);
                let consumed = if i + 1 == terms {
                    term_table
                } else {
                    read_usize(&index.map, term_table + (i + 1) * 8)?
                };
                pages::consumed(&index.map, &mut released, consumed)?;
            }
        }
        pages::release(&index.map, 0, index.map.len())?;
        if fused {
            index.fused_words = Some(query_df.into_keys().collect());
            index.timings.metadata_passes = 1;
        } else {
            index.query_idf = query_df
                .into_iter()
                .filter(|(_, df)| *df > 0)
                .map(|(word, df)| (word, crate::ranking::inverse_document_frequency(count, df)))
                .collect();
            index.timings.metadata_passes = 2;
        }
        index.timings.record_validation_us = crc_ready.elapsed().as_micros();
        Ok(index)
    }
    fn record_bytes(&self, id: usize) -> Result<&[u8]> {
        if id >= self.count {
            return Err("record ID outside scope".into());
        }
        let entry = self.record_table + id * RECORD_LOCATION_BYTES;
        let start = read_usize(&self.map, entry)?;
        let length = read_usize(&self.map, entry + 8)?;
        self.map
            .get(start..start.checked_add(length).ok_or("record size overflow")?)
            .ok_or_else(|| "record outside immutable scope".into())
    }
    fn record(&self, id: usize, decoder: &mut crate::record::codec::Decoder) -> Result<Record<'_>> {
        if id >= self.count {
            return Err("record ID outside scope".into());
        }
        let at = read_usize(&self.map, self.record_table + id * RECORD_LOCATION_BYTES)?;
        let record = Record::open(&self.map[..self.record_table], at, decoder)
            .map_err(crate::record::CorruptRecord::wrap)?;
        if record.kind().stored_tag() != self.metadata.kind {
            return Err(crate::record::CorruptRecord::wrap(
                "record/scope model mismatch".into(),
            ));
        }
        Ok(record)
    }
    // Every record was checked in the full immutable scan. Ranking needs text,
    // not another allocated lexical dictionary, including all-candidate traces.
    fn ranked_chunk(
        &self,
        id: usize,
        decoder: &mut crate::record::codec::Decoder,
    ) -> Result<Chunk> {
        #[derive(Deserialize)]
        struct Ranked {
            chunk: Chunk,
        }
        let at = read_usize(&self.map, self.record_table + id * RECORD_LOCATION_BYTES)?;
        let end = at
            .checked_add(crate::record::HEADER_BYTES)
            .and_then(|n| n.checked_add(read_usize(&self.map, at + 16).ok()?))
            .ok_or("metadata offset overflow")?;
        let encoded = self
            .map
            .get(at + 64..end)
            .ok_or("truncated ranked metadata")?;
        let decoded =
            crate::record::codec::metadata(encoded, read_usize(&self.map, at + 56)?, decoder)?;
        Ok(serde_json::from_slice::<Ranked>(&decoded)?.chunk)
    }
    // Retained for format07 validation; new indexes have no postings section.
    fn legacy_term(
        &self,
        id: usize,
        decoder: &mut crate::record::codec::Decoder,
    ) -> Result<(String, Vec<[usize; 3]>)> {
        let start = read_usize(&self.map, self.term_table + id * 8)?;
        let end = if id + 1 < self.terms {
            read_usize(&self.map, self.term_table + (id + 1) * 8)?
        } else {
            self.term_table
        };
        let minimum = self.record_table + self.count * RECORD_LOCATION_BYTES;
        if start < minimum || start >= end || end > self.term_table {
            return Err("invalid lexical boundary table".into());
        }
        let raw_length = read_usize(&self.map[..end], start)?;
        let encoded = self
            .map
            .get(start + 8..end)
            .ok_or("truncated lexical frame")?;
        let decoded = crate::record::codec::metadata(encoded, raw_length, decoder)?;
        Ok(serde_json::from_slice(&decoded)?)
    }
    fn lexical_score(&self, record: &Record<'_>, avg: f64) -> f64 {
        let chunk = &record.chunk;
        let length = record.length;
        if self.query_idf.len() <= chunk.counts.len() {
            self.query_idf
                .iter()
                .filter_map(|(word, &idf)| {
                    chunk
                        .counts
                        .get(word)
                        .map(|&tf| crate::ranking::bm25_term_score(idf, tf, length, avg))
                })
                .sum()
        } else {
            // A very wide Bekko query must not turn every document into a
            // full-query scan. Sort only present terms to preserve FP64 order.
            let mut present: Vec<_> = chunk
                .counts
                .iter()
                .filter_map(|(word, &tf)| self.query_idf.get(word).map(|&idf| (word, tf, idf)))
                .collect();
            present.sort_unstable_by(|a, b| a.0.cmp(b.0));
            present
                .into_iter()
                .map(|(_, tf, idf)| crate::ranking::bm25_term_score(idf, tf, length, avg))
                .sum()
        }
    }
    pub fn search(
        &self,
        args: &Args,
        assets: &Cache,
        request_scorer: &mut Option<Scorer>,
        trace: Option<&mut crate::diagnostics::RetrievalTrace>,
    ) -> Result<CachedSearch> {
        // Match Sum<f64>'s identity in the streaming BM25 path, including the
        // observable sign of zero when a document has no matching postings.
        let mut lexical = vec![-0.0; self.count];
        let avg = (self.total_length as f64 / self.count.max(1) as f64).max(1.0);
        let mut timings = self.timings;
        let query_started = std::time::Instant::now();
        if request_scorer.is_none() {
            *request_scorer = Some(Scorer::open(
                args.model,
                self.metadata.prose_only,
                &args.query,
                assets,
            )?);
        }
        let scorer = request_scorer.as_mut().unwrap();
        timings.model_query_init_us = query_started.elapsed().as_micros();
        let scan_started = std::time::Instant::now();
        timings.scan_worker_limit = 1;
        timings.scan_batches = usize::from(self.count > 0);
        let mut decoder = crate::record::codec::Decoder::new()?;
        let mut statistics = self
            .fused_words
            .as_deref()
            .map(|words| lexical::Statistics {
                words,
                rows: vec![Vec::new(); self.count],
            });
        let exact_pattern = crate::ranking::exact_identifier_pattern(&args.query)?;
        let mut exact = HashSet::new();
        let mut released = 0;
        let similarities = if scorer.kind() == ModelKind::Code
            && parallel::workers(
                self.count,
                self.record_table - SCOPE_HEADER_BYTES,
                crate::semantic::computing_threads(),
            ) > 1
        {
            let code = scorer
                .code_scan()?
                .ok_or("missing code scoring capability")?;
            let outcome = self.parallel_code_scan(
                &code,
                avg,
                exact_pattern.as_ref().map(|p| &p.0),
                &mut lexical,
                &mut exact,
                statistics.as_mut(),
                crate::semantic::computing_threads(),
            );
            timings.scan_worker_limit = outcome.worker_limit;
            timings.scan_batches = outcome.batches;
            scorer.merge_cached_work(outcome.work);
            outcome.result.map_err(|error| scorer.cached_error(error))?
        } else {
            scorer.score_scope(self.count, |i, sink| {
                let record = self.record(i, &mut decoder)?;
                if let Some(statistics) = &mut statistics {
                    statistics.rows[i] = lexical::Statistics::row(&record, statistics.words);
                } else {
                    lexical[i] = self.lexical_score(&record, avg);
                }
                if exact_pattern
                    .as_ref()
                    .is_some_and(|p| p.0.is_match(&record.chunk.content))
                {
                    exact.insert(i);
                }
                record.visit(&mut decoder, sink)?;
                drop(record);
                let at = self.record_table + i * RECORD_LOCATION_BYTES;
                let consumed = read_usize(&self.map, at)? + read_usize(&self.map, at + 8)?;
                pages::consumed(&self.map, &mut released, consumed)
            })?
        };
        if let Some(statistics) = statistics {
            statistics
                .finish(self.total_length, &mut lexical)
                .map_err(crate::record::CorruptRecord::wrap)?;
        }
        pages::release(&self.map, 0, self.map.len())?;
        timings.semantic_lexical_us = scan_started.elapsed().as_micros();
        let rank_started = std::time::Instant::now();
        let result = crate::ranking::rank(
            args.ranking_options(),
            self.count,
            &lexical,
            &similarities,
            Vec::new(),
            &exact,
            |i| {
                let chunk = self
                    .ranked_chunk(i, &mut decoder)
                    .map_err(crate::record::CorruptRecord::wrap)?;
                // Ranking owns the decoded chunk now; diagnostic all-candidate
                // lookups must not repopulate the whole mapped index either.
                let at = self.record_table + i * RECORD_LOCATION_BYTES;
                let start = read_usize(&self.map, at)?;
                pages::release(&self.map, start, start + read_usize(&self.map, at + 8)?)?;
                Ok(chunk)
            },
            trace,
        )?;
        timings.rank_us = rank_started.elapsed().as_micros();
        Ok(CachedSearch {
            results: result,
            work: scorer.work(),
            timings,
            similarities,
        })
    }
}
