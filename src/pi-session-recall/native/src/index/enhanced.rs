//! Exact three-lane candidates, original anchors, and post-score publication.
use super::{
    CANDIDATE_BY_ID, IN_SCOPE, Index, LANE_LIMIT, Lane, LaneItem, Scope, resolve_scope, similarity,
    terms,
};
use crate::{
    Result,
    index::{search::Candidate, sync::stamp},
};
use metis_potion as potion;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::MetadataExt,
    time::Instant,
};

const POTION_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS potion_v1 (
    chunk INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    payload BLOB NOT NULL CHECK (length(payload)=516)
) STRICT";
const WEIGHTS: [f64; 3] = [0.25, 0.60, 0.15];

#[derive(Serialize)]
pub struct EnhancedCenter {
    id: i64,
    source: String,
    entry: String,
    block: usize,
    start: usize,
    end: usize,
    text: String,
    passage: String,
}

impl EnhancedCenter {
    fn new(index: &Index, candidate: &Candidate) -> Result<Self> {
        let hit = &candidate.hit;
        let anchor = &candidate.anchor;
        let path = index.root.path.join(&hit.path);
        let source = path
            .to_str()
            .ok_or("Recall evidence path is not UTF-8")?
            .to_owned();
        let text = index.read_candidate(candidate, true)?;
        let (start, end, block) = (anchor.text_bytes.start, anchor.text_bytes.end, anchor.block);
        let mut passage = format!(
            "[{} | {} | {} | block {block} | {start}:{end}]\n{text}\n\n",
            source, hit.session_id, hit.entry_id
        );
        // Such passages would be transformed by terminal sanitization after token accounting.
        if passage.chars().any(|c| {
            matches!(c, '\0'..='\x08' | '\x0b'..='\x1f' | '\u{7f}'..='\u{9f}'
            | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        }) {
            passage.clear();
        }
        Ok(Self {
            id: hit.chunk_id,
            source,
            entry: hit.entry_id.clone(),
            block,
            start,
            end,
            text,
            passage,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnhancedSelection {
    ids: Vec<i64>,
    tokens: usize,
    cap: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancedResult {
    evidence: String,
    match_count: usize,
    output_tokens: usize,
    output_cap: usize,
}

impl Index {
    /// Caller holds the refresh lease and has applied the normal cache growth limit.
    /// Commit each small batch so a later explicit request can resume preparation.
    pub fn prepare_potion(
        &mut self,
        scope: Scope<'_>,
        model: &potion::Encoder,
        deadline: Instant,
    ) -> Result<bool> {
        self.db.execute_batch(POTION_SCHEMA)?;
        let filter = resolve_scope(&self.db, scope, &mut || Ok(()))?;
        let (project, source, ancestors) = filter;
        let sql = format!("SELECT c.id FROM chunks c JOIN sources s ON s.id=c.source
            LEFT JOIN potion_v1 p ON p.chunk=c.id WHERE {IN_SCOPE} AND p.chunk IS NULL ORDER BY c.id LIMIT 64");
        while Instant::now() < deadline {
            let batch = {
                let mut pending = self.db.prepare_cached(&sql)?;
                let rows = pending.query_map(params![project, source, ancestors], |row| {
                    row.get::<_, i64>(0)
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            if batch.is_empty() {
                return Ok(true);
            }
            let tx = self.db.unchecked_transaction()?;
            {
                let mut load = tx.prepare_cached(CANDIDATE_BY_ID)?;
                let mut save =
                    tx.prepare_cached("INSERT INTO potion_v1(chunk,payload) VALUES (?1,?2)")?;
                for id in batch {
                    let candidate = load.query_row([id], Candidate::from_row)?;
                    let payload =
                        potion::document(&model.encode(&self.read_candidate(&candidate, true)?)?);
                    save.execute(params![id, &payload[..]])?;
                }
            }
            tx.commit()?;
        }
        Ok(false)
    }

    pub fn enhanced(
        &self,
        query: &str,
        scope: Scope<'_>,
        potion_model: &potion::Encoder,
        rank: impl FnOnce(&[&EnhancedCenter], &[&EnhancedCenter]) -> Result<EnhancedSelection>,
    ) -> Result<EnhancedResult> {
        if query.trim().is_empty() || query.len() > 8192 {
            return Err("Recall enhanced query must be nonblank and at most 8192 bytes".into());
        }
        let bekko = self
            .encoder
            .as_ref()
            .ok_or("Recall requires Bekko")?
            .encode(query)?
            .0;
        let potion = potion_model.encode(query)?;
        let expression = terms::query(query);
        let (reference, wide, centers) = {
            let tx = self.db.unchecked_transaction()?;
            let filter = resolve_scope(&tx, scope, &mut || Ok(()))?;
            let lane_params = params![filter.0, filter.1, filter.2];
            let mut bk = tx.prepare(&format!(
                "SELECT c.id,c.source,v.payload,p.payload FROM vectors v
                JOIN chunks c ON c.id=v.chunk JOIN sources s ON s.id=c.source
                LEFT JOIN potion_v1 p ON p.chunk=c.id WHERE {IN_SCOPE}"
            ))?;
            let mut lex = tx.prepare(&format!(
                "SELECT c.id,c.source,-bm25(chunks_fts) FROM chunks_fts
                JOIN chunks c ON c.id=chunks_fts.rowid JOIN sources s ON s.id=c.source
                WHERE {IN_SCOPE} AND chunks_fts MATCH ?4 ORDER BY bm25(chunks_fts),c.id"
            ))?;
            let mut lanes = [PairedLane::new(), PairedLane::new(), PairedLane::new()];
            if !expression.is_empty() {
                let mut rows = lex.query(params![filter.0, filter.1, filter.2, expression])?;
                while lanes[0].narrow.items.len() < LANE_LIMIT
                    && let Some(row) = rows.next()?
                {
                    lanes[0].offer(LaneItem {
                        id: row.get(0)?,
                        source: row.get(1)?,
                        score: row.get(2)?,
                    });
                }
            }
            let mut rows = bk.query(lane_params)?;
            while let Some(row) = rows.next()? {
                let id = row.get(0)?;
                let source = row.get(1)?;
                let payload = row
                    .get::<_, Option<[u8; potion::DOCUMENT_BYTES]>>(3)?
                    .ok_or("Potion index not ready for this scope")?;
                lanes[1].offer(LaneItem {
                    id,
                    source,
                    score: similarity(&row.get(2)?, &bekko)?,
                });
                lanes[2].offer(LaneItem {
                    id,
                    source,
                    score: potion::similarity(&payload, &potion)?,
                });
            }
            let views = lanes.map(PairedLane::finish);
            let narrow_lanes = views.each_ref().map(|(old, _)| old);
            let wide_lanes = views.each_ref().map(|(_, wide)| wide);
            let mut components = BTreeMap::new();
            let mut vector = tx.prepare_cached("SELECT v.payload,p.payload FROM vectors v JOIN potion_v1 p ON p.chunk=v.chunk WHERE v.chunk=?1")?;
            let mut bm25 = tx.prepare_cached(
                "SELECT -bm25(chunks_fts) FROM chunks_fts WHERE chunks_fts MATCH ?1 AND rowid=?2",
            )?;
            let ids = wide_lanes
                .iter()
                .flat_map(|lane| lane.iter().copied())
                .collect::<BTreeSet<_>>();
            for id in ids {
                let (b, p) = vector.query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                let lexical = if expression.is_empty() {
                    0.0
                } else {
                    bm25.query_row(params![expression, id], |row| row.get(0))
                        .optional()?
                        .unwrap_or(0.0)
                };
                components.insert(
                    id,
                    [
                        lexical,
                        similarity(&b, &bekko)?,
                        potion::similarity(&p, &potion)?,
                    ],
                );
            }
            let reference = shortlist(narrow_lanes, &components, 16);
            let wide = shortlist(wide_lanes, &components, 64);
            let mut centers = BTreeMap::new();
            let mut lookup = tx.prepare_cached(CANDIDATE_BY_ID)?;
            for id in reference
                .iter()
                .chain(&wide)
                .copied()
                .collect::<BTreeSet<_>>()
            {
                let candidate = lookup.query_row([id], Candidate::from_row)?;
                let center = EnhancedCenter::new(self, &candidate)?;
                centers.insert(id, (candidate, center));
            }
            (reference, wide, centers)
        };
        if centers.is_empty() {
            return Ok(EnhancedResult {
                evidence: String::new(),
                match_count: 0,
                output_tokens: 0,
                output_cap: 0,
            });
        }
        let collect = |ids: &[i64]| ids.iter().map(|id| &centers[id].1).collect::<Vec<_>>();
        let selected = rank(&collect(&reference), &collect(&wide))?;
        if selected.cap > 2048 || selected.tokens > selected.cap || selected.ids.len() > 10 {
            return Err("Invalid Recall reranker output budget".into());
        }
        let root = self.root.dir.metadata()?;
        let current = std::fs::symlink_metadata(&self.root.path)?;
        if !current.is_dir() || (root.dev(), root.ino()) != (current.dev(), current.ino()) {
            return Err("Recall root changed while ranking".into());
        }
        let mut evidence = String::new();
        let mut sources = BTreeSet::new();
        let mut selected_ids = BTreeSet::new();
        for id in selected.ids {
            let (candidate, center) = centers.get(&id).ok_or("Unknown Recall center selected")?;
            if !selected_ids.insert(id)
                || center.passage.is_empty()
                || self.read_candidate(candidate, true)? != center.text
                || stamp(&self.root.file(&candidate.hit.path)?.metadata()?) != candidate.stamp
            {
                return Err("Recall evidence changed while ranking".into());
            }
            evidence.push_str(&center.passage);
            sources.insert(&center.source);
        }
        Ok(EnhancedResult {
            evidence,
            match_count: sources.len(),
            output_tokens: selected.tokens,
            output_cap: selected.cap,
        })
    }
}

struct PairedLane {
    narrow: Lane,
    overflow: Option<Lane>,
}

impl PairedLane {
    fn new() -> Self {
        Self {
            narrow: Lane::default(),
            overflow: Some(Lane::new(16)),
        }
    }

    fn offer(&mut self, item: LaneItem) {
        self.narrow.offer(item);
        if self.narrow.items.len() == LANE_LIMIT {
            self.overflow = None;
        } else if let Some(extra) = &mut self.overflow {
            extra.offer(item);
        }
    }

    fn finish(self) -> (Vec<i64>, Vec<i64>) {
        let mut wide = self.narrow.items.clone();
        if let Some(extra) = self.overflow {
            for item in extra.items.into_iter().rev() {
                if wide.len() == LANE_LIMIT {
                    break;
                }
                wide.insert(item);
            }
        }
        let ids = |set: BTreeSet<LaneItem>| set.into_iter().rev().map(|x| x.id).collect();
        (ids(self.narrow.items), ids(wide))
    }
}

fn shortlist(
    lanes: [&Vec<i64>; 3],
    components: &BTreeMap<i64, [f64; 3]>,
    limit: usize,
) -> Vec<i64> {
    let all = lanes
        .iter()
        .flat_map(|lane| lane.iter().copied())
        .collect::<BTreeSet<_>>();
    let ranges: [(f64, f64); 3] = std::array::from_fn(|lane| {
        all.iter()
            .map(|id| components[id][lane])
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), score| {
                (lo.min(score), hi.max(score))
            })
    });
    let mut order = all
        .into_iter()
        .map(|id| {
            let scores = components[&id];
            let fused = (0..3)
                .map(|i| {
                    let (lo, hi) = ranges[i];
                    if lo < hi {
                        WEIGHTS[i] * ((scores[i] - lo) / (hi - lo))
                    } else {
                        0.0
                    }
                })
                .sum::<f64>();
            (id, scores[0], fused)
        })
        .collect::<Vec<_>>();
    order.sort_unstable_by(|a, b| {
        b.2.total_cmp(&a.2)
            .then_with(|| b.1.total_cmp(&a.1))
            .then_with(|| a.0.cmp(&b.0))
    });
    let mut selected = BTreeSet::new();
    for (i, lane) in lanes.iter().enumerate() {
        selected.extend(
            lane.iter()
                .filter(|id| {
                    lanes
                        .iter()
                        .enumerate()
                        .all(|(j, other)| i == j || !other.contains(id))
                })
                .take(2)
                .copied(),
        );
    }
    for &(id, ..) in &order {
        if selected.len() == limit {
            break;
        }
        selected.insert(id);
    }
    order
        .into_iter()
        .filter_map(|(id, ..)| selected.contains(&id).then_some(id))
        .collect()
}
