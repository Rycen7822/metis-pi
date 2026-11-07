use super::native::Runtime;
use crate::{Chunk, Result};
use half::f16;
use serde::Deserialize;
use std::{
    collections::HashSet,
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
    sync::Arc,
};
mod tokenization;
use tokenization::{PreparedWindow, Tokenizers};

// LateOn-Code-edge exports 48-dimensional vectors for selected token rows.
pub(crate) const TOKEN_EMBEDDING_DIMENSION: usize = 48;
// Limits include the model's role/special tokens, not just source tokens.
pub(crate) const MAX_QUERY_TOKENS: usize = 256;
pub(crate) const MAX_WINDOW_TOKENS: usize = 2048;

#[derive(Deserialize)]
struct Manifest {
    format_version: u32,
    #[serde(default)]
    arithmetic_revision: String,
    embedding_file: String,
    graph_format: String,
    #[serde(default)]
    sequence_layout: String,
    backbone_dtype: String,
    embedding_dtype: String,
    query_length: usize,
    document_length: usize,
    query_prefix: String,
    document_prefix: String,
    do_query_expansion: bool,
    do_lower_case: bool,
    skiplist: HashSet<u32>,
}
struct Window {
    document: usize,
    source: std::ops::Range<usize>,
    ids: Vec<u32>,
    mask: Vec<u8>,
}

pub struct Encoder {
    runtime: Option<Runtime>,
    library: PathBuf,
    manifest_path: PathBuf,
    tokenizers: Tokenizers,
}
impl Encoder {
    pub fn open(model: &Path, library: &Path) -> Result<Self> {
        let manifest_path = model.join("manifest.json");
        let config: Manifest =
            serde_json::from_reader(BufReader::new(File::open(&manifest_path)?))?;
        if config.format_version != 4
            || config.sequence_layout != "segmented-v1"
            || config.arithmetic_revision != "ort-1.31-erf-v1"
            || config.graph_format != "ort"
            || config.backbone_dtype != "float32"
            || config.embedding_dtype != "float16"
            || config.embedding_file != "embedding_preln_f16.pack"
            || config.query_length != MAX_QUERY_TOKENS
            || config.document_length != MAX_WINDOW_TOKENS
            || config.do_query_expansion
        {
            return Err(
                "ARTIFACT_MISMATCH: unsupported LateOn tokenizer/precision contract".into(),
            );
        }
        let tokenizers = Tokenizers::open(model, config)?;
        Ok(Self {
            runtime: None,
            library: library.to_path_buf(),
            manifest_path,
            tokenizers,
        })
    }
    fn runtime(&mut self) -> Result<&mut Runtime> {
        if self.runtime.is_none() {
            self.runtime = Some(Runtime::open(&self.library, &self.manifest_path)?);
        }
        Ok(self.runtime.as_mut().expect("runtime was initialized"))
    }

    pub fn query(&mut self, text: &str) -> Result<(Vec<f32>, usize)> {
        let (ids, mask) = self.tokenizers.query(text)?;
        if ids.len() > MAX_QUERY_TOKENS {
            return Err(super::QueryTooLong.into());
        }
        let values = self.runtime()?.encode(&ids, &mask, true)?;
        Ok((values, ids.len()))
    }
    pub(super) fn scoring_kernel(&self) -> Result<super::native::ScoringKernel> {
        Ok(self
            .runtime
            .as_ref()
            .ok_or("query runtime not initialized")?
            .scoring_kernel())
    }
    pub(super) fn scoring_error(
        &self,
        error: Box<dyn std::error::Error + Send + Sync>,
    ) -> Box<dyn std::error::Error + Send + Sync> {
        match &self.runtime {
            Some(runtime) => runtime.scoring_error(error),
            None => error,
        }
    }
    pub fn score_documents_to(
        &mut self,
        query: &[f32],
        documents: &[Arc<Chunk>],
        mut sink: Option<&mut super::EncodeSink<'_>>,
    ) -> Result<(Vec<f64>, super::Work)> {
        let mut maxima =
            vec![vec![f32::NEG_INFINITY; query.len() / TOKEN_EMBEDDING_DIMENSION]; documents.len()];
        let mut work = super::Work::default();
        let mut pending = Vec::with_capacity(super::MAX_BATCH_WINDOWS);
        let mut tokens = 0;
        let mut prepared = self.tokenizers.first_windows(documents)?.into_iter();
        for (document, chunk) in documents.iter().enumerate() {
            let mut first = prepared.next();
            let mut start = 0;
            loop {
                crate::request::check()?;
                let PreparedWindow { end, ids, mask } = match first.take() {
                    Some(result) => result?,
                    None => self.tokenizers.window(document, chunk.clone(), start)?,
                };
                if !pending.is_empty()
                    && (pending.len() == super::MAX_BATCH_WINDOWS
                        || tokens + ids.len() > MAX_WINDOW_TOKENS)
                {
                    self.score_windows(query, &mut pending, &mut maxima, &mut work, &mut sink)?;
                    tokens = 0;
                }
                tokens += ids.len();
                pending.push(Window {
                    document,
                    source: start..end,
                    ids,
                    mask,
                });
                if end == chunk.content.len() {
                    break;
                }
                start = end;
            }
        }
        self.score_windows(query, &mut pending, &mut maxima, &mut work, &mut sink)?;
        let scores: Vec<f64> = maxima
            .into_iter()
            .map(|values| values.into_iter().sum::<f32>() as f64)
            .collect();
        if scores.iter().any(|score| !score.is_finite()) {
            return Err("UNVERIFIED_BACKEND: non-finite MaxSim".into());
        }
        Ok((scores, work))
    }
    fn score_windows(
        &mut self,
        query: &[f32],
        pending: &mut Vec<Window>,
        maxima: &mut [Vec<f32>],
        work: &mut super::Work,
        sink: &mut Option<&mut super::EncodeSink<'_>>,
    ) -> Result<()> {
        if pending.is_empty() {
            return Ok(());
        }
        crate::request::check()?;
        let inputs: Vec<_> = pending
            .iter()
            .map(|window| (window.ids.as_slice(), window.mask.as_slice()))
            .collect();
        let encoded = self.runtime()?.encode_documents(&inputs)?;
        work.actual_encoded_batches += 1;
        let mut offset = 0;
        for window in pending.drain(..) {
            let size = window
                .mask
                .iter()
                .filter(|selected| **selected != 0)
                .count()
                * TOKEN_EMBEDDING_DIMENSION;
            let rounded: Vec<f16> = encoded[offset..offset + size]
                .iter()
                .copied()
                .map(f16::from_f32)
                .collect();
            offset += size;
            self.runtime()?
                .update_maxima(query, &rounded, &mut maxima[window.document])?;
            work.actual_encoded_windows += 1;
            work.actual_encoded_tokens += window.ids.len();
            work.scored_document_tokens += rounded.len() / TOKEN_EMBEDDING_DIMENSION;
            if let Some(deliver) = sink.as_mut()
                && deliver(
                    window.document,
                    super::DocumentBlock::Code {
                        source: window.source,
                        input_tokens: window.ids.len(),
                        values: &rounded,
                    },
                )? == super::Delivery::ScoreOnly
            {
                *sink = None;
            }
        }
        debug_assert_eq!(offset, encoded.len());
        Ok(())
    }
}
