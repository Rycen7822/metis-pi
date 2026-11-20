//! Immutable, dated HNSW snapshots. SQLite is the authority on publication and live vectors.
use super::Index;
use crate::Result;
use metis_bekko::{DOCUMENT_BYTES, Document, EMBEDDING_DIMENSION};
use rusqlite::{Connection, OptionalExtension, params};
use rustix::fs::{FlockOperation, Mode, OFlags, flock, openat};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};
use usearch::{Index as Hnsw, IndexOptions, MetricKind, ScalarKind};

const HOUR: i64 = 3_600;
const DAY: i64 = 86_400;
const FANOUT: usize = 512;
const MAX_PARTS: usize = 60;

#[derive(Clone, Copy)]
pub struct GraphPolicy {
    pub now: i64,
    pub retention_days: u32,
    /// None disables construction and use, but never prevents expiry cleanup.
    pub min_nodes: Option<usize>,
}

impl GraphPolicy {
    fn first_full_day(self) -> i64 {
        let cutoff = self
            .now
            .saturating_sub(i64::from(self.retention_days) * DAY);
        cutoff.div_euclid(DAY) + i64::from(cutoff.rem_euclid(DAY) != 0)
    }
}

#[derive(Debug, Default, serde::Serialize)]
pub struct GraphReport {
    pub built: usize,
    pub removed: usize,
}

struct Part {
    day: i64,
    through: i64,
    nodes: usize,
    file: String,
    bytes: u64,
    hash: [u8; 32],
}

