use crate::Result;
use half::f16;
use memmap2::Mmap;
use serde::Deserialize;
use std::{fs::File, io::BufReader, path::Path};
// This prepared vocabulary is WordPiece. Fixed dispatch avoids ModelWrapper's
// intermediate JSON tree without changing the tokenizer's other components.
type Tokenizer = tokenizers::TokenizerImpl<
    tokenizers::models::wordpiece::WordPiece,
    tokenizers::normalizers::NormalizerWrapper,
    tokenizers::pre_tokenizers::PreTokenizerWrapper,
    tokenizers::processors::PostProcessorWrapper,
    tokenizers::decoders::DecoderWrapper,
>;

pub const DIM: usize = 128;
const ROWS: usize = 200_000;
const REVISION: &str = "c18167b8f244c1bc6de21ce9b710bac8a29c4615";

#[derive(Deserialize)]
struct Manifest {
    format_version: u32,
    model: String,
    revision: String,
    rows: usize,
    dimensions: usize,
    pack_bytes: usize,
    normalization_epsilon: f32,
    add_special_tokens: bool,
    truncation: bool,
}

pub struct Encoder {
    map: Mmap,
    tokenizer: Tokenizer,
    scales_offset: usize,
    epsilon: f32,
    use_avx2: bool,
}

impl Encoder {
    pub fn open(directory: &Path) -> Result<Self> {
        let manifest: Manifest =
            serde_json::from_reader(BufReader::new(File::open(directory.join("manifest.json"))?))?;
        if manifest.format_version != 1
            || manifest.model != "bekko_static_128"
            || manifest.revision != REVISION
            || manifest.rows != ROWS
            || manifest.dimensions != DIM
            || manifest.add_special_tokens
            || manifest.truncation
            || manifest.normalization_epsilon != 1e-12
        {
            return Err("ARTIFACT_MISMATCH: unsupported Bekko manifest".into());
        }
        let file = File::open(directory.join("bekko128.pack"))?;
        let expected_size = 64 + ROWS * DIM + ROWS * 4;
        if file.metadata()?.len() != expected_size as u64 || manifest.pack_bytes != expected_size {
            return Err("ARTIFACT_MISMATCH: invalid Bekko pack size".into());
        }
        // Prepared model files are immutable while mapped; prepare publishes a
        // new file, never edits live mappings. No online full-weight hash pass.
        let map = unsafe { Mmap::map(&file)? };
        let u32_at = |at| u32::from_le_bytes(map[at..at + 4].try_into().unwrap());
        let u64_at = |at| u64::from_le_bytes(map[at..at + 8].try_into().unwrap());
        let scales_offset = 64 + ROWS * DIM;
        if &map[..8] != b"SGRBK128"
            || u32_at(8) != 1
            || u32_at(12) != ROWS as u32
            || u32_at(16) != DIM as u32
            || u32_at(20) != 0
            || u64_at(24) != 64
            || u64_at(32) != scales_offset as u64
            || u64_at(40) != expected_size as u64
        {
            return Err("ARTIFACT_MISMATCH: invalid Bekko pack header".into());
        }
        let mut tokenizer = Tokenizer::from_file(directory.join("tokenizer.json"))?;
        tokenizer.with_truncation(None)?;
        tokenizer.with_padding(None);
        #[cfg(target_arch = "x86_64")]
        let use_avx2 = std::arch::is_x86_feature_detected!("avx2");
        #[cfg(not(target_arch = "x86_64"))]
        let use_avx2 = false;
        Ok(Self {
            map,
            tokenizer,
            scales_offset,
            epsilon: manifest.normalization_epsilon,
            use_avx2,
        })
    }

    pub fn encode(&self, text: &str) -> Result<([f32; DIM], usize)> {
        let ids = self.tokenizer.encode_fast(text, false)?;
        self.encode_ids(ids.get_ids(), self.use_avx2)
            .map(|(_, normalized)| (normalized, ids.len()))
    }

