//! Complete, versioned scope index. Record payloads are streamed to a budgeted
//! transaction; incomplete/stale/old/corrupt files are never usable hits.
use crate::{
    Args, Chunk, ModelChoice, Result,
    cache::Cache,
    index::{Record, RecordWriter},
    semantic::{Kind, Scorer},
    storage::{BudgetFile, IndexCache, IndexLease, MAX_BYTES},
};
use memmap2::Mmap;
mod pages;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
};
const HEADER: usize = 128;
const MAGIC: &[u8; 8] = b"SGREPS08";
const LEGACY_MAGIC: &[u8; 8] = b"SGREPS07";
const CONTRACT: &str = "cpu-semantic-scope-v3-counts-v1-query-policy-v1";
const LEGACY_CONTRACT: &str = "cpu-semantic-record-v2-lossless-v1-query-policy-v1";

pub(crate) fn file_digest(path: &Path) -> Result<[u8; 32]> {
    file_digest_with_buffer(path, &mut [0u8; 65536])
}

fn file_digest_with_buffer(path: &Path, block: &mut [u8; 65536]) -> Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    loop {
        let read = file.read(block)?;
        if read == 0 {
            break;
        }
        digest.update(&block[..read]);
    }
    Ok(digest.finalize().into())
}

#[derive(Debug)]
pub struct SourceChanged;
impl std::fmt::Display for SourceChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SOURCE_CHANGED: source changed during search")
    }
}
impl std::error::Error for SourceChanged {}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Stamp {
    pub path: Vec<u8>,
    pub digest: [u8; 32],
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub scope: Vec<u8>,
    pub files: Vec<Stamp>,
}
impl Manifest {
    pub fn capture(scope: &Path, filter: &crate::storage::SourceFilter) -> Result<Self> {
        let (root, files) = crate::source_files(scope, filter)?;
        let mut stamps = Vec::with_capacity(files.len());
        // Reuse I/O scratch only; each file still has its own fresh digest.
        let mut block = [0u8; 65536];
        for path in files {
            let digest = file_digest_with_buffer(&root.join(&path), &mut block)?;
            stamps.push(Stamp {
                path: path.as_os_str().as_bytes().to_vec(),
                digest,
            });
        }
        Ok(Self {
            scope: scope.as_os_str().as_bytes().to_vec(),
            files: stamps,
        })
    }
    pub(crate) fn stamps(&self) -> &[Stamp] {
        &self.files
    }
    pub fn expected(&self) -> HashMap<PathBuf, [u8; 32]> {
        self.files
            .iter()
            .map(|s| (crate::filename(&s.path), s.digest))
            .collect()
    }
    pub fn verify(&self, scope: &Path, filter: &crate::storage::SourceFilter) -> Result<()> {
        if Self::capture(scope, filter).is_ok_and(|now| now == *self) {
            Ok(())
        } else {
            Err(SourceChanged.into())
        }
    }
}
fn kind_tag(kind: Kind) -> u8 {
    match kind {
        Kind::Text => 1,
        Kind::Code => 2,
    }
}
fn from_tag(tag: u8) -> Result<Kind> {
    match tag {
        1 => Ok(Kind::Text),
        2 => Ok(Kind::Code),
        _ => Err("unknown semantic representation".into()),
    }
}
fn artifact(assets: &Cache, kind: Kind) -> Result<serde_json::Value> {
    let model = match kind {
        Kind::Text => "bekko128",
        Kind::Code => "lateon-edge",
    };
    Ok(
        serde_json::json!({"contract":CONTRACT,"source_policy":"lf-crlf-cr-v1","scope_codec":"zstd-v1",
        "manifest":serde_json::from_reader::<_,serde_json::Value>(File::open(assets.model_directory(model)?.join("manifest.json"))?)?}),
    )
}
#[derive(Serialize, Deserialize)]
struct Metadata {
    manifest: Manifest,
    artifact: serde_json::Value,
    kind: u8,
    prose_only: bool,
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn number(data: &[u8], at: usize) -> Result<usize> {
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

pub struct Builder {
    output: Option<BudgetFile>,
    offsets: Vec<(u64, u64)>,
    metadata: Metadata,
    total_length: usize,
}
impl Builder {
    pub fn begin(
        cache: &IndexCache,
        target: &Path,
        manifest: Manifest,
        assets: &Cache,
        kind: Kind,
        prose_only: bool,
    ) -> Result<Self> {
        let mut output = cache.begin(target)?;
        output.write_all(&[0u8; HEADER])?;
        Ok(Self {
            output: Some(output),
            offsets: Vec::new(),
            metadata: Metadata {
                manifest,
                artifact: artifact(assets, kind)?,
                kind: kind_tag(kind),
                prose_only,
            },
            total_length: 0,
        })
    }
    pub fn encode(&mut self, scorer: &mut Scorer, chunk: &Chunk) -> Result<f64> {
        if self.output.is_none() {
            return scorer.score_document(&chunk.path, &chunk.content);
        }
        // Each record already owns its full query-independent word counts.
        // Do not retain a second corpus-wide dictionary/posting representation.
        let mut output = self.output.take().unwrap();
        let mut writer = match RecordWriter::begin(&mut output, chunk, scorer.kind()) {
            Ok(writer) => writer,
            Err(error) => {
                if !recoverable(error.as_ref()) {
                    return Err(error);
                }
                output.failure(&error);
                drop(output);
                self.offsets.clear();
                eprintln!("sgrep: cache write disabled: {error}");
                return scorer.score_document(&chunk.path, &chunk.content);
            }
        };
        let mut write_error = None;
        let score = scorer.score_document_to(&chunk.path, &chunk.content, &mut |block| {
            if write_error.is_none() {
                if let Err(error) = writer.push(block) {
                    if !recoverable(error.as_ref()) {
                        return Err(error);
                    }
                    write_error = Some(error);
                }
            }
            Ok(())
        })?;
        if let Some(error) = write_error {
            drop(writer);
            output.failure(&error);
            drop(output);
            self.offsets.clear();
            eprintln!("sgrep: cache write disabled; remaining scope still evaluated: {error}");
            return Ok(score);
        }
        let location = match writer.finish() {
            Ok(location) => location,
            Err(error) => {
                if !recoverable(error.as_ref()) {
                    return Err(error);
                }
                output.failure(&error);
                drop(output);
                self.offsets.clear();
                eprintln!("sgrep: cache finish disabled: {error}");
                return Ok(score);
            }
        };
        self.output = Some(output);
        let length = chunk.counts.values().sum::<usize>();
        self.offsets.push(location);
        self.total_length = self
            .total_length
            .checked_add(length)
            .ok_or("corpus length overflow")?;
        Ok(score)
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
                crate::index::codec::write_scope_metadata(&mut output, &self.metadata)?;
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
    model_query_init_us: u128,
    semantic_lexical_us: u128,
    rank_us: u128,
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
}
impl ScopeIndex {
    pub fn len(&self) -> usize {
        self.count
    }
    pub fn open(
        cache: &IndexCache,
        target: &Path,
        manifest: &Manifest,
        assets: &Cache,
        choice: ModelChoice,
        query_words: &[String],
    ) -> Result<Self> {
        let started = std::time::Instant::now();
        let file = cache.read(target)?;
        let size = file.metadata()?.len();
        if size < (HEADER + 4) as u64 || size > MAX_BYTES {
            return Err("invalid scope index length".into());
        }
        let map = unsafe { Mmap::map(&*file)? };
        let legacy = map.get(..8) == Some(LEGACY_MAGIC);
        if (!legacy && map.get(..8) != Some(MAGIC))
            || number(&map, 72)? != 1
            || number(&map, 80)? != 1
        {
            return Err("old/incomplete scope index".into());
        }
        let count = number(&map, 8)?;
        let metadata_start = number(&map, 16)?;
        let metadata_len = number(&map, 24)?;
        let record_table = number(&map, 32)?;
        let term_table = number(&map, 40)?;
        let terms = number(&map, 48)?;
        let total_length = number(&map, 56)?;
        let end = number(&map, 64)?;
        if end.checked_add(4) != Some(map.len())
            || metadata_start.checked_add(metadata_len) != Some(end)
            || record_table < HEADER
            || record_table
                .checked_add(count.checked_mul(16).ok_or("record count overflow")?)
                .is_none_or(|n| n > term_table)
            || term_table.checked_add(terms.checked_mul(8).ok_or("term count overflow")?)
                != Some(metadata_start)
            || (!legacy && (terms != 0 || record_table + count * 16 != term_table))
        {
            return Err("invalid scope index sections".into());
        }
        let expected = u32::from_le_bytes(map[end..].try_into()?);
        if pages::checksum(&map, end)? != expected {
            return Err("scope index CRC mismatch".into());
        }
        let crc_ready = std::time::Instant::now();
        let decoded_metadata =
            crate::index::codec::scope_metadata(&map[metadata_start..end], number(&map, 88)?)?;
        let metadata: Metadata = serde_json::from_slice(&decoded_metadata)?;
        drop(decoded_metadata);
        pages::release(&map, metadata_start, end)?;
        let kind = from_tag(metadata.kind)?;
        let selected = Kind::for_scope(choice, metadata.prose_only);
        let mut expected_artifact = artifact(assets, kind)?;
        if legacy {
            expected_artifact["contract"] = LEGACY_CONTRACT.into();
        }
        if metadata.manifest != *manifest
            || kind != selected
            || metadata.artifact != expected_artifact
        {
            return Err("stale scope/model/preprocessing manifest".into());
        }
        let metadata_ready = std::time::Instant::now();
        let mut index = Self {
            timings: HitTimings {
                read_crc_us: crc_ready.duration_since(started).as_micros(),
                metadata_us: metadata_ready.duration_since(crc_ready).as_micros(),
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
        };
        let mut decoder = crate::index::codec::Decoder::new()?;
        let mut query_df: BTreeMap<_, usize> =
            query_words.iter().cloned().map(|word| (word, 0)).collect();
        let mut lexical_length = 0usize;
        let mut released = 0;
        let mut next = HEADER;
        for i in 0..count {
            let at = number(&index.map, record_table + i * 16)?;
            let bytes = number(&index.map, record_table + i * 16 + 8)?;
            if at != next || at.checked_add(bytes).is_none_or(|n| n > record_table) {
                return Err("invalid record boundary table".into());
            }
            if number(&index.map, at + 8)? != bytes {
                return Err("record length disagrees with scope table".into());
            }
            let record = index.record(i, &mut decoder)?;
            if record.kind() != kind {
                return Err("record/scope model mismatch".into());
            }
            lexical_length = lexical_length
                .checked_add(record.chunk.counts.values().sum::<usize>())
                .ok_or("corpus length overflow")?;
            // Validate metadata and derive query DF without decoding vectors.
            // Every vector is validated while consumed by the full score scan.
            if query_df.len() <= record.chunk.counts.len() {
                for (word, df) in &mut query_df {
                    if record.chunk.counts.contains_key(word) {
                        *df += 1;
                    }
                }
            } else {
                for word in record.chunk.counts.keys() {
                    if let Some(df) = query_df.get_mut(word) {
                        *df += 1;
                    }
                }
            }
            next = at + bytes;
            drop(record);
            pages::consumed(&index.map, &mut released, next)?;
        }
        if next != record_table || lexical_length != total_length {
            return Err("non-contiguous records or inconsistent corpus length".into());
        }
        let mut previous = None;
        released = record_table + count * 16;
        for i in 0..terms {
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
                number(&index.map, term_table + (i + 1) * 8)?
            };
            pages::consumed(&index.map, &mut released, consumed)?;
        }
        pages::release(&index.map, 0, index.map.len())?;
        index.query_idf = query_df
            .into_iter()
            .filter(|(_, df)| *df > 0)
            .map(|(word, df)| {
                let df = df as f64;
                (word, (1.0 + (count as f64 - df + 0.5) / (df + 0.5)).ln())
            })
            .collect();
        index.timings.record_validation_us = metadata_ready.elapsed().as_micros();
        Ok(index)
    }
    fn record(&self, id: usize, decoder: &mut crate::index::codec::Decoder) -> Result<Record<'_>> {
        if id >= self.count {
            return Err("record ID outside scope".into());
        }
        let at = number(&self.map, self.record_table + id * 16)?;
        Record::open(&self.map[..self.record_table], at, decoder)
            .map_err(crate::index::Corrupt::wrap)
    }
    // Retained for format07 validation; new indexes have no postings section.
    fn legacy_term(
        &self,
        id: usize,
        decoder: &mut crate::index::codec::Decoder,
    ) -> Result<(String, Vec<[usize; 3]>)> {
        let start = number(&self.map, self.term_table + id * 8)?;
        let end = if id + 1 < self.terms {
            number(&self.map, self.term_table + (id + 1) * 8)?
        } else {
            self.term_table
        };
        let minimum = self.record_table + self.count * 16;
        if start < minimum || start >= end || end > self.term_table {
            return Err("invalid lexical boundary table".into());
        }
        let raw_length = number(&self.map[..end], start)?;
        let encoded = self
            .map
            .get(start + 8..end)
            .ok_or("truncated lexical frame")?;
        let decoded = crate::index::codec::metadata(encoded, raw_length, decoder)?;
        Ok(serde_json::from_slice(&decoded)?)
    }
    fn lexical_score(&self, chunk: &Chunk, avg: f64) -> f64 {
        let length = chunk.counts.values().sum();
        if self.query_idf.len() <= chunk.counts.len() {
            self.query_idf
                .iter()
                .filter_map(|(word, &idf)| {
                    chunk
                        .counts
                        .get(word)
                        .map(|&tf| crate::term_score(idf, tf, length, avg))
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
                .map(|(_, tf, idf)| crate::term_score(idf, tf, length, avg))
                .sum()
        }
    }
    pub fn search(
        &self,
        args: &Args,
        assets: &Cache,
        request_scorer: &mut Option<Scorer>,
        trace: Option<&mut crate::diagnostics::RetrievalTrace>,
    ) -> Result<(Vec<Chunk>, crate::semantic::Work, HitTimings)> {
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
        let mut decoder = crate::index::codec::Decoder::new()?;
        let exact_pattern = crate::identifier_pattern(&args.query)?;
        let mut exact = HashSet::new();
        let mut released = 0;
        let similarities = scorer.score_scope(self.count, |i, sink| {
            let record = self.record(i, &mut decoder)?;
            lexical[i] = self.lexical_score(&record.chunk, avg);
            if exact_pattern
                .as_ref()
                .is_some_and(|p| p.0.is_match(&record.chunk.content))
            {
                exact.insert(i);
            }
            record.visit(&mut decoder, sink)?;
            drop(record);
            let at = self.record_table + i * 16;
            let consumed = number(&self.map, at)? + number(&self.map, at + 8)?;
            pages::consumed(&self.map, &mut released, consumed)
        })?;
        pages::release(&self.map, 0, self.map.len())?;
        timings.semantic_lexical_us = scan_started.elapsed().as_micros();
        let rank_started = std::time::Instant::now();
        let result = crate::rank(
            args,
            self.count,
            &lexical,
            &similarities,
            Vec::new(),
            &exact,
            |i| {
                let chunk = self.record(i, &mut decoder)?.chunk;
                // Ranking owns the decoded chunk now; diagnostic all-candidate
                // lookups must not repopulate the whole mapped index either.
                let at = self.record_table + i * 16;
                let start = number(&self.map, at)?;
                pages::release(&self.map, start, start + number(&self.map, at + 8)?)?;
                Ok(chunk)
            },
            trace,
        )?;
        let _ = self._lease.set_modified(std::time::SystemTime::now());
        timings.rank_us = rank_started.elapsed().as_micros();
        Ok((result, scorer.work(), timings))
    }
}
