//! Hybrid retrieval. Only candidate IDs and scores are retained during a corpus scan.
use super::{
    Coverage, Index,
    graph::{self, GraphPolicy},
    search::{Candidate, Filter, LexicalHit, Scope, resolve_scope},
    terms,
};
use crate::Result;
use metis_bekko::{DOCUMENT_BYTES, Document, EMBEDDING_DIMENSION};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{
    cmp::Ordering,
    collections::{BTreeSet, HashMap},
    path::PathBuf,
};

pub(super) const LANE_LIMIT: usize = 200;
const PER_SESSION_LANE: usize = 8;
const MAX_SESSIONS: usize = 10;
const PER_SESSION_HITS: usize = 3;
const IN_SCOPE: &str = "
    (?1 IS NULL OR s.cwd=?1) AND (?2 IS NULL OR c.source=?2)
    AND (?3 IS NULL OR c.entry IN (SELECT value FROM json_each(?3)))";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridResult {
    pub sessions: Vec<SessionHits>,
    pub stale_candidates: usize,
    pub engine: &'static str,
    #[serde(skip)]
    pub semantic_candidates: Vec<i64>,
    #[serde(skip)]
    pub coverage: Coverage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHits {
    pub session_path: PathBuf,
    pub session_id: String,
    pub hits: Vec<HybridHit>,
}

#[derive(Debug, Serialize)]
pub struct HybridHit {
    #[serde(flatten)]
    pub evidence: LexicalHit,
    pub semantic: f64,
    pub score: f64,
}

impl Index {
    pub fn hybrid(
        &self,
        query: &str,
        scope: Scope<'_>,
        check: impl FnMut() -> Result<()>,
    ) -> Result<HybridResult> {
        self.hybrid_with_graph(query, scope, None, check)
    }

    pub fn hybrid_with_graph(
        &self,
        query: &str,
        scope: Scope<'_>,
        policy: Option<GraphPolicy>,
        mut check: impl FnMut() -> Result<()>,
    ) -> Result<HybridResult> {
        check()?;
        let whole_root = matches!(&scope, Scope::All);
        if query.trim().is_empty() || query.len() > 8192 {
            return Err("Recall hybrid query must be nonblank and at most 8192 bytes".into());
        }
        let encoder = self
            .encoder
            .as_ref()
            .ok_or("Recall hybrid requires a Bekko index")?;
        let (query_vec, _) = encoder.encode(query)?;
        let expression = terms::query(query);
        let tx = self.db.unchecked_transaction()?;
        let filter = resolve_scope(&tx, scope, &mut check)?;
        let lexical = lexical_lane(&tx, &filter, &expression, &mut check)?;
        let graph = if let Some(policy) = policy.filter(|_| whole_root) {
            graph_lane(&tx, &self.cache_path, policy, &query_vec, &mut check)?
        } else {
            None
        };
        let (dense, engine) = match graph {
            Some((mut lane, covered)) => {
                let delta = exact_lane(&tx, &filter, &query_vec, Some(&covered), &mut check)?;
                for item in delta.items {
                    lane.offer(item);
                }
                (lane, "hnsw")
            }
            None => (
                exact_lane(&tx, &filter, &query_vec, None, &mut check)?,
                "exact",
            ),
        };
        let ids: BTreeSet<_> = lexical
            .items
            .iter()
            .chain(&dense.items)
            .map(|item| item.id)
            .collect();
        let mut vector = tx.prepare_cached("SELECT payload FROM vectors WHERE chunk=?1")?;
        let mut lexical_score = tx.prepare_cached(
            "SELECT -bm25(chunks_fts) FROM chunks_fts WHERE chunks_fts MATCH ?1 AND rowid=?2",
        )?;
        let mut scores = Vec::with_capacity(ids.len());
        for id in ids {
            check()?;
            let raw: [u8; DOCUMENT_BYTES] = vector.query_row([id], |row| row.get(0))?;
            let bm25 = if expression.is_empty() {
                0.0
            } else {
                lexical_score
                    .query_row(params![expression, id], |row| row.get(0))
                    .optional()?
                    .unwrap_or(0.0)
            };
            scores.push(Score {
                id,
                bm25,
                semantic: similarity(&raw, &query_vec)?,
                fused: 0.0,
            });
        }
        fuse(&mut scores);
        let mut result = self.read_results(&tx, scores, filter.2.is_some(), &mut check)?;
        result.engine = engine;
        result.semantic_candidates = dense.items.iter().rev().map(|item| item.id).collect();
        Ok(result)
    }

