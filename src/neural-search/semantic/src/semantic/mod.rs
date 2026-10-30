//! Request-level model selection and full-scope scoring, never a reranker.
// Both miss and hit consume the same FP16 representation, window by window.
mod bekko;
mod lateon;
mod native;

use crate::{ModelChoice, Result, cache::Cache};
use half::f16;
use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Text,
    Code,
}
impl Kind {
    pub fn for_scope(choice: ModelChoice, prose_only: bool) -> Self {
        if choice == ModelChoice::Text || (choice == ModelChoice::Auto && prose_only) {
            Self::Text
        } else {
            Self::Code
        }
    }
}

/// Borrowed output of ONE encode. Consumers must write/score it before return;
/// they cannot retain a whole corpus (or unbounded long-document token matrix).
pub enum DocumentBlock<'a> {
    Text {
        values: &'a [f16; 128],
        inverse_norm: f32,
    },
    Code {
        source: Range<usize>,
        input_tokens: usize,
        values: &'a [f16],
    },
}
pub type BlockSink<'a> = dyn FnMut(DocumentBlock<'_>) -> Result<()> + 'a;

/// Observations at successful encode/score consumption points, not requested
/// scope sizes. For Bekko a scored row is its one aggregated document vector;
/// for LateOn it is a selected 48D token row (including every internal window).
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Work {
    pub model: Option<Kind>,
    pub query_encoder_calls: usize,
    pub query_encoded_tokens: usize,
    pub query_scored_rows: usize,
    pub semantic_scored_chunks: usize,
    pub actual_encoded_chunks: usize,
    pub actual_encoded_windows: usize,
    pub actual_encoded_tokens: usize,
    pub scored_document_tokens: usize,
    pub discarded_cached_chunks: usize,
    pub discarded_cached_document_tokens: usize,
}

pub(crate) use native::computing_threads;

/// Immutable, encoder-free capability for one request's cached code scan.
/// All windows of a record remain ordered within the task that owns its maxima.
pub(crate) struct CodeScan<'a> {
    query: &'a [f32],
    kernel: native::ScoringKernel<'a>,
}
impl CodeScan<'_> {
    pub(crate) fn score_blocks(
        &self,
        visit: impl FnOnce(&mut BlockSink<'_>) -> Result<()>,
        work: &mut Work,
    ) -> Result<f64> {
        let mut maxima = vec![f32::NEG_INFINITY; self.query.len() / 48];
        visit(&mut |block| {
            let DocumentBlock::Code { values, .. } = block else {
                return Err("index model representation mismatch".into());
            };
            self.kernel.update(self.query, values, &mut maxima)?;
            work.scored_document_tokens += values.len() / 48;
            Ok(())
        })?;
        let score = maxima.into_iter().sum::<f32>();
        if !score.is_finite() {
            return Err("non-finite cached MaxSim".into());
        }
        work.semantic_scored_chunks += 1;
        Ok(score as f64)
    }
}

