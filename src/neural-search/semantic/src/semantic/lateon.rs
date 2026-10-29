use super::native::Runtime;
use crate::Result;
use half::f16;
use serde::Deserialize;
use std::{
    collections::HashSet,
    fs::File,
    path::{Path, PathBuf},
};
// This prepared asset is BPE. Avoid ModelWrapper's dynamic JSON dispatch while
// retaining the same normalizer, added tokens, processors and BPE implementation.
type Tokenizer = tokenizers::TokenizerImpl<
    tokenizers::models::bpe::BPE,
    tokenizers::normalizers::NormalizerWrapper,
    tokenizers::pre_tokenizers::PreTokenizerWrapper,
    tokenizers::processors::PostProcessorWrapper,
    tokenizers::decoders::DecoderWrapper,
>;

#[derive(Deserialize)]
struct Manifest {
    graph_format: String,
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
pub struct Encoder {
    runtime: Option<Runtime>,
    library: PathBuf,
    manifest_path: PathBuf,
    tokenizer: Tokenizer,
    query_prefix: u32,
    document_prefix: u32,
    lower_case: bool,
    skiplist: HashSet<u32>,
}
impl Encoder {
    pub fn open(model: &Path, library: &Path) -> Result<Self> {
        let manifest_path = model.join("manifest.json");
        let config: Manifest = serde_json::from_reader(File::open(&manifest_path)?)?;
        if config.graph_format != "ort"
            || config.backbone_dtype != "float32"
            || config.embedding_dtype != "float32"
            || config.query_length != 256
            || config.document_length != 2048
            || config.do_query_expansion
        {
            return Err(
                "ARTIFACT_MISMATCH: unsupported LateOn tokenizer/precision contract".into(),
            );
        }
        let mut tokenizer = Tokenizer::from_file(model.join("tokenizer.json"))?;
        tokenizer.with_truncation(None)?;
        tokenizer.with_padding(None);
        let query_prefix = tokenizer
            .token_to_id(&config.query_prefix)
            .ok_or("query role token missing")?;
        let document_prefix = tokenizer
            .token_to_id(&config.document_prefix)
            .ok_or("document role token missing")?;
        Ok(Self {
            runtime: None,
            library: library.to_path_buf(),
            manifest_path,
            tokenizer,
            query_prefix,
            document_prefix,
            lower_case: config.do_lower_case,
            skiplist: config.skiplist,
        })
    }
    fn runtime(&mut self) -> Result<&mut Runtime> {
        if self.runtime.is_none() {
            self.runtime = Some(Runtime::open(&self.library, &self.manifest_path)?);
        }
        Ok(self.runtime.as_mut().expect("runtime was initialized"))
    }

    fn tokenize(&self, text: &str, query: bool) -> Result<(Vec<u32>, Vec<u8>)> {
        // Fixed PyLate strips/lowercases via ST, then inserts role ID at 1.
        let text = if self.lower_case {
            text.trim().to_lowercase()
        } else {
            text.trim().to_owned()
        };
        let mut ids = self.tokenizer.encode_fast(text, true)?.get_ids().to_vec();
        if ids.len() < 2 {
            return Err("ARTIFACT_MISMATCH: missing BOS/EOS processor".into());
        }
        ids.insert(
            1,
            if query {
                self.query_prefix
            } else {
                self.document_prefix
            },
        );
        let mask = ids
            .iter()
            .map(|id| u8::from(query || !self.skiplist.contains(id)))
            .collect();
        Ok((ids, mask))
    }
    pub fn query(&mut self, text: &str) -> Result<(Vec<f32>, usize)> {
        let (ids, mask) = self.tokenize(text, true)?;
        if ids.len() > 256 {
            return Err("INVALID_INPUT: query exceeds LateOn's 256-token limit (including role/special tokens)".into());
        }
        let values = self.runtime()?.encode(&ids, &mask, true)?;
        Ok((values, ids.len()))
    }
    fn window(
        &self,
        prefix: &str,
        content: &str,
        start: usize,
    ) -> Result<(usize, Vec<u32>, Vec<u8>)> {
        let mut end = content.len();
        loop {
            let text = format!("{prefix}{}", &content[start..end]);
            let (ids, mask) = self.tokenize(&text, false)?;
            if ids.len() <= 2048 {
                return Ok((end, ids, mask));
            }
            // Actual UTF-8 source ranges; no monotonic BPE-count assumption.
            let mut next = start + (end - start) / 2;
            while next > start && !content.is_char_boundary(next) {
                next -= 1;
            }
            if next == start {
                return Err(
                    "INVALID_INPUT: path prefix leaves no room for one source character".into(),
                );
            }
            end = next;
        }
    }
    pub fn score(&mut self, query: &[f32], path: &str, content: &str) -> Result<f64> {
        self.score_to(query, path, content, &mut |_| Ok(()))
    }
    pub fn update_maxima(
        &mut self,
        query: &[f32],
        values: &[f16],
        maxima: &mut [f32],
    ) -> Result<()> {
        self.runtime()?.update_maxima(query, values, maxima)
    }
    pub fn score_to(
        &mut self,
        query: &[f32],
        path: &str,
        content: &str,
        sink: &mut super::BlockSink<'_>,
    ) -> Result<f64> {
        let prefix = format!("{path}\n");
        if self.tokenize(&prefix, false)?.0.len() > 2048 {
            return Err("INVALID_INPUT: path/role prefix exceeds LateOn's document budget".into());
        }
        let mut maxima = vec![f32::NEG_INFINITY; query.len() / 48];
        let mut start = 0;
        loop {
            let (end, ids, mask) = self.window(&prefix, content, start)?;
            let encoded = self.runtime()?.encode(&ids, &mask, false)?;
            let rounded: Vec<f16> = encoded.into_iter().map(f16::from_f32).collect();
            self.runtime()?
                .update_maxima(query, &rounded, &mut maxima)?;
            sink(super::DocumentBlock::Code {
                source: start..end,
                input_tokens: ids.len(),
                values: &rounded,
            })?;
            if end == content.len() {
                break;
            }
            start = end;
        }
        let score = maxima.into_iter().sum::<f32>();
        if !score.is_finite() {
            return Err("UNVERIFIED_BACKEND: non-finite MaxSim".into());
        }
        Ok(score as f64)
    }
}