impl Index {
    /// Drop only replaceable graph state when more space is needed for the exact index.
    pub fn reclaim_graphs(&self) -> Result<usize> {
        let lease = openat(
            &self.cache_dir,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        flock(&lease, FlockOperation::NonBlockingLockExclusive)?;
        self.db.execute("DELETE FROM graph_parts", [])?;
        clean_files(&self.db, &self.cache_path)
    }

    pub fn maintain_graphs(
        &mut self,
        policy: GraphPolicy,
        mut budget: u64,
        mut check: impl FnMut() -> Result<()>,
        mut verify_policy: impl FnMut() -> Result<()>,
    ) -> Result<GraphReport> {
        let lease = openat(
            &self.cache_dir,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        flock(&lease, FlockOperation::NonBlockingLockExclusive)?;
        check()?;
        verify_policy()?;
        let previous: Option<(i64, u32, Option<usize>)> = self
            .db
            .query_row("SELECT at,retention,min_nodes FROM graph_poll", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .optional()?;
        if previous.is_some_and(|(at, days, min)| {
            policy.now >= at
                && policy.now - at < HOUR
                && days == policy.retention_days
                && min == policy.min_nodes
        }) {
            return Ok(GraphReport::default());
        }
        let oldest = policy.first_full_day();
        self.db
            .execute("DELETE FROM graph_parts WHERE day<?1", [oldest])?;
        let mut report = GraphReport {
            removed: clean_files(&self.db, &self.cache_path)?,
            built: 0,
        };
        if let Some(min) = policy.min_nodes {
            let watermark: i64 = self.db.query_row(
                "SELECT coalesce(min(CASE WHEN indexed_at>?1 THEN chunk END)-1,max(chunk),0) FROM vectors",
                [policy.now.saturating_sub(HOUR)], |row| row.get(0),
            )?;
            let plan = {
                let mut sql = self.db.prepare(
                    "SELECT v.day,count(*),max(v.chunk) FROM vectors v
                     WHERE v.day>=?1 AND v.chunk<=?2 GROUP BY v.day HAVING count(*)>=?3 ORDER BY v.day DESC LIMIT ?4",
                )?;
                sql.query_map(params![oldest, watermark, min, MAX_PARTS], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, usize>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (day, nodes, last) in plan {
                check()?;
                let unchanged: bool = self.db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM graph_parts WHERE day=?1 AND through>=?2 AND nodes=?3)",
                    params![day, last, nodes], |row| row.get(0),
                )?;
                if unchanged
                    && parts(&self.db, day)?
                        .into_iter()
                        .find(|part| part.day == day)
                        .is_some_and(|part| {
                            digest(&self.cache_path.join(part.file), part.bytes)
                                .is_ok_and(|hash| hash == part.hash)
                        })
                {
                    continue;
                }
                // Conservative admission before reserving memory; actual serialized bytes are also checked.
                if (nodes as u64).saturating_mul(576) > budget {
                    continue;
                }
                let tx = self.db.unchecked_transaction()?;
                let graph = build(&tx, day, watermark, nodes, &mut check)?;
                let size = graph.serialized_length() as u64;
                if size > budget {
                    continue;
                }
                let file = tempfile::Builder::new()
                    .prefix("graph-")
                    .suffix(".ann")
                    .tempfile_in(&self.cache_path)?;
                graph.save(as_utf8(file.path())?)?;
                file.as_file().sync_all()?;
                let hash = digest(file.path(), size)?;
                check()?;
                verify_policy()?;
                let name = file
                    .path()
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("Invalid graph filename")?
                    .to_owned();
                // No reader uses this file until the transaction commits, even if the process exits here.
                let path = file.into_temp_path().keep()?;
                self.cache_dir.sync_all()?;
                tx.execute(
                    "INSERT OR REPLACE INTO graph_parts VALUES(?,?,?,?,?,?)",
                    params![day, watermark, nodes, name, size, hash.as_slice()],
                )?;
                tx.commit()?;
                budget -= size;
                report.built += 1;
                debug_assert!(path.starts_with(&self.cache_path));
            }
        }
        report.removed += clean_files(&self.db, &self.cache_path)?;
        self.db.execute(
            "INSERT OR REPLACE INTO graph_poll VALUES(1,?,?,?)",
            params![policy.now, policy.retention_days, policy.min_nodes],
        )?;
        Ok(report)
    }
}

pub(super) struct GraphCandidates {
    pub ids: Vec<i64>,
    pub covered: Vec<(i64, i64)>,
}

/// Returns candidate IDs and only the coverage proven by readable, compatible graph snapshots.
pub(super) fn candidates(
    db: &Connection,
    cache: &Path,
    policy: GraphPolicy,
    q: &[f32; EMBEDDING_DIMENSION],
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Option<GraphCandidates>> {
    let Some(min) = policy.min_nodes else {
        return Ok(None);
    };
    let parts: Vec<_> = parts(db, policy.first_full_day())?
        .into_iter()
        .filter(|part| part.nodes >= min)
        .collect();
    let covered_nodes: usize = parts.iter().map(|part| part.nodes).sum();
    if covered_nodes == 0 {
        return Ok(None);
    }
    let vectors: usize = db.query_row("SELECT count(*) FROM vectors", [], |row| row.get(0))?;
    if covered_nodes < vectors.div_ceil(2) {
        return Ok(None);
    }
    let mut ids = Vec::new();
    let mut covered = Vec::new();
    for part in parts {
        check()?;
        let loaded = (|| -> Result<Hnsw> {
            let path = cache.join(&part.file);
            if !owned_name(&part.file) || digest(&path, part.bytes)? != part.hash {
                return Err("Invalid immutable Recall graph".into());
            }
            let graph = Hnsw::new(&options())?;
            graph.view(as_utf8(&path)?)?;
            if graph.size() != part.nodes || graph.dimensions() != EMBEDDING_DIMENSION {
                return Err("Recall graph shape mismatch".into());
            }
            Ok(graph)
        })();
        let Ok(graph) = loaded else {
            return Ok(None);
        };
        match graph.search(q.as_slice(), FANOUT.min(part.nodes)) {
            Ok(found) if !found.keys.is_empty() => {
                for key in found.keys {
                    ids.push(i64::try_from(key)?);
                }
                covered.push((part.day, part.through));
            }
            _ => return Ok(None),
        }
    }
    Ok((!covered.is_empty()).then_some(GraphCandidates { ids, covered }))
}

fn options() -> IndexOptions {
    IndexOptions {
        dimensions: EMBEDDING_DIMENSION,
        metric: MetricKind::Cos,
        quantization: ScalarKind::F16,
        connectivity: 16,
        expansion_add: 200,
        expansion_search: FANOUT,
        multi: false,
    }
}

fn build(
    db: &Connection,
    day: i64,
    through: i64,
    count: usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Hnsw> {
    let graph = Hnsw::new(&options())?;
    graph.reserve(count)?;
    let mut select =
        db.prepare("SELECT chunk,payload FROM vectors WHERE day=?1 AND chunk<=?2 ORDER BY chunk")?;
    let mut rows = select.query(params![day, through])?;
    while let Some(row) = rows.next()? {
        check()?;
        let bytes: [u8; DOCUMENT_BYTES] = row.get(1)?;
        let document =
            Document::from_bytes(&bytes).ok_or("Invalid Recall vector in graph source")?;
        let values = document.stored().0.map(|half| half.to_f32());
        graph.add(row.get(0)?, &values)?;
    }
    if graph.size() != count {
        return Err("Graph did not cover the declared Recall snapshot".into());
    }
    Ok(graph)
}

fn parts(db: &Connection, oldest: i64) -> Result<Vec<Part>> {
    let mut select = db.prepare(
        "SELECT day,through,nodes,file,bytes,sha256 FROM graph_parts WHERE day>=?1 ORDER BY day DESC LIMIT ?2",
    )?;
    Ok(select
        .query_map(params![oldest, MAX_PARTS], |row| {
            Ok(Part {
                day: row.get(0)?,
                through: row.get(1)?,
                nodes: row.get(2)?,
                file: row.get(3)?,
                bytes: row.get(4)?,
                hash: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn owned_name(name: &str) -> bool {
    name.strip_prefix("graph-")
        .and_then(|name| name.strip_suffix(".ann"))
        .is_some_and(|inner| inner.len() == 6 && inner.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn clean_files(db: &Connection, cache: &Path) -> Result<usize> {
    let mut referenced = db.prepare("SELECT EXISTS(SELECT 1 FROM graph_parts WHERE file=?1)")?;
    let mut removed = 0;
    for entry in fs::read_dir(cache)? {
        let entry = entry?;
        if let Some(name) = entry.file_name().to_str()
            && owned_name(name)
            && entry.file_type()?.is_file()
            && !referenced.query_row([name], |row| row.get::<_, bool>(0))?
        {
            // Linux readers that already mapped/opened it retain the inode; no reader is forced to wait.
            fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn as_utf8(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| "Graph cache path is not UTF-8".into())
}

fn digest(path: &Path, expected: u64) -> Result<[u8; 32]> {
    let stat = path.symlink_metadata()?;
    if !stat.is_file() || stat.len() != expected {
        return Err("Recall graph file no longer matches its metadata".into());
    }
    let mut input = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut remaining = expected;
    let mut scratch = [0u8; 64 * 1024];
    while remaining > 0 {
        let count = remaining.min(scratch.len() as u64) as usize;
        input.read_exact(&mut scratch[..count])?;
        hash.update(&scratch[..count]);
        remaining -= count as u64;
    }
    Ok(hash.finalize().into())
}
