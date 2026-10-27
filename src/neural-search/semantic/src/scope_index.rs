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
const MAGIC: &[u8; 8] = b"SGREPS05";

pub(crate) fn file_digest(path: &Path) -> Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut block = [0u8; 65536];
    loop {
        let read = file.read(&mut block)?;
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
        for path in files {
            let digest = file_digest(&root.join(&path))?;
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
        serde_json::json!({"contract":"cpu-semantic-record-v1-query-policy-v1","source_policy":"lf-crlf-cr-v1",
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
    terms: BTreeMap<String, Vec<[usize; 3]>>,
    metadata: Metadata,
    total_length: usize,
    metadata_ram: usize,
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
            terms: BTreeMap::new(),
            metadata: Metadata {
                manifest,
                artifact: artifact(assets, kind)?,
                kind: kind_tag(kind),
                prose_only,
            },
            total_length: 0,
            metadata_ram: 0,
        })
    }
    fn stop(&mut self, error: &dyn std::fmt::Display) {
        if let Some(mut file) = self.output.take() {
            file.failure(error);
            drop(file);
            eprintln!("sgrep: cache unavailable; continuing complete search: {error}");
        }
        self.terms.clear();
        self.offsets.clear();
    }
    pub fn encode(&mut self, scorer: &mut Scorer, chunk: &Chunk) -> Result<f64> {
        if self.output.is_none() {
            return scorer.score_document(&chunk.path, &chunk.content);
        }
        // The query-independent lexical dictionary is resident, but bounded.
        // Exceeding its RAM admission stops caching, never scope evaluation.
        let projected = chunk
            .counts
            .iter()
            .map(|(word, _)| word.len() + 256 + std::mem::size_of::<[usize; 3]>() * 2)
            .sum::<usize>();
        if self.metadata_ram.saturating_add(projected) > 64 << 20 {
            self.stop(&"lexical index RAM admission exhausted");
            return scorer.score_document(&chunk.path, &chunk.content);
        }
        let mut output = self.output.take().unwrap();
        let mut writer = match RecordWriter::begin(&mut output, chunk, scorer.kind()) {
            Ok(writer) => writer,
            Err(error) => {
                if !recoverable(error.as_ref()) {
                    return Err(error);
                }
                output.failure(&error);
                drop(output);
                self.terms.clear();
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
            self.terms.clear();
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
                self.terms.clear();
                self.offsets.clear();
                eprintln!("sgrep: cache finish disabled: {error}");
                return Ok(score);
            }
        };
        self.output = Some(output);
        let id = self.offsets.len();
        let length = chunk.counts.values().sum::<usize>();
        self.offsets.push(location);
        self.total_length = self
            .total_length
            .checked_add(length)
            .ok_or("corpus length overflow")?;
        for (word, &frequency) in &chunk.counts {
            self.terms
                .entry(word.clone())
                .or_default()
                .push([id, frequency, length]);
        }
        self.metadata_ram += projected;
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
            let mut term_offsets = Vec::with_capacity(self.terms.len());
            for (term, postings) in &self.terms {
                term_offsets.push(output.stream_position()?);
                serde_json::to_writer(&mut output, &(term, postings))?;
            }
            let terms = output.stream_position()?;
            for offset in term_offsets {
                output.write_all(&offset.to_le_bytes())?;
            }
            let metadata_start = output.stream_position()?;
            serde_json::to_writer(&mut output, &self.metadata)?;
            let end = output.stream_position()?;
            let values = [
                self.offsets.len() as u64,
                metadata_start,
                end - metadata_start,
                records,
                terms,
                self.terms.len() as u64,
                self.total_length as u64,
                end,
                1,
                1,
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

pub struct ScopeIndex {
    map: Mmap,
    _lease: IndexLease,
    metadata: Metadata,
    count: usize,
    record_table: usize,
    term_table: usize,
    terms: usize,
    total_length: usize,
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
    ) -> Result<Self> {
        let file = cache.read(target)?;
        let size = file.metadata()?.len();
        if size < (HEADER + 4) as u64 || size > MAX_BYTES {
            return Err("invalid scope index length".into());
        }
        let map = unsafe { Mmap::map(&*file)? };
        if map.get(..8) != Some(MAGIC) || number(&map, 72)? != 1 || number(&map, 80)? != 1 {
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
        {
            return Err("invalid scope index sections".into());
        }
        let expected = u32::from_le_bytes(map[end..].try_into()?);
        if crc32fast::hash(&map[..end]) != expected {
            return Err("scope index CRC mismatch".into());
        }
        let metadata: Metadata = serde_json::from_slice(&map[metadata_start..end])?;
        let kind = from_tag(metadata.kind)?;
        let selected = if choice == ModelChoice::Text
            || (choice == ModelChoice::Auto && metadata.prose_only)
        {
            Kind::Text
        } else {
            Kind::Code
        };
        if metadata.manifest != *manifest
            || kind != selected
            || metadata.artifact != artifact(assets, kind)?
        {
            return Err("stale scope/model/preprocessing manifest".into());
        }
        let index = Self {
            map,
            _lease: file,
            metadata,
            count,
            record_table,
            term_table,
            terms,
            total_length,
        };
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
            let record = index.record(i)?;
            if record.kind() != kind {
                return Err("record/scope model mismatch".into());
            }
            record.visit(&mut |_| Ok(()))?;
            next = at + bytes;
        }
        if next != record_table {
            return Err("non-contiguous scope records".into());
        }
        let mut previous = None;
        for i in 0..terms {
            let (term, postings) = index.term(i)?;
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
        }
        Ok(index)
    }
    fn record(&self, id: usize) -> Result<Record<'_>> {
        if id >= self.count {
            return Err("record ID outside scope".into());
        }
        let at = number(&self.map, self.record_table + id * 16)?;
        Record::open(&self.map[..self.record_table], at)
    }
    fn term(&self, id: usize) -> Result<(String, Vec<[usize; 3]>)> {
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
        Ok(serde_json::from_slice(&self.map[start..end])?)
    }
    pub fn search(
        &self,
        args: &Args,
        assets: &Cache,
        terms: &[String],
        trace: Option<&mut crate::diagnostics::RetrievalTrace>,
    ) -> Result<(Vec<Chunk>, crate::semantic::Work)> {
        let mut lexical = vec![0.0; self.count];
        let avg = (self.total_length as f64 / self.count.max(1) as f64).max(1.0);
        for word in terms {
            let (mut low, mut high) = (0, self.terms);
            while low < high {
                let middle = (low + high) / 2;
                let (term, _) = self.term(middle)?;
                if term.as_str() < word.as_str() {
                    low = middle + 1;
                } else {
                    high = middle;
                }
            }
            if low == self.terms {
                continue;
            }
            let (term, postings) = self.term(low)?;
            if term != *word {
                continue;
            }
            let df = postings.len() as f64;
            let idf = (1.0 + (self.count as f64 - df + 0.5) / (df + 0.5)).ln();
            for [id, count, length] in postings {
                lexical[id] += crate::term_score(idf, count, length, avg);
            }
        }
        let mut scorer = Scorer::open(args.model, self.metadata.prose_only, &args.query, assets)?;
        let exact_pattern = crate::identifier_pattern(&args.query)?;
        let mut exact = HashSet::new();
        let similarities = scorer.score_scope(self.count, |i, sink| {
            let record = self.record(i)?;
            if exact_pattern
                .as_ref()
                .is_some_and(|p| p.0.is_match(&record.chunk.content))
            {
                exact.insert(i);
            }
            record.visit(sink)
        })?;
        let result = crate::rank(
            args,
            self.count,
            &lexical,
            &similarities,
            Vec::new(),
            &exact,
            |i| Ok(self.record(i)?.chunk),
            trace,
        )?;
        let _ = self._lease.set_modified(std::time::SystemTime::now());
        Ok((result, scorer.work()))
    }
}
