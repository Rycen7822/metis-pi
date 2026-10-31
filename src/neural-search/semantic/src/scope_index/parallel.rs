//! Request-local code scanning. No encoder handles or decoded corpus cross tasks.
use super::{HEADER, ScopeIndex, lexical::Statistics, number, pages};
use crate::{
    Result,
    index::{Corrupt, codec::Decoder},
    semantic::{CodeScan, Work},
};
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread,
};

// Geometry-based admission, independent of queries, repository names or datasets.
// Keep mapped batches and concurrent JSON input below the serial worst case.
const MAPPED_BATCH: usize = 8 << 20;
const METADATA_BATCH: usize = 1 << 20;
const BYTES_PER_WORKER: usize = 64 << 10;

pub(super) fn workers(records: usize, bytes: usize, limit: usize) -> usize {
    records.min(bytes / BYTES_PER_WORKER).min(limit).max(1)
}
#[derive(Debug)]
struct Cancelled;
impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cached scan cancelled")
    }
}
impl std::error::Error for Cancelled {}
#[derive(Default)]
struct Part {
    items: Vec<(usize, f64, f64, bool, Vec<usize>)>,
    work: Work,
    error: Option<Box<dyn std::error::Error + Send + Sync>>,
}
pub(super) struct ScanOutcome {
    pub work: Work,
    pub result: Result<Vec<f64>>,
    pub worker_limit: usize,
    pub batches: usize,
}
impl ScopeIndex {
    pub(super) fn batch_end(&self, start: usize) -> Result<(usize, usize, usize)> {
        let mut end = start;
        let mut stored = 0usize;
        let mut metadata = 0usize;
        while end < self.count {
            let table = self.record_table + end * 16;
            let at = number(&self.map, table)?;
            let bytes = number(&self.map, table + 8)?;
            if at < HEADER
                || bytes < 64
                || at.checked_add(bytes).is_none_or(|n| n > self.record_table)
            {
                return Err("invalid record boundary table".into());
            }
            let raw = number(&self.map, at + 56)?;
            let raw = if raw == 0 {
                number(&self.map, at + 16)?
            } else {
                raw
            };
            let next_stored = stored
                .checked_add(bytes)
                .ok_or("record batch size overflow")?;
            let next_metadata = metadata
                .checked_add(raw)
                .ok_or("metadata batch size overflow")?;
            if end > start && (next_stored > MAPPED_BATCH || next_metadata > METADATA_BATCH) {
                break;
            }
            stored = next_stored;
            metadata = next_metadata;
            end += 1;
        }
        Ok((end, stored, metadata))
    }
    fn scan_part(
        &self,
        code: &CodeScan<'_>,
        avg: f64,
        exact: Option<&regex::Regex>,
        words: Option<&[String]>,
        next: &AtomicUsize,
        end: usize,
        stop: &AtomicBool,
    ) -> Part {
        let mut part = Part::default();
        let result = (|| -> Result<()> {
            let mut decoder = Decoder::new()?;
            while !stop.load(Ordering::Acquire) {
                let id = next.fetch_add(1, Ordering::Relaxed);
                if id >= end {
                    break;
                }
                let record = self.record(id, &mut decoder)?;
                let (lexical, frequencies) = match words {
                    Some(words) => (-0.0, Statistics::row(&record, words)),
                    None => (self.lexical_score(&record, avg), Vec::new()),
                };
                let exact = exact.is_some_and(|pattern| pattern.is_match(&record.chunk.content));
                let score = code.score_blocks(
                    |sink| {
                        record.visit(&mut decoder, &mut |block| {
                            if stop.load(Ordering::Acquire) {
                                return Err(Box::new(Cancelled));
                            }
                            sink(block)
                        })
                    },
                    &mut part.work,
                )?;
                part.items.push((id, score, lexical, exact, frequencies));
            }
            Ok(())
        })();
        if let Err(error) = result {
            if !error.is::<Cancelled>() {
                stop.store(true, Ordering::Release);
                part.error = Some(error);
            }
        }
        part
    }
    pub(super) fn parallel_code_scan(
        &self,
        code: &CodeScan<'_>,
        avg: f64,
        exact_pattern: Option<&regex::Regex>,
        lexical: &mut [f64],
        exact: &mut HashSet<usize>,
        mut statistics: Option<&mut Statistics<'_>>,
        limit: usize,
    ) -> ScanOutcome {
        let mut outcome = ScanOutcome {
            work: Work::default(),
            result: Ok(Vec::new()),
            worker_limit: 1,
            batches: 0,
        };
        let words = statistics.as_ref().map(|s| s.words);
        let result = (|| -> Result<Vec<f64>> {
            let mut similarities = vec![0.0; self.count];
            let mut start = 0;
            while start < self.count {
                let (end, bytes, _) = self.batch_end(start).map_err(Corrupt::wrap)?;
                let count = workers(end - start, bytes, limit);
                outcome.worker_limit = outcome.worker_limit.max(count);
                outcome.batches += 1;
                let next = AtomicUsize::new(start);
                let stop = AtomicBool::new(false);
                // No reference into the mapping escapes this scope. In
                // particular, neither an error nor a panic may bypass join.
                let parts = thread::scope(|scope| {
                    let mut handles = Vec::new();
                    let mut parts = Vec::new();
                    for _ in 1..count {
                        let next = &next;
                        let stop = &stop;
                        match thread::Builder::new()
                            .name("semantic-scan".into())
                            .spawn_scoped(scope, move || {
                                self.scan_part(code, avg, exact_pattern, words, next, end, stop)
                            }) {
                            Ok(handle) => handles.push(handle),
                            Err(error) => {
                                stop.store(true, Ordering::Release);
                                parts.push(Part {
                                    error: Some(error.into()),
                                    ..Part::default()
                                });
                                break;
                            }
                        }
                    }
                    if parts.is_empty() {
                        parts.push(self.scan_part(
                            code,
                            avg,
                            exact_pattern,
                            words,
                            &next,
                            end,
                            &stop,
                        ));
                    }
                    for handle in handles {
                        match handle.join() {
                            Ok(part) => parts.push(part),
                            Err(_) => {
                                stop.store(true, Ordering::Release);
                                parts.push(Part {
                                    error: Some(
                                        "UNVERIFIED_BACKEND: cached scan worker panicked".into(),
                                    ),
                                    ..Part::default()
                                });
                            }
                        }
                    }
                    parts
                });
                let mut error: Option<Box<dyn std::error::Error + Send + Sync>> = None;
                for part in parts {
                    outcome.work.semantic_scored_chunks += part.work.semantic_scored_chunks;
                    outcome.work.scored_document_tokens += part.work.scored_document_tokens;
                    for (id, score, bm25, is_exact, frequencies) in part.items {
                        if let Some(statistics) = &mut statistics {
                            statistics.rows[id] = frequencies;
                        }
                        similarities[id] = score;
                        lexical[id] = bm25;
                        if is_exact {
                            exact.insert(id);
                        }
                    }
                    if let Some(next) = part.error {
                        // An observed model/resource failure must not be hidden
                        // behind a recoverable stored-data error from a peer.
                        if error.as_ref().is_none_or(|old| old.is::<Corrupt>()) {
                            error = Some(next);
                        }
                    }
                }
                // Failure hands the mapping back to its owner for teardown;
                // do not let an extra advisory I/O error mask the original one.
                if let Some(error) = error {
                    return Err(error);
                }
                // All tasks and borrowed records are gone.
                // Only the coordinator releases pages; boundary pages may be
                // shared by adjacent records/workers in this mapping.
                let consumed = if end == self.count {
                    self.record_table
                } else {
                    number(&self.map, self.record_table + end * 16)?
                };
                pages::release(
                    &self.map,
                    if start == 0 {
                        HEADER
                    } else {
                        number(&self.map, self.record_table + start * 16)?
                    },
                    consumed,
                )?;
                start = end;
            }
            Ok(similarities)
        })();
        outcome.result = result;
        outcome
    }
}
