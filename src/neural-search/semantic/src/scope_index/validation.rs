//! Complete record metadata/DF validation, before query encoding or scoring.
use super::{HEADER, ScopeIndex, number, pages, parallel};
use crate::{Result, index::codec::Decoder, semantic::Kind};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread,
};

// Includes borrowed key slots and all concurrent integer DF arrays, not N×Q
// postings or retained Chunk values. Wide queries keep the serial path.
const DF_SCRATCH: usize = 1 << 20;
struct Summary {
    length: usize,
    df: Vec<usize>,
}
impl ScopeIndex {
    fn validation_part(
        &self,
        kind: Kind,
        keys: &[&str],
        next: &AtomicUsize,
        end: usize,
        stop: &AtomicBool,
    ) -> Result<Summary> {
        let mut decoder = Decoder::new()?;
        let mut part = Summary {
            length: 0,
            df: vec![0; keys.len()],
        };
        while !stop.load(Ordering::Acquire) {
            crate::request::check()?;
            let id = next.fetch_add(1, Ordering::Relaxed);
            if id >= end {
                break;
            }
            let record = self.record(id, &mut decoder)?;
            if record.kind() != kind {
                return Err("record/scope model mismatch".into());
            }
            part.length = record
                .chunk
                .counts
                .values()
                .try_fold(part.length, |sum, n| {
                    sum.checked_add(*n).ok_or("corpus length overflow")
                })?;
            if keys.len() <= record.chunk.counts.len() {
                for (i, key) in keys.iter().enumerate() {
                    if record.chunk.counts.contains_key(*key) {
                        part.df[i] += 1;
                    }
                }
            } else {
                for key in record.chunk.counts.keys() {
                    if let Ok(i) = keys.binary_search(&key.as_str()) {
                        part.df[i] += 1;
                    }
                }
            }
        }
        Ok(part)
    }
    pub(super) fn validate_records(
        &mut self,
        kind: Kind,
        query_df: &mut BTreeMap<String, usize>,
    ) -> Result<usize> {
        let mut length = 0usize;
        let mut start = 0;
        let mut next_boundary = HEADER;
        let mut decoder = Decoder::new()?;
        // Two usize slots per &str key, plus one usize per worker/term.
        let term_bytes = query_df
            .len()
            .checked_mul(std::mem::size_of::<usize>())
            .ok_or("DF size overflow")?;
        let df_workers = if term_bytes == 0 {
            4
        } else {
            (DF_SCRATCH / term_bytes).saturating_sub(2).max(1)
        };
        while start < self.count {
            crate::request::check()?;
            let (end, _, raw_metadata) = self.batch_end(start)?;
            // Validate the chain in record order before handing out its records.
            for id in start..end {
                let at = number(&self.map, self.record_table + id * 16)?;
                let bytes = number(&self.map, self.record_table + id * 16 + 8)?;
                if at != next_boundary
                    || at.checked_add(bytes).is_none_or(|n| n > self.record_table)
                {
                    return Err("invalid record boundary table".into());
                }
                if number(&self.map, at + 8)? != bytes {
                    return Err("record length disagrees with scope table".into());
                }
                next_boundary = at + bytes;
            }
            let count = parallel::workers(
                end - start,
                raw_metadata,
                crate::semantic::computing_threads(),
            )
            .min(df_workers);
            self.timings.validation_worker_limit = self.timings.validation_worker_limit.max(count);
            self.timings.validation_batches += 1;
            if count == 1 {
                for id in start..end {
                    crate::request::check()?;
                    let record = self.record(id, &mut decoder)?;
                    if record.kind() != kind {
                        return Err("record/scope model mismatch".into());
                    }
                    length = record.chunk.counts.values().try_fold(length, |sum, n| {
                        sum.checked_add(*n).ok_or("corpus length overflow")
                    })?;
                    if query_df.len() <= record.chunk.counts.len() {
                        for (word, df) in query_df.iter_mut() {
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
                }
            } else {
                let stop = AtomicBool::new(false);
                let next = AtomicUsize::new(start);
                let context = crate::request::current();
                let parts = {
                    let keys: Vec<&str> = query_df.keys().map(String::as_str).collect();
                    let run = || {
                        let result = if let Some(context) = &context {
                            crate::request::enter(context.clone(), || {
                                self.validation_part(kind, &keys, &next, end, &stop)
                            })
                        } else {
                            self.validation_part(kind, &keys, &next, end, &stop)
                        };
                        if result.is_err() {
                            stop.store(true, Ordering::Release);
                        }
                        result
                    };
                    thread::scope(|scope| {
                        let mut handles = Vec::new();
                        let mut parts = Vec::new();
                        for _ in 1..count {
                            let run = &run;
                            match thread::Builder::new()
                                .name("semantic-metadata".into())
                                .spawn_scoped(scope, run)
                            {
                                Ok(handle) => handles.push(handle),
                                Err(e) => {
                                    stop.store(true, Ordering::Release);
                                    parts.push(Err(e.into()));
                                    break;
                                }
                            }
                        }
                        if parts.is_empty() {
                            parts.push(run());
                        }
                        for handle in handles {
                            parts.push(handle.join().unwrap_or_else(|_| {
                                stop.store(true, Ordering::Release);
                                Err("UNVERIFIED_BACKEND: metadata worker panicked".into())
                            }));
                        }
                        parts
                    })
                };
                let mut error: Option<Box<dyn std::error::Error + Send + Sync>> = None;
                for part in parts {
                    match part {
                        Ok(part) => {
                            length = length
                                .checked_add(part.length)
                                .ok_or("corpus length overflow")?;
                            for ((_, df), n) in query_df.iter_mut().zip(part.df) {
                                *df = df.checked_add(n).ok_or("DF overflow")?;
                            }
                        }
                        Err(next) => {
                            if error
                                .as_ref()
                                .is_none_or(|old| old.is::<crate::index::Corrupt>())
                            {
                                error = Some(next);
                            }
                        }
                    }
                }
                if let Some(error) = error {
                    return Err(error);
                }
            }
            // No decoded record or worker borrows remain; only the owner releases.
            pages::release(
                &self.map,
                if start == 0 {
                    HEADER
                } else {
                    number(&self.map, self.record_table + start * 16)?
                },
                next_boundary,
            )?;
            start = end;
        }
        if next_boundary != self.record_table {
            return Err("non-contiguous records".into());
        }
        Ok(length)
    }
}
