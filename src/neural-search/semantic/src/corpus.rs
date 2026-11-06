//! Two-pass, query-independent source reconstruction. Retained state is positions
//! and query-relevant statistics, not corpus text, full word maps or embeddings.
use crate::{
    Args, Chunk, Result,
    scope_index::reuse::{RebuildSource, ReusedRecord},
    source_snapshot::{SourceChanged, SourceFileDigest, SourceSnapshot},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

// Request-local corpus metadata, separate from result and disk-cache limits.
const MAX_CORPUS_METADATA_BYTES: usize = 128 * 1024 * 1024;
// Allow for allocator and lookup-map bookkeeping in addition to stored fields.
const FILE_ENTRY_OVERHEAD_BYTES: usize = 128;
const CHUNK_ENTRY_OVERHEAD_BYTES: usize = 96;

pub struct SourceContents {
    pub text: String,
    starts: Vec<usize>,
    pub digest: [u8; 32],
    pub binary: bool,
}
impl SourceContents {
    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path)?;
        let digest = Sha256::digest(&bytes).into();
        if bytes.contains(&0) {
            return Ok(Self {
                text: String::new(),
                starts: vec![0],
                digest,
                binary: true,
            });
        }
        Ok(Self::from_text_bytes(bytes, digest))
    }
    // Callers already classified these bytes as non-binary; do not scan for NUL twice.
    fn from_text_bytes(bytes: Vec<u8>, digest: [u8; 32]) -> Self {
        let text = String::from_utf8(bytes)
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
        let text = if text.as_bytes().contains(&b'\r') {
            let mut normalized = String::with_capacity(text.len());
            let mut chars = text.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\r' {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    normalized.push('\n');
                } else {
                    normalized.push(c);
                }
            }
            normalized
        } else {
            text
        };
        let mut starts = vec![0];
        for (at, _) in text.match_indices('\n') {
            starts.push(at + 1);
        }
        if starts.last().copied() != Some(text.len()) {
            starts.push(text.len());
        }
        Self {
            text,
            starts,
            digest,
            binary: false,
        }
    }
    pub fn lines(&self) -> usize {
        self.starts.len() - 1
    }
    pub fn part(&self, start: usize, end: usize) -> Result<&str> {
        if start == 0 || end < start || end >= self.starts.len() {
            return Err("invalid source line range".into());
        }
        Ok(&self.text[self.starts[start - 1]..self.starts[end]])
    }
    fn resident_bytes(&self) -> usize {
        self.text.capacity() + self.starts.capacity() * std::mem::size_of::<usize>()
    }
}
struct SourceFileEntry {
    path: PathBuf,
    display: String,
    digest: [u8; 32],
    in_snapshot: bool,
}
struct ChunkEntry {
    file: usize,
    start: usize,
    end: usize,
    provided: bool,
    length: usize,
    matches: Vec<(usize, usize)>,
    exact: bool,
    reused: Option<ReusedRecord>,
}
pub struct Corpus {
    files: Vec<SourceFileEntry>,
    documents: Vec<ChunkEntry>,
    pub corpus_len: usize,
    pub supplied: Vec<usize>,
    pub prose_only: bool,
    pub metadata_bytes: usize,
    pub source_peak_bytes: usize,
    pub source_snapshot: Option<SourceSnapshot>,
}
impl Corpus {
    pub fn scan(
        args: &Args,
        scope: &Path,
        filter: &crate::storage::SourceFilter,
        terms: &[String],
        reuse: &mut Option<RebuildSource>,
    ) -> Result<Self> {
        let mut corpus = Self {
            files: Vec::new(),
            documents: Vec::new(),
            corpus_len: 0,
            supplied: Vec::new(),
            prose_only: true,
            metadata_bytes: 0,
            source_peak_bytes: 0,
            source_snapshot: None,
        };
        let mut files = HashMap::new();
        let mut locations = HashMap::new();
        let pattern = crate::ranking::exact_identifier_pattern(&args.query)?;
        if args.stdin {
            crate::rg_input::visit(Path::new("-"), scope, |path, digest, chunk| {
                corpus.add(
                    path,
                    digest,
                    false,
                    true,
                    chunk,
                    None,
                    false,
                    terms,
                    &pattern,
                    &mut files,
                    &mut locations,
                )
            })?;
            corpus.corpus_len = corpus.documents.len();
        } else {
            let (root, names) = crate::source_snapshot::discover_files(scope, filter)?;
            if let Some(source) = reuse.as_ref() {
                if !source.compatible_paths(&names)? {
                    *reuse = None;
                }
            }
            let mut source_snapshot = SourceSnapshot {
                scope: scope.as_os_str().as_encoded_bytes().to_vec(),
                files: Vec::with_capacity(names.len()),
            };
            corpus.budget(
                source_snapshot.scope.capacity()
                    + source_snapshot.files.capacity() * std::mem::size_of::<SourceFileDigest>(),
            )?;
            for name in names {
                crate::request::check()?;
                let relative = name.strip_prefix(".").unwrap_or(&name);
                let path = root.join(relative);
                let bytes =
                    std::fs::read(&path).map_err(|error| source_read_error(error.into()))?;
                let digest = Sha256::digest(&bytes).into();
                let stamp = SourceFileDigest {
                    path: name.as_os_str().as_encoded_bytes().to_vec(),
                    digest,
                };
                corpus.budget(stamp.path.capacity())?;
                source_snapshot.files.push(stamp);
                corpus.source_peak_bytes = corpus.source_peak_bytes.max(bytes.capacity());
                if bytes.contains(&0) {
                    continue;
                }
                let mut previous = reuse
                    .as_mut()
                    .map(|source| source.file(name.as_os_str().as_encoded_bytes(), &digest))
                    .transpose()?;
                if let Some(previous) = &mut previous {
                    if previous.unchanged {
                        while let Some(record) = previous.next()? {
                            corpus.add(
                                path.clone(),
                                digest,
                                true,
                                false,
                                record.chunk,
                                Some(record.reused),
                                false,
                                terms,
                                &pattern,
                                &mut files,
                                &mut locations,
                            )?;
                        }
                        continue;
                    }
                }
                let source = SourceContents::from_text_bytes(bytes, digest);
                corpus.source_peak_bytes = corpus.source_peak_bytes.max(source.resident_bytes());
                let ranges = crate::splitter::ranges(&source.text, relative, &source.starts)?;
                for (start, end) in ranges {
                    let (start, end) = (start.max(1), end.min(source.lines()));
                    if start > end {
                        continue;
                    }
                    let chunk = crate::make_chunk(
                        relative.to_string_lossy().into(),
                        start,
                        end,
                        source.part(start, end)?.into(),
                    );
                    let reused = previous
                        .as_mut()
                        .map(|file| file.find(&chunk))
                        .transpose()?
                        .flatten();
                    corpus.add(
                        path.clone(),
                        source.digest,
                        true,
                        false,
                        chunk,
                        reused,
                        false,
                        terms,
                        &pattern,
                        &mut files,
                        &mut locations,
                    )?;
                }
            }
            corpus.source_snapshot = Some(source_snapshot);
            corpus.corpus_len = corpus.documents.len();
            if let Some(input) = &args.rg_json {
                crate::rg_input::visit(input, scope, |path, digest, chunk| {
                    corpus.add(
                        path,
                        digest,
                        false,
                        true,
                        chunk,
                        None,
                        true,
                        terms,
                        &pattern,
                        &mut files,
                        &mut locations,
                    )
                })?;
            }
        }
        // No text/full token maps survived a visitor call. Lookup maps used only
        // for capture are dropped before the model session is constructed.
        drop((files, locations));
        Ok(corpus)
    }
    fn budget(&mut self, bytes: usize) -> Result<()> {
        self.metadata_bytes = self
            .metadata_bytes
            .checked_add(bytes)
            .ok_or("RAM_BUDGET: source metadata overflow")?;
        if self.metadata_bytes > MAX_CORPUS_METADATA_BYTES {
            return Err(
                "RAM_BUDGET: source metadata exceeds 128MiB; no partial scope returned".into(),
            );
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        path: PathBuf,
        digest: [u8; 32],
        in_snapshot: bool,
        provided: bool,
        chunk: Chunk,
        reused: Option<ReusedRecord>,
        supplied: bool,
        terms: &[String],
        pattern: &Option<(regex::Regex, Vec<&str>)>,
        files: &mut HashMap<PathBuf, usize>,
        locations: &mut HashMap<(String, usize, usize), usize>,
    ) -> Result<()> {
        let file = if let Some(&id) = files.get(&path) {
            if self.files[id].digest != digest {
                return Err(SourceChanged.into());
            }
            self.files[id].in_snapshot |= in_snapshot;
            id
        } else {
            self.budget(
                std::mem::size_of::<SourceFileEntry>()
                    + path.as_os_str().len() * 2
                    + chunk.path.len()
                    + FILE_ENTRY_OVERHEAD_BYTES,
            )?;
            let id = self.files.len();
            self.files.push(SourceFileEntry {
                path: path.clone(),
                display: chunk.path.clone(),
                digest,
                in_snapshot,
            });
            files.insert(path, id);
            id
        };
        let key = (chunk.path.clone(), chunk.start, chunk.end);
        if let Some(&id) = locations.get(&key) {
            if supplied {
                self.budget(std::mem::size_of::<usize>())?;
                self.supplied.push(id);
            }
            return Ok(());
        }
        let matches: Vec<_> = terms
            .iter()
            .enumerate()
            .filter_map(|(id, term)| chunk.counts.get(term).map(|&count| (id, count)))
            .collect();
        self.budget(
            std::mem::size_of::<ChunkEntry>()
                + matches.capacity() * std::mem::size_of::<(usize, usize)>()
                + chunk.path.len()
                + CHUNK_ENTRY_OVERHEAD_BYTES,
        )?;
        let exact = pattern
            .as_ref()
            .is_some_and(|(pattern, _)| pattern.is_match(&chunk.content));
        let document = self.documents.len();
        self.documents.push(ChunkEntry {
            file,
            start: chunk.start,
            end: chunk.end,
            provided,
            length: chunk.counts.values().sum(),
            matches,
            exact,
            reused,
        });
        self.prose_only &= crate::is_prose(&chunk.path);
        locations.insert(key, document);
        if supplied {
            self.supplied.push(document);
        }
        Ok(())
    }
    pub fn len(&self) -> usize {
        self.documents.len()
    }
    pub fn exact(&self) -> std::collections::HashSet<usize> {
        self.documents
            .iter()
            .enumerate()
            .filter_map(|(i, d)| d.exact.then_some(i))
            .collect()
    }
    pub fn lexical(&self, terms: usize) -> Vec<f64> {
        if self.corpus_len == 0 {
            return vec![0.; self.len()];
        }
        let mut frequencies = vec![0usize; terms];
        let mut total = 0usize;
        for row in self.documents.iter().take(self.corpus_len) {
            total += row.length;
            for &(term, _) in &row.matches {
                frequencies[term] += 1;
            }
        }
        let average = (total as f64 / self.corpus_len as f64).max(1.);
        let idf: Vec<_> = frequencies
            .iter()
            .map(|&df| crate::ranking::inverse_document_frequency(self.corpus_len, df))
            .collect();
        self.documents
            .iter()
            .map(|row| {
                row.matches
                    .iter()
                    .filter(|(term, _)| frequencies[*term] > 0)
                    .map(|&(term, count)| {
                        crate::ranking::bm25_term_score(idf[term], count, row.length, average)
                    })
                    .sum()
            })
            .collect()
    }
    pub fn reused(&self, index: usize) -> Option<(ReusedRecord, (usize, usize))> {
        let doc = self.documents.get(index)?;
        doc.reused.map(|record| (record, (doc.start, doc.end)))
    }
    pub fn visit(
        &self,
        mut consume: impl FnMut(usize, &mut ChunkReader) -> Result<()>,
    ) -> Result<usize> {
        let mut reader = ChunkReader::default();
        for i in 0..self.len() {
            consume(i, &mut reader)?;
        }
        Ok(reader.peak)
    }
    pub fn verify_provided(&self) -> Result<()> {
        for file in self.files.iter().filter(|f| !f.in_snapshot) {
            if crate::source_snapshot::file_sha256(&file.path).map_or(true, |d| d != file.digest) {
                return Err(SourceChanged.into());
            }
        }
        Ok(())
    }
}
fn source_read_error(error: crate::Error) -> crate::Error {
    if error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    {
        SourceChanged.into()
    } else {
        error
    }
}
#[derive(Default)]
pub struct ChunkReader {
    view: Option<(usize, bool, SourceContents)>,
    pub peak: usize,
}
impl ChunkReader {
    pub fn retained_bytes(&self) -> usize {
        self.view
            .as_ref()
            .map_or(0, |(_, _, source)| source.resident_bytes())
    }
    pub fn chunk(&mut self, corpus: &Corpus, index: usize) -> Result<Chunk> {
        let doc = corpus
            .documents
            .get(index)
            .ok_or("invalid source document id")?;
        let file = &corpus.files[doc.file];
        if !self
            .view
            .as_ref()
            .is_some_and(|(id, provided, _)| *id == doc.file && *provided == doc.provided)
        {
            drop(self.view.take()); // never retain the previous file during load
            let source = SourceContents::read(&file.path).map_err(source_read_error)?;
            if source.digest != file.digest || source.binary {
                return Err(SourceChanged.into());
            }
            self.peak = self.peak.max(source.resident_bytes());
            self.view = Some((doc.file, doc.provided, source));
        }
        let source = &self.view.as_ref().unwrap().2;
        Ok(Chunk {
            path: file.display.clone(),
            start: doc.start,
            end: doc.end,
            content: source.part(doc.start, doc.end)?.into(),
            counts: HashMap::new(),
            scores: None,
        })
    }
}