    fn read_results(
        &self,
        db: &Connection,
        scores: Vec<Score>,
        branch: bool,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<HybridResult> {
        let mut lookup = db.prepare_cached(
            "SELECT c.id, s.path, s.session_id, s.cwd, e.id, e.parent, c.role, 0.0,
                    s.device, s.inode, e.byte_offset, e.byte_len, e.terminated,
                    e.line_digest, c.block, c.text_start, c.text_end, s.observed
             FROM chunks c JOIN sources s ON s.id=c.source
             JOIN entries e ON e.source=c.source AND e.id=c.entry WHERE c.id=?1",
        )?;
        let mut result = HybridResult {
            sessions: Vec::new(),
            stale_candidates: 0,
            engine: "exact",
            semantic_candidates: Vec::new(),
            coverage: Self::read_coverage(db)?,
        };
        let mut sessions = HashMap::new();
        for score in scores {
            check()?;
            let mut candidate = lookup.query_row([score.id], Candidate::from_row)?;
            let path = self.root.path.join(&candidate.hit.path);
            let existing: Option<usize> = sessions.get(&path).copied();
            if let Some(at) = existing {
                let hits = &result.sessions[at].hits;
                if hits.len() == PER_SESSION_HITS
                    || hits
                        .iter()
                        .any(|hit| hit.evidence.entry_id == candidate.hit.entry_id)
                {
                    continue;
                }
            } else if result.sessions.len() == MAX_SESSIONS {
                continue;
            }
            let Ok(text) = self.read_candidate(&candidate, branch) else {
                result.stale_candidates += 1;
                continue;
            };
            candidate.hit.text = text;
            candidate.hit.bm25 = score.bm25;
            let at = *sessions.entry(path.clone()).or_insert_with(|| {
                result.sessions.push(SessionHits {
                    session_path: path,
                    session_id: candidate.hit.session_id.clone(),
                    hits: Vec::new(),
                });
                result.sessions.len() - 1
            });
            result.sessions[at].hits.push(HybridHit {
                evidence: candidate.hit,
                semantic: score.semantic,
                score: score.fused,
            });
        }
        Ok(result)
    }
}

fn lexical_lane(
    db: &Connection,
    (project, source, ancestors): &Filter<'_>,
    expression: &str,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Lane> {
    let mut lane = Lane::default();
    if expression.is_empty() {
        return Ok(lane);
    }
    let mut select = db.prepare(&format!(
        "SELECT c.id,c.source,-bm25(chunks_fts) FROM chunks_fts
         JOIN chunks c ON c.id=chunks_fts.rowid JOIN sources s ON s.id=c.source
         WHERE {IN_SCOPE} AND chunks_fts MATCH ?4 ORDER BY bm25(chunks_fts),c.id",
    ))?;
    let mut rows = select.query(params![project, source, ancestors, expression])?;
    while lane.items.len() < LANE_LIMIT
        && let Some(row) = rows.next()?
    {
        check()?;
        lane.offer(LaneItem {
            id: row.get(0)?,
            source: row.get(1)?,
            score: row.get(2)?,
        });
    }
    Ok(lane)
}

fn exact_lane(
    db: &Connection,
    (project, source, ancestors): &Filter<'_>,
    query: &[f32; EMBEDDING_DIMENSION],
    covered: Option<&str>,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Lane> {
    let mut select = db.prepare(&format!(
        "WITH coverage(day, through) AS MATERIALIZED (
            SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?4)
         ) SELECT c.id,c.source,v.payload FROM vectors v
         JOIN chunks c ON c.id=v.chunk JOIN sources s ON s.id=c.source
         LEFT JOIN coverage ON coverage.day=v.day
         WHERE {IN_SCOPE} AND (coverage.through IS NULL OR v.chunk>coverage.through)",
    ))?;
    let mut rows = select.query(params![project, source, ancestors, covered])?;
    let mut lane = Lane::default();
    while let Some(row) = rows.next()? {
        check()?;
        lane.offer(LaneItem {
            id: row.get(0)?,
            source: row.get(1)?,
            score: similarity(&row.get(2)?, query)?,
        });
    }
    Ok(lane)
}

fn graph_lane(
    db: &Connection,
    cache: &std::path::Path,
    policy: GraphPolicy,
    query: &[f32; EMBEDDING_DIMENSION],
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Option<(Lane, String)>> {
    let Some(graph::GraphCandidates { ids, covered }) =
        graph::candidates(db, cache, policy, query, check)?
    else {
        return Ok(None);
    };
    let mut lookup = db.prepare_cached(
        "SELECT c.source,v.payload FROM vectors v JOIN chunks c ON c.id=v.chunk WHERE v.chunk=?1",
    )?;
    let mut lane = Lane::default();
    for id in ids {
        check()?;
        let Some((source, raw)) = lookup
            .query_row([id], |row| {
                Ok((row.get(0)?, row.get::<_, [u8; DOCUMENT_BYTES]>(1)?))
            })
            .optional()?
        else {
            // A deletion may have displaced a live neighbor in the immutable graph.
            return Ok(None);
        };
        lane.offer(LaneItem {
            id,
            source,
            score: similarity(&raw, query)?,
        });
    }
    Ok(Some((lane, serde_json::to_string(&covered)?)))
}

fn similarity(raw: &[u8; DOCUMENT_BYTES], query: &[f32; EMBEDDING_DIMENSION]) -> Result<f64> {
    let doc = Document::from_bytes(raw).ok_or("Invalid Bekko vector in Recall cache")?;
    Ok(doc.score(query))
}

#[derive(Default)]
struct Lane {
    items: BTreeSet<LaneItem>,
    per_source: HashMap<i64, BTreeSet<LaneItem>>,
}

#[derive(Clone, Copy)]
struct LaneItem {
    id: i64,
    source: i64,
    score: f64,
}

impl Ord for LaneItem {
    fn cmp(&self, other: &Self) -> Ordering {
        self.score
            .total_cmp(&other.score)
            .then_with(|| other.id.cmp(&self.id))
    }
}

impl PartialOrd for LaneItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for LaneItem {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for LaneItem {}

impl Lane {
    fn offer(&mut self, candidate: LaneItem) {
        if self.items.len() == LANE_LIMIT
            && self.items.first().is_some_and(|item| *item >= candidate)
        {
            return;
        }
        let source = self.per_source.entry(candidate.source).or_default();
        if source.len() == PER_SESSION_LANE {
            if source.first().is_some_and(|item| *item >= candidate) {
                return;
            }
            if let Some(old) = source.pop_first() {
                self.items.remove(&old);
            }
        }
        source.insert(candidate);
        self.items.insert(candidate);
        if self.items.len() > LANE_LIMIT
            && let Some(old) = self.items.pop_first()
            && let Some(set) = self.per_source.get_mut(&old.source)
        {
            set.remove(&old);
            if set.is_empty() {
                self.per_source.remove(&old.source);
            }
        }
    }
}

struct Score {
    id: i64,
    bm25: f64,
    semantic: f64,
    fused: f64,
}

fn fuse(scores: &mut [Score]) {
    let range = |get: fn(&Score) -> f64| {
        scores
            .iter()
            .map(get)
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), x| {
                (min.min(x), max.max(x))
            })
    };
    let bm25 = range(|x| x.bm25);
    let semantic = range(|x| x.semantic);
    let relative = |x: f64, (min, max)| {
        if min < max {
            (x - min) / (max - min)
        } else {
            0.0
        }
    };
    for row in scores.iter_mut() {
        row.fused = 0.25 * relative(row.bm25, bm25) + 0.75 * relative(row.semantic, semantic);
    }
    scores.sort_unstable_by(|a, b| {
        b.fused
            .total_cmp(&a.fused)
            .then_with(|| b.bm25.total_cmp(&a.bm25))
            .then_with(|| a.id.cmp(&b.id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_oracle_prefers_semantic_only_match_over_lexical_only_match() {
        let score = |id, bm25, semantic| Score {
            id,
            bm25,
            semantic,
            fused: 0.0,
        };
        let mut scores = [score(1, 9.0, -0.5), score(2, 0.0, 0.5), score(3, 9.0, 0.0)];
        fuse(&mut scores);
        assert_eq!(
            scores.map(|s| (s.id, s.fused)),
            [(2, 0.75), (3, 0.625), (1, 0.25)]
        );
        let mut scores = [score(2, 0.0, 0.0), score(1, 0.0, 0.0)];
        fuse(&mut scores);
        assert_eq!(scores.map(|s| (s.id, s.fused)), [(1, 0.0), (2, 0.0)]);
    }
}
