//! Request-level model selection and full-scope scoring, never a reranker.
// Both miss and hit consume the same FP16 representation, window by window.
mod bekko;
mod lateon;
mod native;
mod text_pool;
pub(crate) mod shared;
pub(crate) use bekko::EMBEDDING_DIMENSION as TEXT_EMBEDDING_DIMENSION;
pub(crate) use lateon::{
    MAX_WINDOW_TOKENS as MAX_CODE_WINDOW_TOKENS,
    TOKEN_EMBEDDING_DIMENSION as CODE_EMBEDDING_DIMENSION,
};

use crate::{Chunk, ModelChoice, Result, cache::Cache};
use half::f16;
use std::{ops::Range, sync::Arc};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelKind {
    Text,
    Code,
}
impl ModelKind {
    // Stable on-disk tags shared by record/scope headers, not enum ordinals.
    pub(crate) fn stored_tag(self) -> u8 {
        match self {
            Self::Text => 1,
            Self::Code => 2,
        }
    }
    pub(crate) fn from_stored_tag(tag: usize) -> Option<Self> {
        match tag {
            1 => Some(Self::Text),
            2 => Some(Self::Code),
            _ => None,
        }
    }
    pub fn for_scope(choice: ModelChoice, prose_only: bool) -> Self {
        if choice == ModelChoice::Text || (choice == ModelChoice::Auto && prose_only) {
            Self::Text
        } else {
            Self::Code
        }
    }
}

/// Borrowed output of ONE window. Consumers must write/score it before return;
/// they cannot retain a whole corpus (or unbounded long-document token matrix).
pub enum DocumentBlock<'a> {
    Text {
        values: &'a [f16; TEXT_EMBEDDING_DIMENSION],
        inverse_norm: f32,
    },
    Code {
        source: Range<usize>,
        input_tokens: usize,
        values: &'a [f16],
    },
}
pub type BlockSink<'a> = dyn FnMut(DocumentBlock<'_>) -> Result<()> + 'a;

/// Stop delivering representations, not encoding/scoring the remaining windows.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Blocks,
    ScoreOnly,
}
/// Windows arrive in document order, including every window of a long document.
pub type EncodeSink<'a> = dyn FnMut(usize, DocumentBlock<'_>) -> Result<Delivery> + 'a;
/// None seals a Text document after its successful score/work accounting.
/// Code retains its existing multiwindow sink and batch-finalization protocol.
pub type CompletionSink<'a> = dyn FnMut(usize, Option<DocumentBlock<'_>>) -> Result<Delivery> + 'a;
/// LateOn source-batch and native-sequence/window bound, not a Text routing limit.
pub(crate) const MAX_BATCH_WINDOWS: usize = 4;
/// Text documents per bounded source batch; the caller is one of at most four lanes.
pub(crate) const MAX_TEXT_BATCH_DOCUMENTS: usize = 4;

/// Observations at successful encode/score consumption points, not requested
/// scope sizes. For Bekko a scored row is its one aggregated document vector;
/// for LateOn it is a selected 48D token row (including every internal window).
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Work {
    pub model: Option<ModelKind>,
    pub query_encoder_calls: usize,
    pub query_encoded_tokens: usize,
    pub query_scored_rows: usize,
    pub semantic_scored_chunks: usize,
    pub actual_encoded_chunks: usize,
    pub actual_encoded_windows: usize,
    pub actual_encoded_batches: usize,
    pub actual_encoded_tokens: usize,
    pub scored_document_tokens: usize,
    pub discarded_cached_chunks: usize,
    pub discarded_cached_document_tokens: usize,
    /// Subsets of accepted work computed by the earlier scan of this same request.
    pub reused_scored_chunks: usize,
    pub reused_scored_document_tokens: usize,
}

#[derive(Debug)]
pub(crate) struct QueryTooLong;
impl std::fmt::Display for QueryTooLong {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "INVALID_INPUT: query exceeds LateOn's 256-token limit (including role/special tokens)",
        )
    }
}
impl std::error::Error for QueryTooLong {}

