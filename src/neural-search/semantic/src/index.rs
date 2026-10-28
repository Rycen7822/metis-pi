//! Streaming records for the complete, query-independent index.
//! Scope admission/publication is separate: a finished record is NOT a cache hit.
use crate::{
    Chunk, Result,
    semantic::{BlockSink, DocumentBlock, Kind},
};
use half::f16;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Error, ErrorKind, Seek, SeekFrom, Write},
};

pub(crate) mod codec;

const MAGIC: &[u8; 8] = b"SGRPDOC2";
const HEADER: usize = 64;

fn invalid(message: &str) -> Box<dyn std::error::Error + Send + Sync> {
    Error::new(ErrorKind::InvalidData, message).into()
}
fn number(data: &[u8], at: usize) -> Result<usize> {
    let bytes = data
        .get(at..at.checked_add(8).ok_or_else(|| invalid("index overflow"))?)
        .ok_or_else(|| invalid("truncated record field"))?;
    Ok(usize::try_from(u64::from_le_bytes(bytes.try_into()?))?)
}
fn half_bytes(values: &[f16], output: &mut impl Write) -> Result<()> {
    let mut buffer = [0u8; 8192];
    for block in values.chunks(buffer.len() / 2) {
        for (i, value) in block.iter().enumerate() {
            buffer[2 * i..2 * i + 2].copy_from_slice(&value.to_bits().to_le_bytes());
        }
        output.write_all(&buffer[..block.len() * 2])?;
    }
    Ok(())
}
#[derive(Serialize)]
struct MetadataRef<'a> {
    chunk: &'a Chunk,
    counts: &'a HashMap<String, usize>,
}
#[derive(Deserialize)]
struct Metadata {
    chunk: Chunk,
    counts: HashMap<String, usize>,
}

pub struct RecordWriter<'a, W: Write + Seek> {
    output: &'a mut W,
    start: u64,
    metadata_bytes: u64,
    metadata_raw_bytes: u64,
    semantic_start: u64,
    source: &'a str,
    kind: Kind,
    blocks: usize,
    next_source: usize,
}
impl<'a, W: Write + Seek> RecordWriter<'a, W> {
    pub fn begin(output: &'a mut W, chunk: &'a Chunk, kind: Kind) -> Result<Self> {
        let (metadata_raw_bytes, metadata) =
            codec::pack_metadata(serde_json::to_vec(&MetadataRef {
                chunk,
                counts: &chunk.counts,
            })?)?;
        let start = output.stream_position()?;
        let mut header = [0u8; HEADER];
        header[..8].copy_from_slice(MAGIC);
        // Length remains zero until all original source bytes have been encoded.
        output.write_all(&header)?;
        output.write_all(&metadata)?;
        let semantic_start = output.stream_position()?;
        Ok(Self {
            output,
            start,
            metadata_bytes: semantic_start - start - HEADER as u64,
            metadata_raw_bytes: metadata_raw_bytes as u64,
            semantic_start,
            source: &chunk.content,
            kind,
            blocks: 0,
            next_source: 0,
        })
    }
    pub fn push(&mut self, block: DocumentBlock<'_>) -> Result<()> {
        match block {
            DocumentBlock::Text {
                values,
                inverse_norm,
            } => {
                if self.kind != Kind::Text
                    || self.blocks != 0
                    || !inverse_norm.is_finite()
                    || inverse_norm < 0.0
                    || values.iter().any(|v| !v.is_finite())
                {
                    return Err(invalid("invalid text representation"));
                }
                half_bytes(values, self.output)?;
                self.output.write_all(&inverse_norm.to_le_bytes())?;
            }
            DocumentBlock::Code {
                source,
                input_tokens,
                values,
            } => {
                if self.kind != Kind::Code
                    || source.start != self.next_source
                    || source.end > self.source.len()
                    || !self.source.is_char_boundary(source.start)
                    || !self.source.is_char_boundary(source.end)
                    || (source.end <= source.start
                        && !(self.source.is_empty() && self.blocks == 0 && source == (0..0)))
                    || input_tokens == 0
                    || input_tokens > 2048
                    || values.is_empty()
                    || values.len() % 48 != 0
                    || values.len() / 48 > input_tokens
                    || values.iter().any(|v| !v.is_finite())
                {
                    return Err(invalid("invalid source window or token representation"));
                }
                for number in [source.start as u64, source.end as u64] {
                    self.output.write_all(&number.to_le_bytes())?;
                }
                self.output
                    .write_all(&(input_tokens as u32).to_le_bytes())?;
                self.output
                    .write_all(&((values.len() / 48) as u32).to_le_bytes())?;
                let encoded = codec::pack_code(values)?;
                let bytes = encoded.as_ref().map_or(values.len() * 2, Vec::len);
                self.output.write_all(&(bytes as u32).to_le_bytes())?;
                self.output
                    .write_all(&u32::from(encoded.is_some()).to_le_bytes())?;
                if let Some(encoded) = encoded {
                    self.output.write_all(&encoded)?;
                } else {
                    half_bytes(values, self.output)?;
                }
                self.next_source = source.end;
            }
        }
        self.blocks = self
            .blocks
            .checked_add(1)
            .ok_or_else(|| invalid("window count overflow"))?;
        Ok(())
    }
    pub fn finish(mut self) -> Result<(u64, u64)> {
        if self.blocks == 0 || (self.kind == Kind::Code && self.next_source != self.source.len()) {
            return Err(invalid("incomplete document representation"));
        }
        let end = self.output.stream_position()?;
        let fields = [
            end - self.start,
            self.metadata_bytes,
            if self.kind == Kind::Text { 1 } else { 2 },
            self.blocks as u64,
            end - self.semantic_start,
            self.source.len() as u64,
            self.metadata_raw_bytes,
        ];
        self.output.seek(SeekFrom::Start(self.start + 8))?;
        for field in fields {
            self.output.write_all(&field.to_le_bytes())?;
        }
        self.output.seek(SeekFrom::Start(end))?;
        Ok((self.start, end - self.start))
    }
}

