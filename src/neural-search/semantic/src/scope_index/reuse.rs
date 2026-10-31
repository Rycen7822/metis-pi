//! Request-local reuse of checked Code/Format08 records after a source change.
//! New corpus statistics and ranking still belong to the current source snapshot.
use super::{MAGIC, Metadata, ScopeIndex};
use crate::{
    Chunk, Result,
    index::{Record, codec::Decoder},
    semantic::Kind,
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

pub(super) struct Reuse {
    previous: ScopeIndex,
    records: HashMap<String, Vec<(usize, usize, usize)>>,
    decoder: Decoder,
}

fn path_name(bytes: &[u8]) -> Option<&str> {
    let path = Path::new(std::str::from_utf8(bytes).ok()?);
    path.strip_prefix(".").unwrap_or(path).to_str()
}

impl Reuse {
    pub(super) fn new(previous: ScopeIndex, current: &Metadata) -> Result<Option<Self>> {
        if previous.map.get(..8) != Some(MAGIC)
            || current.kind != super::kind_tag(Kind::Code)
            || previous.metadata.kind != current.kind
            || previous.metadata.artifact != current.artifact
            || previous.metadata.manifest.scope != current.manifest.scope
        {
            return Ok(None);
        }
        let old: HashMap<_, _> = previous
            .metadata
            .manifest
            .files
            .iter()
            .map(|stamp| (stamp.path.as_slice(), &stamp.digest))
            .collect();
        let mut names = HashMap::new();
        let mut eligible = HashSet::new();
        for (manifest, is_current) in [
            (&previous.metadata.manifest, false),
            (&current.manifest, true),
        ] {
            let mut last = None;
            for stamp in &manifest.files {
                crate::request::check()?;
                let raw = stamp.path.as_slice();
                // Source paths may be arbitrary bytes. Lossy UI strings are not
                // identity: ambiguous/non-UTF8 scopes keep the original rebuild.
                let Some(name) = path_name(raw) else {
                    return Ok(None);
                };
                if last.is_some_and(|last| last >= raw)
                    || names
                        .insert(name, raw)
                        .is_some_and(|previous| previous != raw)
                {
                    return Ok(None);
                }
                last = Some(raw);
                if is_current && old.get(raw).is_some_and(|digest| **digest == stamp.digest) {
                    eligible.insert(name);
                }
            }
        }
        if eligible.is_empty() {
            return Ok(None);
        }
        let mut decoder = Decoder::new()?;
        let mut records: HashMap<String, Vec<_>> = HashMap::new();
        for id in 0..previous.len() {
            crate::request::check()?;
            let record = previous.record(id, &mut decoder)?;
            if eligible.contains(record.chunk.path.as_str()) {
                if record.kind() != Kind::Code {
                    return Ok(None);
                }
                records.entry(record.chunk.path).or_default().push((
                    record.chunk.start,
                    record.chunk.end,
                    id,
                ));
            }
        }
        drop(eligible);
        drop(names);
        drop(old);
        Ok(Some(Self {
            previous,
            records,
            decoder,
        }))
    }

    pub(super) fn find(&mut self, chunk: &Chunk) -> Result<Option<(Record<'_>, &mut Decoder)>> {
        let Some(entries) = self.records.get(&chunk.path) else {
            return Ok(None);
        };
        let Some(&(_, _, id)) = entries
            .iter()
            .find(|&&(start, end, _)| start == chunk.start && end == chunk.end)
        else {
            return Ok(None);
        };
        let record = self.previous.record(id, &mut self.decoder)?;
        if record.kind() != Kind::Code || record.chunk.content != chunk.content {
            return Ok(None);
        }
        Ok(Some((record, &mut self.decoder)))
    }
}
