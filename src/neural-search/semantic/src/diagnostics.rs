//! Opt-in query diagnostics, not a retrieval stage or a latency oracle. Ranking
//! traces are profiling work: keep them disabled for normal CLI timing samples.
use crate::{Args, Chunk, Result, semantic::Work};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub fn check_scope(work: Work, scope: usize, extra: usize) -> Result<()> {
    if scope.checked_add(extra) != Some(work.semantic_scored_chunks) {
        return Err(format!(
            "INCOMPLETE_SCOPE: observed {} scored chunks, expected {scope}+{extra}",
            work.semantic_scored_chunks
        )
        .into());
    }
    Ok(())
}

pub fn stages(
    value: impl FnOnce() -> serde_json::Value,
    work: Work,
    scope: usize,
    extra: usize,
) -> Result<()> {
    if let Some(context) = crate::request::current() {
        context.control.work(serde_json::to_value(work)?);
    }
    if let Some(path) = crate::request::var_os("SGREP_STAGE_TIMINGS_PATH") {
        let mut value = value();
        let object = value
            .as_object_mut()
            .ok_or("invalid CLI diagnostic object")?;
        let serde_json::Value::Object(fields) = serde_json::to_value(work)? else {
            unreachable!()
        };
        object.extend(fields);
        object.insert("scope_chunks".into(), scope.into());
        object.insert("supplied_extra_chunks".into(), extra.into());
        fs::write(path, format!("{value}\n"))?;
    }
    Ok(())
}

/// The ranker supplies its actual lane/order IDs before fusion/containment.
/// Candidate identities are serialized one at a time, not retained source text.
/// Only commit after the normal source checks: a failed/retried request cannot
/// publish a provisional trace as a successful retrieval observation.
pub struct RetrievalTrace {
    destination: PathBuf,
    pending: tempfile::NamedTempFile,
    query: String,
    stdin: bool,
    pub lexical: Vec<usize>,
    pub semantic: Vec<usize>,
    pub supplied: Vec<usize>,
    pub exact: Vec<usize>,
    captured: bool,
}

#[derive(Serialize)]
struct Candidate<'a> {
    id: usize,
    path: &'a str,
    start: usize,
    end: usize,
    bm25: f64,
    semantic: f64,
    exact_identifier: bool,
}

impl RetrievalTrace {
    pub fn from_env(args: &Args) -> Result<Option<Self>> {
        let Some(path) = crate::request::var_os("SGREP_RETRIEVAL_TRACE_PATH") else {
            return Ok(None);
        };
        let destination = PathBuf::from(path);
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let pending = tempfile::Builder::new()
            .prefix(".sgrep-retrieval-")
            .tempfile_in(parent)?;
        Ok(Some(Self {
            destination,
            pending,
            query: args.query.clone(),
            stdin: args.stdin,
            lexical: Vec::new(),
            semantic: Vec::new(),
            supplied: Vec::new(),
            exact: Vec::new(),
            captured: false,
        }))
    }

    pub fn capture(
        &mut self,
        lexical: &[f64],
        similarities: &[f64],
        union: &[usize],
        final_ids: &[usize],
        exact: &HashSet<usize>,
        mut get_chunk: impl FnMut(usize) -> Result<Chunk>,
    ) -> Result<()> {
        let mut out = BufWriter::new(self.pending.as_file_mut());
        out.write_all(b"{\"schema_version\":1,\"query\":")?;
        serde_json::to_writer(&mut out, &self.query)?;
        out.write_all(b",\"stdin\":")?;
        serde_json::to_writer(&mut out, &self.stdin)?;
        for (name, ids) in [
            ("semantic_top200", &self.semantic),
            ("bm25_top200", &self.lexical),
            ("supplied", &self.supplied),
            ("exact", &self.exact),
        ] {
            write!(out, ",\"{name}\":")?;
            serde_json::to_writer(&mut out, ids)?;
        }
        out.write_all(b",\"union\":")?;
        serde_json::to_writer(&mut out, union)?;
        out.write_all(b",\"final\":")?;
        serde_json::to_writer(&mut out, final_ids)?;
        out.write_all(b",\"candidates\":[")?;
        for id in 0..similarities.len() {
            if id > 0 {
                out.write_all(b",")?;
            }
            let chunk = get_chunk(id)?;
            serde_json::to_writer(
                &mut out,
                &Candidate {
                    id,
                    path: &chunk.path,
                    start: chunk.start,
                    end: chunk.end,
                    bm25: lexical[id],
                    semantic: similarities[id],
                    exact_identifier: exact.contains(&id),
                },
            )?;
        }
        out.write_all(b"]")?;
        out.flush()?;
        self.captured = true;
        Ok(())
    }

    pub fn commit(mut self, work: Work, scope: usize, extra: usize, hit: bool) -> Result<()> {
        if !self.captured {
            self.capture(&[], &[], &[], &[], &HashSet::new(), |_| {
                Err("missing diagnostic candidate".into())
            })?;
        }
        let out = self.pending.as_file_mut();
        write!(
            out,
            ",\"scope_chunks\":{scope},\"supplied_extra_chunks\":{extra},\"cache_hit\":{hit},\"work\":"
        )?;
        serde_json::to_writer(&mut *out, &work)?;
        out.write_all(b",\"source_verified\":true}\n")?;
        out.sync_all()?;
        self.pending.persist(&self.destination)?;
        Ok(())
    }
}