    fn encode_ids(&self, ids: &[u32], use_avx2: bool) -> Result<([f32; DIM], [f32; DIM])> {
        let mut scales = Vec::with_capacity(ids.len());
        for &id in ids {
            if id as usize >= ROWS {
                return Err("ARTIFACT_MISMATCH: token outside Bekko vocabulary".into());
            }
            let at = self.scales_offset + id as usize * 4;
            let scale = f32::from_le_bytes(self.map[at..at + 4].try_into().unwrap());
            if !scale.is_finite() {
                return Err("ARTIFACT_MISMATCH: non-finite Bekko scale".into());
            }
            scales.push(scale);
        }
        let table = &self.map[64..self.scales_offset];
        let mut raw = [0.0; DIM];
        #[cfg(target_arch = "x86_64")]
        if use_avx2 {
            // Rust's feature detector includes OSXSAVE/XCR0 validation.
            unsafe { accumulate_avx2(table, &scales, ids, &mut raw) };
        } else {
            accumulate_scalar(table, &scales, ids, &mut raw);
        }
        #[cfg(not(target_arch = "x86_64"))]
        {
            let _ = use_avx2;
            accumulate_scalar(table, &scales, ids, &mut raw);
        }
        if !ids.is_empty() {
            for value in &mut raw {
                *value /= ids.len() as f32;
            }
        }
        let norm = raw
            .iter()
            .map(|x| x * x)
            .sum::<f32>()
            .sqrt()
            .max(self.epsilon);
        let normalized = raw.map(|x| x / norm);
        if normalized.iter().any(|x| !x.is_finite()) {
            return Err("non-finite Bekko output".into());
        }
        Ok((raw, normalized))
    }
}

