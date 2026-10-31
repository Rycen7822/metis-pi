//! Two-pass, query-independent source reconstruction. Retained state is positions
//! and query-relevant statistics, not corpus text, full word maps or embeddings.
use crate::{
    Args, Chunk, Result,
    scope_index::{Manifest, SourceChanged, Stamp},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

const METADATA_CAP: usize = 128 << 20;

pub struct Source {
    pub text: String,
    starts: Vec<usize>,
    pub digest: [u8; 32],
    pub binary: bool,
}
impl Source {
    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path)?;
        let digest = Sha256::digest(&bytes).into();
        let binary = bytes.contains(&0);
        let text = if binary {
            String::new()
        } else {
            String::from_utf8(bytes)
                .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
        };
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
        Ok(Self {
            text,
            starts,
            digest,
            binary,
        })
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
struct File {
    path: PathBuf,
    display: String,
    digest: [u8; 32],
    in_manifest: bool,
}
struct Document {
    file: usize,
    start: usize,
    end: usize,
    provided: bool,
    length: usize,
    matches: Vec<(usize, usize)>,
    exact: bool,
}
pub struct Corpus {
    files: Vec<File>,
    documents: Vec<Document>,
    pub corpus_len: usize,
    pub supplied: Vec<usize>,
    pub prose_only: bool,
    pub metadata_bytes: usize,
    pub source_peak_bytes: usize,
    pub manifest: Option<Manifest>,
}
impl Corpus {
    pub fn scan(
        args: &Args,
        scope: &Path,
        filter: &crate::storage::SourceFilter,
        terms: &[String],
    ) -> Result<Self> {
        let mut corpus = Self {
            files: Vec::new(),
            documents: Vec::new(),
            corpus_len: 0,
            supplied: Vec::new(),
            prose_only: true,
            metadata_bytes: 0,
            source_peak_bytes: 0,
            manifest: None,
        };
        let mut files = HashMap::new();
        let mut locations = HashMap::new();
        let pattern = crate::identifier_pattern(&args.query)?;
        if args.stdin {
            crate::rg_input::visit(Path::new("-"), scope, |path, digest, chunk| {
                corpus.add(
                    path,
                    digest,
                    false,
                    true,
                    chunk,
                    false,
                    terms,
                    &pattern,
                    &mut files,
                    &mut locations,
                )
            })?;
            corpus.corpus_len = corpus.documents.len();
        } else {
            let (root, names) = crate::source_files(scope, filter)?;
            let mut manifest = Manifest {
                scope: scope.as_os_str().as_encoded_bytes().to_vec(),
                files: Vec::with_capacity(names.len()),
            };
            corpus.budget(
                manifest.scope.capacity()
                    + manifest.files.capacity() * std::mem::size_of::<Stamp>(),
            )?;
            for name in names {
                crate::request::check()?;
                let relative = name.strip_prefix(".").unwrap_or(&name);
                let path = root.join(relative);
                let source = Source::read(&path).map_err(source_read_error)?;
                let stamp = Stamp {
                    path: name.as_os_str().as_encoded_bytes().to_vec(),
                    digest: source.digest,
                };
                corpus.budget(stamp.path.capacity())?;
                manifest.files.push(stamp);
                if source.binary {
                    continue;
                }
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
                    corpus.add(
                        path.clone(),
                        source.digest,
                        true,
                        false,
                        chunk,
                        false,
                        terms,
                        &pattern,
                        &mut files,
                        &mut locations,
                    )?;
                }
            }
            corpus.manifest = Some(manifest);
            corpus.corpus_len = corpus.documents.len();
            if let Some(input) = &args.rg_json {
                crate::rg_input::visit(input, scope, |path, digest, chunk| {
                    corpus.add(
                        path,
                        digest,
                        false,
                        true,
                        chunk,
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
        if self.metadata_bytes > METADATA_CAP {
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
        in_manifest: bool,
        provided: bool,
        chunk: Chunk,
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
            self.files[id].in_manifest |= in_manifest;
            id
        } else {
            self.budget(
                std::mem::size_of::<File>() + path.as_os_str().len() * 2 + chunk.path.len() + 128,
            )?;
            let id = self.files.len();
            self.files.push(File {
                path: path.clone(),
                display: chunk.path.clone(),
                digest,
                in_manifest,
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
            std::mem::size_of::<Document>()
                + matches.capacity() * std::mem::size_of::<(usize, usize)>()
                + chunk.path.len()
                + 96,
        )?;
        let exact = pattern
            .as_ref()
            .is_some_and(|(pattern, _)| pattern.is_match(&chunk.content));
        let document = self.documents.len();
        self.documents.push(Document {
            file,
            start: chunk.start,
            end: chunk.end,
            provided,
            length: chunk.counts.values().sum(),
            matches,
            exact,
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
            .map(|&df| {
                if df == 0 {
                    0.
                } else {
                    (1. + (self.corpus_len as f64 - df as f64 + 0.5) / (df as f64 + 0.5)).ln()
                }
            })
            .collect();
        self.documents
            .iter()
            .map(|row| {
                row.matches
                    .iter()
                    .filter(|(term, _)| frequencies[*term] > 0)
                    .map(|&(term, count)| crate::term_score(idf[term], count, row.length, average))
                    .sum()
            })
            .collect()
    }
    pub fn visit(&self, mut consume: impl FnMut(Chunk) -> Result<()>) -> Result<usize> {
        let mut reader = Reader::default();
        for i in 0..self.len() {
            consume(reader.chunk(self, i)?)?;
        }
        Ok(reader.peak)
    }
    pub fn verify_provided(&self) -> Result<()> {
        for file in self.files.iter().filter(|f| !f.in_manifest) {
            if crate::scope_index::file_digest(&file.path).map_or(true, |d| d != file.digest) {
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
pub struct Reader {
    view: Option<(usize, bool, Source)>,
    pub peak: usize,
}
impl Reader {
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
            let source = Source::read(&file.path).map_err(source_read_error)?;
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