pub(crate) use native::computing_threads;

/// Immutable, encoder-free capability for one request's cached code scan.
/// All windows of a record remain ordered within the task that owns its maxima.
pub(crate) struct CodeScan<'a> {
    query: &'a [f32],
    kernel: native::ScoringKernel,
    cancellation: Option<Arc<crate::request::Context>>,
}
impl CodeScan<'_> {
    pub(crate) fn score_blocks(
        &self,
        visit: impl FnOnce(&mut BlockSink<'_>) -> Result<()>,
        work: &mut Work,
    ) -> Result<f64> {
        let mut maxima = vec![f32::NEG_INFINITY; self.query.len() / CODE_EMBEDDING_DIMENSION];
        visit(&mut |block| {
            if let Some(context) = &self.cancellation {
                context.control.check()?;
            }
            let DocumentBlock::Code { values, .. } = block else {
                return Err("index model representation mismatch".into());
            };
            self.kernel.update(self.query, values, &mut maxima)?;
            work.scored_document_tokens += values.len() / CODE_EMBEDDING_DIMENSION;
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
        encoder: Arc<bekko::Encoder>,
        pool: text_pool::Pool,
        query: [f32; TEXT_EMBEDDING_DIMENSION],
        work: Work,
    },
    LateOn {
        encoder: shared::CodeEncoder,
        query: Arc<Vec<f32>>,
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
        if ModelKind::for_scope(choice, prose_only) == ModelKind::Text {
            crate::request::check()?;
            let encoder = match crate::request::current() {
                Some(context) => context.models.text(assets)?,
                None => Arc::new(bekko::Encoder::open(&assets.model_directory("bekko128")?)?),
            };
            let (query, tokens) = encoder.encode(query)?;
            Ok(Self::Bekko {
                encoder,
                pool: text_pool::Pool::default(),
                query,
                work: Work {
                    model: Some(ModelKind::Text),
                    query_encoder_calls: 1,
                    query_encoded_tokens: tokens,
                    query_scored_rows: 1,
                    ..Work::default()
                },
            })
        } else {
            let (encoder, query, tokens) = match crate::request::current() {
                Some(context) => {
                    let (encoder, query, tokens) = context.models.code(assets, query)?;
                    (shared::CodeEncoder::Shared(encoder), query, tokens)
                }
                None => {
                    let mut encoder = lateon::Encoder::open(
                        &assets.model_directory("lateon-edge")?,
                        &assets.native_library(),
                    )?;
                    let (query, tokens) = encoder.query(query)?;
                    (shared::CodeEncoder::Local(encoder), query, tokens)
                }
            };
            let rows = query.len() / CODE_EMBEDDING_DIMENSION;
            Ok(Self::LateOn {
                encoder,
                query: Arc::new(query),
                work: Work {
                    model: Some(ModelKind::Code),
                    query_encoder_calls: 1,
                    query_encoded_tokens: tokens,
                    query_scored_rows: rows,
                    ..Work::default()
                },
            })
        }
    }
    pub fn kind(&self) -> ModelKind {
        match self {
            Self::Bekko { .. } => ModelKind::Text,
            Self::LateOn { .. } => ModelKind::Code,
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
                cancellation: crate::request::current(),
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
    pub(crate) fn accept_reused_score(&mut self, rows: usize) -> Result<()> {
        let work = match self {
            Self::Bekko { work, .. } | Self::LateOn { work, .. } => work,
        };
        if work.discarded_cached_chunks == 0 || work.discarded_cached_document_tokens < rows {
            return Err("invalid request-local score reuse accounting".into());
        }
        work.discarded_cached_chunks -= 1;
        work.discarded_cached_document_tokens -= rows;
        work.semantic_scored_chunks += 1;
        work.scored_document_tokens += rows;
        work.reused_scored_chunks += 1;
        work.reused_scored_document_tokens += rows;
        Ok(())
    }
    pub fn score_documents(&mut self, documents: Vec<Arc<Chunk>>) -> Result<Vec<f64>> {
        self.score_documents_with_completion(documents, None)
    }
    /// The index writer observes the SAME rounded output that determines score.
    /// A caller handling recoverable cache I/O must drop that writer and return
    /// ScoreOnly from its sink, so search continues without replaying any encode.
    pub fn score_documents_with_completion(
        &mut self,
        documents: Vec<Arc<Chunk>>,
        mut sink: Option<&mut CompletionSink<'_>>,
    ) -> Result<Vec<f64>> {
        crate::request::check()?;
        let max_documents = if self.kind() == ModelKind::Text {
            MAX_TEXT_BATCH_DOCUMENTS
        } else {
            MAX_BATCH_WINDOWS
        };
        if documents.is_empty() || documents.len() > max_documents {
            return Err("invalid document batch size".into());
        }
        match self {
            Self::Bekko {
                encoder,
                pool,
                query,
                work,
            } => {
                // Singleton routes encode directly; only real batches precompute ordered Results.
                let mut encoded = if documents.len() > 1 {
                    Some(pool.encode(encoder, &documents)?.into_iter())
                } else {
                    None
                };
                let mut scores = Vec::with_capacity(documents.len());
                for (index, source) in documents.iter().enumerate() {
                    crate::request::check()?;
                    let (vector, tokens) = match &mut encoded {
                        Some(results) => results.next().expect("one result per Text document")?,
                        None => encoder.encode(&format!("{}\n{}", source.path, source.content))?,
                    };
                    work.actual_encoded_windows += 1;
                    work.actual_encoded_batches += 1;
                    work.actual_encoded_tokens += tokens;
                    let document = bekko::Document::from_normalized(&vector);
                    let (values, inverse_norm) = document.stored();
                    if let Some(deliver) = sink.as_mut()
                        && deliver(
                            index,
                            Some(DocumentBlock::Text {
                                values,
                                inverse_norm,
                            }),
                        )? == Delivery::ScoreOnly
                    {
                        sink = None;
                    }
                    work.actual_encoded_chunks += 1;
                    work.semantic_scored_chunks += 1;
                    work.scored_document_tokens += 1;
                    scores.push(document.score(query));
                    if let Some(deliver) = sink.as_mut()
                        && deliver(index, None)? == Delivery::ScoreOnly
                    {
                        sink = None;
                    }
                }
                Ok(scores)
            }
            Self::LateOn {
                encoder,
                query,
                work,
            } => {
                let delivering = sink.is_some();
                let mut deliver = |index, block: DocumentBlock<'_>| {
                    sink.as_mut().ok_or("missing encode sink")?(index, Some(block))
                };
                let (scores, encoded) = encoder.score_documents_to(
                    query,
                    documents,
                    if delivering { Some(&mut deliver) } else { None },
                )?;
                work.actual_encoded_windows += encoded.actual_encoded_windows;
                work.actual_encoded_batches += encoded.actual_encoded_batches;
                work.actual_encoded_tokens += encoded.actual_encoded_tokens;
                work.scored_document_tokens += encoded.scored_document_tokens;
                work.actual_encoded_chunks += scores.len();
                work.semantic_scored_chunks += scores.len();
                Ok(scores)
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
                    crate::request::check()?;
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
            } => {
                let mut observed = Work::default();
                let result = CodeScan {
                    query,
                    kernel: encoder.scoring_kernel()?,
                    cancellation: crate::request::current(),
                }
                .score_blocks(visit, &mut observed)
                .map_err(|error| encoder.scoring_error(error));
                if result.is_ok() {
                    work.semantic_scored_chunks += observed.semantic_scored_chunks;
                    work.scored_document_tokens += observed.scored_document_tokens;
                } else {
                    work.discarded_cached_chunks += observed.semantic_scored_chunks;
                    work.discarded_cached_document_tokens += observed.scored_document_tokens;
                }
                result
            }
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