pub enum Scorer {
    Bekko {
        encoder: bekko::Encoder,
        query: [f32; bekko::DIM],
        work: Work,
    },
    LateOn {
        encoder: lateon::Encoder,
        query: Vec<f32>,
        work: Work,
    },
}
impl Scorer {
    pub fn open(
        choice: ModelChoice,
        prose_only: bool,
        query: &str,
        assets: &Cache,
    ) -> Result<Self> {
        if Kind::for_scope(choice, prose_only) == Kind::Text {
            let encoder = bekko::Encoder::open(&assets.model_directory("bekko128")?)?;
            let (query, tokens) = encoder.encode(query)?;
            Ok(Self::Bekko {
                encoder,
                query,
                work: Work {
                    model: Some(Kind::Text),
                    query_encoder_calls: 1,
                    query_encoded_tokens: tokens,
                    query_scored_rows: 1,
                    ..Work::default()
                },
            })
        } else {
            let mut encoder = lateon::Encoder::open(
                &assets.model_directory("lateon-edge")?,
                &assets.native_library(),
            )?;
            let (query, tokens) = encoder.query(query)?;
            let rows = query.len() / 48;
            Ok(Self::LateOn {
                encoder,
                query,
                work: Work {
                    model: Some(Kind::Code),
                    query_encoder_calls: 1,
                    query_encoded_tokens: tokens,
                    query_scored_rows: rows,
                    ..Work::default()
                },
            })
        }
    }
    pub fn kind(&self) -> Kind {
        match self {
            Self::Bekko { .. } => Kind::Text,
            Self::LateOn { .. } => Kind::Code,
        }
    }
    pub fn work(&self) -> Work {
        match self {
            Self::Bekko { work, .. } | Self::LateOn { work, .. } => *work,
        }
    }
    pub(crate) fn code_scan(&self) -> Result<Option<CodeScan<'_>>> {
        match self {
            Self::LateOn { encoder, query, .. } => Ok(Some(CodeScan {
                query,
                kernel: encoder.scoring_kernel()?,
            })),
            Self::Bekko { .. } => Ok(None),
        }
    }
    pub(crate) fn merge_cached_work(&mut self, other: Work) {
        let work = match self {
            Self::LateOn { work, .. } | Self::Bekko { work, .. } => work,
        };
        work.semantic_scored_chunks += other.semantic_scored_chunks;
        work.scored_document_tokens += other.scored_document_tokens;
    }
    pub(crate) fn cached_error(
        &self,
        error: Box<dyn std::error::Error + Send + Sync>,
    ) -> Box<dyn std::error::Error + Send + Sync> {
        match self {
            Self::LateOn { encoder, .. } => encoder.scoring_error(error),
            Self::Bekko { .. } => error,
        }
    }
    /// A corrupt cached attempt contributes real discarded work, but must not
    /// inflate the successful complete-scope counters during uncached recovery.
    pub fn discard_cached_scores(&mut self) {
        let work = match self {
            Self::Bekko { work, .. } | Self::LateOn { work, .. } => work,
        };
        work.discarded_cached_chunks += work.semantic_scored_chunks;
        work.discarded_cached_document_tokens += work.scored_document_tokens;
        work.semantic_scored_chunks = 0;
        work.scored_document_tokens = 0;
    }
    pub fn score_document(&mut self, path: &str, content: &str) -> Result<f64> {
        self.score_document_to(path, content, &mut |_| Ok(()))
    }
    /// The index writer observes the SAME rounded output that determines score.
    /// A caller handling recoverable cache I/O must drop that writer and return
    /// Ok from its sink, so search continues without replaying any encode.
    pub fn score_document_to(
        &mut self,
        path: &str,
        content: &str,
        sink: &mut BlockSink<'_>,
    ) -> Result<f64> {
        match self {
            Self::Bekko {
                encoder,
                query,
                work,
            } => {
                let (vector, tokens) = encoder.encode(&format!("{path}\n{content}"))?;
                work.actual_encoded_windows += 1;
                work.actual_encoded_tokens += tokens;
                let document = bekko::Document::from_normalized(&vector);
                let (values, inverse_norm) = document.stored();
                sink(DocumentBlock::Text {
                    values,
                    inverse_norm,
                })?;
                work.actual_encoded_chunks += 1;
                work.semantic_scored_chunks += 1;
                work.scored_document_tokens += 1;
                Ok(document.score(query))
            }
            Self::LateOn {
                encoder,
                query,
                work,
            } => {
                let score = encoder.score_to(query, path, content, &mut |block| {
                    if let DocumentBlock::Code {
                        input_tokens,
                        values,
                        ..
                    } = &block
                    {
                        work.actual_encoded_windows += 1;
                        work.actual_encoded_tokens += input_tokens;
                        work.scored_document_tokens += values.len() / 48;
                    }
                    sink(block)
                })?;
                work.actual_encoded_chunks += 1;
                work.semantic_scored_chunks += 1;
                Ok(score)
            }
        }
    }
    /// Full cached-scope scan. Text owns one fixed 1024-row scratch block;
    /// code still consumes all windows of each document before proceeding.
    /// The visitor owns index I/O, never batching or model arithmetic.
    pub fn score_scope(
        &mut self,
        count: usize,
        mut visit: impl FnMut(usize, &mut BlockSink<'_>) -> Result<()>,
    ) -> Result<Vec<f64>> {
        match self {
            Self::Bekko { query, work, .. } => {
                let mut scan = bekko::TextScan::new(query, count);
                for i in 0..count {
                    scan.push(text_document(|sink| visit(i, sink))?)?;
                    work.semantic_scored_chunks += 1;
                    work.scored_document_tokens += 1;
                }
                scan.finish()
            }
            Self::LateOn { .. } => (0..count)
                .map(|i| self.score_blocks(|sink| visit(i, sink)))
                .collect(),
        }
    }

    /// Visit checked stored blocks one window at a time. No document encoder is
    /// called on this path; text never renormalizes its already-rounded vector.
    pub fn score_blocks(
        &mut self,
        visit: impl FnOnce(&mut BlockSink<'_>) -> Result<()>,
    ) -> Result<f64> {
        match self {
            Self::Bekko { query, work, .. } => {
                let score = text_document(visit)?.score(query);
                if !score.is_finite() {
                    return Err("non-finite cached text score".into());
                }
                work.semantic_scored_chunks += 1;
                work.scored_document_tokens += 1;
                Ok(score)
            }
            Self::LateOn {
                encoder,
                query,
                work,
            } => CodeScan {
                query,
                kernel: encoder.scoring_kernel()?,
            }
            .score_blocks(visit, work)
            .map_err(|error| encoder.scoring_error(error)),
        }
    }
}

fn text_document(visit: impl FnOnce(&mut BlockSink<'_>) -> Result<()>) -> Result<bekko::Document> {
    let mut document = None;
    visit(&mut |block| {
        let DocumentBlock::Text {
            values,
            inverse_norm,
        } = block
        else {
            return Err("index model representation mismatch".into());
        };
        if document.is_some() {
            return Err("duplicate text vector".into());
        }
        document = Some(bekko::Document::from_stored(values, inverse_norm));
        Ok(())
    })?;
    document.ok_or_else(|| "missing text vector".into())
}
