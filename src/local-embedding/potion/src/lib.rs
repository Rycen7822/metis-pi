//! Pinned local Potion-code-16M-v2 encoder and FP16 document representation.
use half::f16;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};
use tokenizers::Tokenizer;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const ROWS: usize = 63457;
const DIM: usize = 256;
pub const DOCUMENT_BYTES: usize = DIM * 2 + 4;
pub type Vector = [f32; DIM];

#[derive(Deserialize)]
struct Header {
    embeddings: Tensor,
}

#[derive(Deserialize)]
struct Tensor {
    dtype: String,
    shape: [usize; 2],
    data_offsets: [usize; 2],
}

fn verified(path: &Path, cap: usize, digest: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)?;
    let actual: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if bytes.len() > cap || actual != digest {
        return Err("Unsupported Potion-code-16M-v2 artifact".into());
    }
    Ok(bytes)
}

pub struct Encoder {
    tokenizer: Tokenizer,
    unknown: u32,
    table: Vec<f32>,
}

impl Encoder {
    pub fn open(directory: &Path) -> Result<Self> {
        let raw = verified(
            &directory.join("model.safetensors"),
            33_000_000,
            "75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c",
        )?;
        let header_len =
            u64::from_le_bytes(raw.get(..8).ok_or("Missing Potion header")?.try_into()?);
        let split = usize::try_from(header_len)?
            .checked_add(8)
            .filter(|&n| n <= raw.len())
            .ok_or("Invalid Potion tensor header length")?;
        let header: Header = serde_json::from_slice(&raw[8..split])?;
        let bytes = ROWS * DIM * 2;
        let tensor = header.embeddings;
        if tensor.dtype != "F16"
            || tensor.shape != [ROWS, DIM]
            || tensor.data_offsets != [0, bytes]
            || raw.len() - split != bytes
        {
            return Err("Unsupported Potion tensor representation".into());
        }
        let table = raw[split..]
            .chunks_exact(2)
            .map(|v| f16::from_bits(u16::from_le_bytes([v[0], v[1]])).to_f32())
            .collect();
        drop(raw);
        let config = verified(
            &directory.join("tokenizer.json"),
            1_200_000,
            "107bbdcbad4bff1d299b7a4c3a2fb17c52890688b7dd0e4c9deab79d3c4f3d45",
        )?;
        let mut tokenizer = Tokenizer::from_bytes(config)?;
        tokenizer.with_truncation(None)?.with_padding(None);
        let unknown = tokenizer
            .token_to_id("[UNK]")
            .ok_or("Potion tokenizer lacks [UNK]")?;
        Ok(Self {
            tokenizer,
            unknown,
            table,
        })
    }

    pub fn encode(&self, text: &str) -> Result<Vector> {
        let tokens = self.tokenizer.encode_fast(text, false)?;
        let mut sum = [0.0_f64; DIM];
        let mut count = 0_u32;
        for &id in tokens
            .get_ids()
            .iter()
            .take(1024)
            .filter(|&&id| id != self.unknown)
        {
            let row = id as usize;
            if row >= ROWS {
                return Err("Token outside Potion vocabulary".into());
            }
            for (dst, src) in sum.iter_mut().zip(&self.table[row * DIM..(row + 1) * DIM]) {
                *dst += f64::from(*src);
            }
            count += 1;
        }
        if count == 0 {
            return Ok([0.0; DIM]);
        }
        for value in &mut sum {
            *value /= f64::from(count);
        }
        let norm = sum.iter().map(|v| v * v).sum::<f64>().sqrt();
        if norm == 0.0 {
            return Ok([0.0; DIM]);
        }
        let inv = norm.recip();
        Ok(sum.map(|v| (v * inv) as f32))
    }
}

pub fn document(vector: &Vector) -> [u8; DOCUMENT_BYTES] {
    let packed = vector.map(f16::from_f32);
    let norm = packed
        .iter()
        .map(|v| v.to_f32().powi(2))
        .sum::<f32>()
        .sqrt();
    let inverse = if norm > 0.0 { norm.recip() } else { 0.0 };
    let mut bytes = [0; DOCUMENT_BYTES];
    for (slot, value) in bytes.chunks_exact_mut(2).zip(packed) {
        slot.copy_from_slice(&value.to_bits().to_le_bytes());
    }
    bytes[DOCUMENT_BYTES - 4..].copy_from_slice(&inverse.to_le_bytes());
    bytes
}

pub fn similarity(bytes: &[u8; DOCUMENT_BYTES], query: &Vector) -> Result<f64> {
    let inverse = f32::from_le_bytes(bytes[DOCUMENT_BYTES - 4..].try_into()?);
    let dot = bytes
        .chunks_exact(2)
        .zip(query)
        .map(|(v, q)| f16::from_bits(u16::from_le_bytes([v[0], v[1]])).to_f32() * q)
        .sum::<f32>();
    let score = dot * inverse;
    if !score.is_finite() || !inverse.is_finite() || inverse < 0.0 {
        return Err("Invalid Potion vector in Recall cache".into());
    }
    Ok(f64::from(score))
}
