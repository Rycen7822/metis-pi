//! Request-local reuse of one fully scored immutable Code/Format08 scope.
//! Current source capture, corpus statistics and final ranking remain authoritative.
use super::{MAGIC, Metadata, ScopeIndex};
use crate::{Chunk, Result, record::codec::Decoder, semantic::ModelKind};
use std::{
    collections::HashMap,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
};

// Per changed file only: bound retained text plus descriptor/map bookkeeping.
// Overflow disables that file's matching, not full-scope evaluation.
const CHANGED_FILE_SCRATCH_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(crate) struct ReusedRecord {
    pub(super) record_id: usize,
    pub(super) score: f64,
    pub(super) scored_rows: usize,
    pub(super) word_count: usize,
    pub(super) start: usize,
    pub(super) end: usize,
}
pub(crate) struct CheckedChunk {
    pub chunk: Chunk,
    pub reused: ReusedRecord,
}
pub(crate) struct RebuildSource {
    previous: ScopeIndex,
    scores: Vec<f64>,
    decoder: Decoder,
    next_id: usize,
    pending: Option<CheckedChunk>,
    last_path: String,
}

fn path_name(bytes: &[u8]) -> Option<&str> {
    let path = Path::new(std::str::from_utf8(bytes).ok()?);
    path.strip_prefix(".").unwrap_or(path).to_str()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_aliases_and_non_utf8_paths_cannot_borrow_reuse_identity() {
        let mut names = HashMap::new();
        assert!(unique_paths([b"./a.py".as_slice()].into_iter(), &mut names).unwrap());
        assert!(unique_paths([b"./a.py".as_slice()].into_iter(), &mut names).unwrap());
        assert!(!unique_paths([b"a.py".as_slice()].into_iter(), &mut names).unwrap());
        assert!(
            !unique_paths(
                [b"invalid-\xff.py".as_slice()].into_iter(),
                &mut HashMap::new()
            )
            .unwrap()
        );
    }
}

fn unique_paths<'a>(
    paths: impl Iterator<Item = &'a [u8]>,
    names: &mut HashMap<&'a str, &'a [u8]>,
) -> Result<bool> {
    let mut last = None;
    for raw in paths {
        crate::request::check()?;
        let Some(name) = path_name(raw) else {
            return Ok(false);
        };
        if last.is_some_and(|last| last >= raw)
            || names
                .insert(name, raw)
                .is_some_and(|previous| previous != raw)
        {
            return Ok(false);
        }
        last = Some(raw);
    }
    Ok(true)
}

impl RebuildSource {
    pub(crate) fn new(previous: ScopeIndex, scores: Vec<f64>) -> Result<Option<Self>> {
        if previous.map.get(..8) != Some(MAGIC)
            || previous.metadata.kind != ModelKind::Code.stored_tag()
            || scores.len() != previous.len()
        {
            return Ok(None);
        }
        Ok(Some(Self {
            previous,
            scores,
            decoder: Decoder::new()?,
            next_id: 0,
            pending: None,
            last_path: String::new(),
        }))
    }
    pub(crate) fn compatible_paths<'a>(&'a self, current: &'a [PathBuf]) -> Result<bool> {
        let mut names = HashMap::new();
        Ok(unique_paths(
            self.previous
                .metadata
                .source_snapshot
                .files
                .iter()
                .map(|f| f.path.as_slice()),
            &mut names,
        )? && unique_paths(current.iter().map(|p| p.as_os_str().as_bytes()), &mut names)?)
    }
    pub(super) fn matches(&self, current: &Metadata) -> bool {
        let previous = &self.previous.metadata;
        previous.kind == current.kind
            && previous.artifact == current.artifact
            && previous.source_snapshot.scope == current.source_snapshot.scope
    }
    fn peek(&mut self) -> Result<Option<&CheckedChunk>> {
        if self.pending.is_none() && self.next_id < self.previous.len() {
            crate::request::check()?;
            let record = self.previous.record(self.next_id, &mut self.decoder)?;
            if record.chunk.path < self.last_path {
                return Err(crate::record::CorruptRecord::wrap(
                    "unordered reuse records".into(),
                ));
            }
            self.last_path.clone_from(&record.chunk.path);
            let reused = ReusedRecord {
                record_id: self.next_id,
                score: self.scores[self.next_id],
                scored_rows: record.scored_rows()?,
                word_count: record.length,
                start: record.chunk.start,
                end: record.chunk.end,
            };
            self.pending = Some(CheckedChunk {
                chunk: record.chunk,
                reused,
            });
            self.next_id += 1;
        }
        Ok(self.pending.as_ref())
    }
    pub(crate) fn file<'a>(
        &'a mut self,
        raw: &[u8],
        digest: &[u8; 32],
    ) -> Result<PreviousFile<'a>> {
        let name = path_name(raw).ok_or("ambiguous reuse path")?.to_owned();
        while self.peek()?.is_some_and(|record| record.chunk.path < name) {
            self.pending.take();
        }
        let unchanged = self
            .previous
            .metadata
            .source_snapshot
            .files
            .binary_search_by(|f| f.path.as_slice().cmp(raw))
            .ok()
            .is_some_and(|id| self.previous.metadata.source_snapshot.files[id].digest == *digest);
        Ok(PreviousFile {
            source: self,
            name,
            unchanged,
            matches: None,
            matching_disabled: false,
        })
    }
    pub(super) fn copy(
        &self,
        record: ReusedRecord,
        output: &mut (impl std::io::Write + std::io::Seek),
        relocated: Option<&Chunk>,
    ) -> Result<(u64, u64)> {
        crate::record::copy_checked(
            self.previous.record_bytes(record.record_id)?,
            output,
            relocated,
        )
    }
}

pub(crate) struct PreviousFile<'a> {
    source: &'a mut RebuildSource,
    name: String,
    pub unchanged: bool,
    matches: Option<HashMap<String, Vec<ReusedRecord>>>,
    matching_disabled: bool,
}
impl PreviousFile<'_> {
    pub(crate) fn next(&mut self) -> Result<Option<CheckedChunk>> {
        if self
            .source
            .peek()?
            .is_some_and(|record| record.chunk.path == self.name)
        {
            Ok(self.source.pending.take())
        } else {
            Ok(None)
        }
    }
    pub(crate) fn find(&mut self, chunk: &Chunk) -> Result<Option<ReusedRecord>> {
        if self.matching_disabled {
            return Ok(None);
        }
        if self.matches.is_none() {
            let mut matches: HashMap<String, Vec<ReusedRecord>> = HashMap::new();
            let mut bytes = 0usize;
            while let Some(record) = self.next()? {
                crate::request::check()?;
                bytes = bytes.saturating_add(
                    record.chunk.content.capacity() + 2 * size_of::<CheckedChunk>(),
                );
                if bytes > CHANGED_FILE_SCRATCH_BYTES {
                    self.matching_disabled = true;
                    return Ok(None);
                }
                matches
                    .entry(record.chunk.content)
                    .or_default()
                    .push(record.reused);
            }
            self.matches = Some(matches);
        }
        // Consume an old ID at most once: duplicate new blocks still have honest work counts.
        Ok(self
            .matches
            .as_mut()
            .and_then(|m| m.get_mut(&chunk.content))
            .and_then(Vec::pop))
    }
}