fn accumulate_scalar(table: &[u8], scales: &[f32], ids: &[u32], sum: &mut [f32; DIM]) {
    for (&id, &scale) in ids.iter().zip(scales) {
        let row = &table[id as usize * DIM..][..DIM];
        for (value, &weight) in sum.iter_mut().zip(row) {
            *value += (weight as i8 as f32) * scale;
        }
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn accumulate_avx2(table: &[u8], scales: &[f32], ids: &[u32], sum: &mut [f32; DIM]) {
    use std::arch::x86_64::*;
    // Eight live YMM accumulators cover 64 dimensions. Each dimension retains
    // original token order; there is no FMA target or FP reassociation.
    unsafe {
        for stripe in (0..DIM).step_by(64) {
            let mut accumulators = [_mm256_setzero_ps(); 8];
            for (&id, &scale) in ids.iter().zip(scales) {
                let row = table.as_ptr().add(id as usize * DIM + stripe);
                let scale = _mm256_set1_ps(scale);
                for (i, accumulator) in accumulators.iter_mut().enumerate() {
                    let bytes = _mm_loadl_epi64(row.add(i * 8).cast());
                    let weights = _mm256_cvtepi32_ps(_mm256_cvtepi8_epi32(bytes));
                    *accumulator = _mm256_add_ps(*accumulator, _mm256_mul_ps(weights, scale));
                }
            }
            for (i, accumulator) in accumulators.into_iter().enumerate() {
                _mm256_storeu_ps(sum.as_mut_ptr().add(stripe + i * 8), accumulator);
            }
        }
    }
}

pub struct Document {
    values: [f16; DIM],
    inverse_norm: f32,
}

impl Document {
    pub fn from_stored(values: &[f16; DIM], inverse_norm: f32) -> Self {
        Self {
            values: *values,
            inverse_norm,
        }
    }

    pub fn from_normalized(vector: &[f32; DIM]) -> Self {
        let values = vector.map(f16::from_f32);
        let norm = values
            .iter()
            .map(|v| v.to_f32().powi(2))
            .sum::<f32>()
            .sqrt();
        Self {
            values,
            inverse_norm: if norm > 0.0 { norm.recip() } else { 0.0 },
        }
    }

    pub fn stored(&self) -> (&[f16; DIM], f32) {
        (&self.values, self.inverse_norm)
    }

    pub fn score(&self, query: &[f32; DIM]) -> f64 {
        Self::score_stored(&self.values, self.inverse_norm, query)
    }

    pub fn score_stored(values: &[f16; DIM], inverse_norm: f32, query: &[f32; DIM]) -> f64 {
        let dot = values
            .iter()
            .zip(query)
            .map(|(d, q)| d.to_f32() * q)
            .sum::<f32>();
        (dot * inverse_norm) as f64
    }
}

const SCAN_ROWS: usize = 1024;

/// Query-scoped scratch only, not a second persistent representation. The 1024
/// rows use [128 dimensions][8 rows] tiles: filling one tile stays in L1 rather
/// than striding 1024 rows across conflicting cache sets. SIMD lanes remain
/// independent documents; each dot keeps scalar dimension order and signed zero.
/// Full blocks flush automatically; finish consumes every tail row.
pub(super) struct TextScan {
    values: Vec<f16>,
    inverse_norms: Vec<f32>,
    query: [f32; DIM],
    rows: usize,
    scores: Vec<f64>,
    #[cfg(target_arch = "x86_64")]
    use_avx2: bool,
}

impl TextScan {
    pub fn new(query: &[f32; DIM], count: usize) -> Self {
        Self {
            values: vec![f16::ZERO; SCAN_ROWS * DIM],
            inverse_norms: vec![0.0; SCAN_ROWS],
            query: *query,
            rows: 0,
            scores: Vec::with_capacity(count),
            #[cfg(target_arch = "x86_64")]
            use_avx2: std::arch::is_x86_feature_detected!("avx2")
                && std::arch::is_x86_feature_detected!("f16c"),
        }
    }

    pub fn push(&mut self, document: Document) -> Result<()> {
        let base = self.rows / 8 * DIM * 8;
        let lane = self.rows % 8;
        for (dimension, value) in document.values.into_iter().enumerate() {
            self.values[base + dimension * 8 + lane] = value;
        }
        self.inverse_norms[self.rows] = document.inverse_norm;
        self.rows += 1;
        if self.rows == SCAN_ROWS {
            self.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        let first = self.scores.len();
        self.scores.resize(first + self.rows, 0.0);
        let output = &mut self.scores[first..];
        #[cfg(target_arch = "x86_64")]
        if self.use_avx2 {
            // The dispatch checks AVX2 OS state as well as the F16C feature.
            unsafe { scan_avx2(&self.values, &self.inverse_norms, &self.query, output) };
        } else {
            scan_scalar(&self.values, &self.inverse_norms, &self.query, output);
        }
        #[cfg(not(target_arch = "x86_64"))]
        scan_scalar(&self.values, &self.inverse_norms, &self.query, output);
        if output.iter().any(|score| !score.is_finite()) {
            return Err("non-finite cached text score".into());
        }
        self.rows = 0;
        Ok(())
    }

    pub fn finish(mut self) -> Result<Vec<f64>> {
        self.flush()?;
        Ok(self.scores)
    }
}

fn scan_row(values: &[f16], inverse_norms: &[f32], query: &[f32; DIM], row: usize) -> f64 {
    let base = row / 8 * DIM * 8;
    let lane = row % 8;
    let dot = (0..DIM)
        .map(|dimension| values[base + dimension * 8 + lane].to_f32() * query[dimension])
        .sum::<f32>();
    (dot * inverse_norms[row]) as f64
}

fn scan_scalar(values: &[f16], inverse_norms: &[f32], query: &[f32; DIM], output: &mut [f64]) {
    for (row, score) in output.iter_mut().enumerate() {
        *score = scan_row(values, inverse_norms, query, row);
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,f16c")]
unsafe fn scan_avx2(values: &[f16], inverse_norms: &[f32], query: &[f32; DIM], output: &mut [f64]) {
    use std::arch::x86_64::*;
    let full_rows = output.len() / 8 * 8;
    unsafe {
        for row in (0..full_rows).step_by(8) {
            // Sum<f32> uses -0.0 as its identity; preserve it for zero vectors.
            let mut dot = _mm256_set1_ps(-0.0);
            for (dimension, &q) in query.iter().enumerate() {
                let half = _mm_loadu_si128(values.as_ptr().add(row * DIM + dimension * 8).cast());
                let document = _mm256_cvtph_ps(half);
                dot = _mm256_add_ps(dot, _mm256_mul_ps(document, _mm256_set1_ps(q)));
            }
            let normalized = _mm256_mul_ps(dot, _mm256_loadu_ps(inverse_norms.as_ptr().add(row)));
            let mut scores = [0.0_f32; 8];
            _mm256_storeu_ps(scores.as_mut_ptr(), normalized);
            for (target, score) in output[row..row + 8].iter_mut().zip(scores) {
                *target = score as f64;
            }
        }
    }
    for row in full_rows..output.len() {
        output[row] = scan_row(values, inverse_norms, query, row);
    }
}