/// Borrows a bounded record from an immutable mmap; never copies an entire index.
pub struct Record<'a> {
    data: &'a [u8],
    pub chunk: Chunk,
    kind: Kind,
    blocks: usize,
    semantic: usize,
}
impl<'a> Record<'a> {
    pub fn open(data: &'a [u8], offset: usize) -> Result<Self> {
        let data = data
            .get(offset..)
            .ok_or_else(|| invalid("invalid record offset"))?;
        if data.get(..8) != Some(MAGIC) {
            return Err(invalid("unknown record format"));
        }
        let length = number(data, 8)?;
        let data = data
            .get(..length)
            .filter(|d| d.len() >= HEADER)
            .ok_or_else(|| invalid("incomplete/truncated record"))?;
        let semantic = HEADER
            .checked_add(number(data, 16)?)
            .ok_or_else(|| invalid("metadata overflow"))?;
        let kind = match number(data, 24)? {
            1 => Kind::Text,
            2 => Kind::Code,
            _ => return Err(invalid("unknown representation")),
        };
        let blocks = number(data, 32)?;
        if semantic > data.len()
            || number(data, 40)? != data.len() - semantic
            || blocks == 0
            || (kind == Kind::Text && (blocks != 1 || data.len() - semantic != 260))
            || (kind == Kind::Code
                && blocks
                    .checked_mul(32)
                    .is_none_or(|n| n > data.len() - semantic))
        {
            return Err(invalid("invalid record boundaries"));
        }
        let decoded = codec::metadata(&data[HEADER..semantic], number(data, 56)?)?;
        let mut metadata: Metadata = serde_json::from_slice(&decoded)?;
        if number(data, 48)? != metadata.chunk.content.len()
            || metadata.chunk.start == 0
            || metadata.chunk.end < metadata.chunk.start
        {
            return Err(invalid("invalid chunk range/size"));
        }
        metadata.counts.values().try_fold(0usize, |sum, n| {
            sum.checked_add(*n)
                .ok_or_else(|| invalid("lexical length overflow"))
        })?;
        metadata.chunk.counts = metadata.counts;
        metadata.chunk.scores = None;
        Ok(Self {
            data,
            chunk: metadata.chunk,
            kind,
            blocks,
            semantic,
        })
    }
    pub fn kind(&self) -> Kind {
        self.kind
    }
    pub fn visit(&self, sink: &mut BlockSink<'_>) -> Result<()> {
        let mut at = self.semantic;
        if self.kind == Kind::Text {
            let values: [f16; 128] = self
                .decode(at, 128)?
                .try_into()
                .map_err(|_| invalid("invalid text dimension"))?;
            let inverse_norm = f32::from_le_bytes(self.data[at + 256..at + 260].try_into()?);
            if !inverse_norm.is_finite() || inverse_norm < 0.0 {
                return Err(invalid("invalid inverse norm"));
            }
            return sink(DocumentBlock::Text {
                values: &values,
                inverse_norm,
            });
        }
        let mut next = 0;
        for block in 0..self.blocks {
            let start = number(self.data, at)?;
            let end = number(self.data, at + 8)?;
            let pair = self
                .data
                .get(at + 16..at + 24)
                .ok_or_else(|| invalid("truncated window"))?;
            let input_tokens = u32::from_le_bytes(pair[..4].try_into()?) as usize;
            let rows = u32::from_le_bytes(pair[4..].try_into()?) as usize;
            let encoding = self
                .data
                .get(at + 24..at + 32)
                .ok_or_else(|| invalid("truncated codec"))?;
            let bytes = u32::from_le_bytes(encoding[..4].try_into()?) as usize;
            let codec = u32::from_le_bytes(encoding[4..].try_into()?);
            if start != next
                || end > self.chunk.content.len()
                || !self.chunk.content.is_char_boundary(start)
                || !self.chunk.content.is_char_boundary(end)
                || (end <= start
                    && !(self.chunk.content.is_empty()
                        && block == 0
                        && self.blocks == 1
                        && start == 0
                        && end == 0))
                || input_tokens == 0
                || input_tokens > 2048
                || rows == 0
                || rows > input_tokens
            {
                return Err(invalid("invalid cached window"));
            }
            at = at
                .checked_add(32)
                .ok_or_else(|| invalid("window overflow"))?;
            let end_at = at
                .checked_add(bytes)
                .ok_or_else(|| invalid("payload overflow"))?;
            let payload = self
                .data
                .get(at..end_at)
                .ok_or_else(|| invalid("partial window payload"))?;
            let values = codec::code(payload, codec, rows * 48)?;
            if values.iter().any(|v| !v.is_finite()) {
                return Err(invalid("non-finite cached vector"));
            }
            sink(DocumentBlock::Code {
                source: start..end,
                input_tokens,
                values: &values,
            })?;
            at = at
                .checked_add(bytes)
                .ok_or_else(|| invalid("payload overflow"))?;
            next = end;
        }
        if at != self.data.len() || next != self.chunk.content.len() {
            return Err(invalid("partial/trailing representation"));
        }
        Ok(())
    }
    fn decode(&self, at: usize, count: usize) -> Result<Vec<f16>> {
        let end = at
            .checked_add(
                count
                    .checked_mul(2)
                    .ok_or_else(|| invalid("vector length overflow"))?,
            )
            .ok_or_else(|| invalid("vector offset overflow"))?;
        let bytes = self
            .data
            .get(at..end)
            .ok_or_else(|| invalid("truncated vector"))?;
        let values: Vec<_> = bytes
            .chunks_exact(2)
            .map(|v| f16::from_bits(u16::from_le_bytes([v[0], v[1]])))
            .collect();
        if values.iter().any(|v| !v.is_finite()) {
            return Err(invalid("non-finite cached vector"));
        }
        Ok(values)
    }
}
