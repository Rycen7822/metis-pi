//! Streaming records for the complete, query-independent index.
//! Scope admission/publication is separate: a finished record is NOT a cache hit.
use crate::{
    Chunk, Result,
    semantic::{
        BlockSink, CODE_EMBEDDING_DIMENSION, DocumentBlock, MAX_CODE_WINDOW_TOKENS, ModelKind,
        TEXT_EMBEDDING_DIMENSION,
    },
};
use half::f16;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Error, ErrorKind, Seek, SeekFrom, Write},
};

pub(crate) mod codec;

const MAGIC: &[u8; 8] = b"SGRPDOC2";
// Record header: magic@0, byte length@8, encoded metadata bytes@16,
// model tag@24, block count@32, semantic bytes@40, source text bytes@48,
// uncompressed metadata bytes@56. Fields after magic are little-endian u64.
pub(crate) const HEADER_BYTES: usize = 64;
// Code window: u64 source start/end, then u32 tokens/rows/payload bytes/codec.
const CODE_WINDOW_HEADER_BYTES: usize = 32;
const TEXT_VECTOR_BYTES: usize = TEXT_EMBEDDING_DIMENSION * size_of::<f16>();
// One rounded FP16 vector followed by its original FP32 inverse norm.
const TEXT_PAYLOAD_BYTES: usize = TEXT_VECTOR_BYTES + size_of::<f32>();
// Poll cancellation between bounded writes, including large multiwindow records.
const COPY_IO_BYTES: usize = 64 * 1024;

/// Errors originating in stored bytes, never errors returned by a score sink.
#[derive(Debug)]
pub struct CorruptRecord(pub Box<dyn std::error::Error + Send + Sync>);
impl std::fmt::Display for CorruptRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid cached record: {}", self.0)
    }
}
impl std::error::Error for CorruptRecord {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref())
    }
}
impl CorruptRecord {
    pub fn wrap(
        error: Box<dyn std::error::Error + Send + Sync>,
    ) -> Box<dyn std::error::Error + Send + Sync> {
        if error.is::<Self>() {
            error
        } else {
            Box::new(Self(error))
        }
    }
}
fn invalid(message: &str) -> Box<dyn std::error::Error + Send + Sync> {
    CorruptRecord::wrap(Error::new(ErrorKind::InvalidData, message).into())
}
fn read_usize(data: &[u8], at: usize) -> Result<usize> {
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
    kind: ModelKind,
    blocks: usize,
    next_source: usize,
}
impl<'a, W: Write + Seek> RecordWriter<'a, W> {
    pub fn begin(output: &'a mut W, chunk: &'a Chunk, kind: ModelKind) -> Result<Self> {
        let (metadata_raw_bytes, metadata) =
            codec::pack_metadata(serde_json::to_vec(&MetadataRef {
                chunk,
                counts: &chunk.counts,
            })?)?;
        let start = output.stream_position()?;
        let mut header = [0u8; HEADER_BYTES];
        header[..8].copy_from_slice(MAGIC);
        // Length remains zero until all original source bytes have been encoded.
        output.write_all(&header)?;
        output.write_all(&metadata)?;
        let semantic_start = output.stream_position()?;
        Ok(Self {
            output,
            start,
            metadata_bytes: semantic_start - start - HEADER_BYTES as u64,
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
                if self.kind != ModelKind::Text
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
                if self.kind != ModelKind::Code
                    || source.start != self.next_source
                    || source.end > self.source.len()
                    || !self.source.is_char_boundary(source.start)
                    || !self.source.is_char_boundary(source.end)
                    || (source.end <= source.start
                        && !(self.source.is_empty() && self.blocks == 0 && source == (0..0)))
                    || input_tokens == 0
                    || input_tokens > MAX_CODE_WINDOW_TOKENS
                    || values.is_empty()
                    || values.len() % CODE_EMBEDDING_DIMENSION != 0
                    || values.len() / CODE_EMBEDDING_DIMENSION > input_tokens
                    || values.iter().any(|v| !v.is_finite())
                {
                    return Err(invalid("invalid source window or token representation"));
                }
                for read_usize in [source.start as u64, source.end as u64] {
                    self.output.write_all(&read_usize.to_le_bytes())?;
                }
                self.output
                    .write_all(&(input_tokens as u32).to_le_bytes())?;
                self.output
                    .write_all(&((values.len() / CODE_EMBEDDING_DIMENSION) as u32).to_le_bytes())?;
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
    pub fn finish(self) -> Result<(u64, u64)> {
        if self.blocks == 0
            || (self.kind == ModelKind::Code && self.next_source != self.source.len())
        {
            return Err(invalid("incomplete document representation"));
        }
        let end = self.output.stream_position()?;
        let fields = [
            end - self.start,
            self.metadata_bytes,
            u64::from(self.kind.stored_tag()),
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
    pub length: usize,
    kind: ModelKind,
    blocks: usize,
    semantic: usize,
}
impl<'a> Record<'a> {
    pub fn open(data: &'a [u8], offset: usize, decoder: &mut codec::Decoder) -> Result<Self> {
        let data = data
            .get(offset..)
            .ok_or_else(|| invalid("invalid record offset"))?;
        if data.get(..8) != Some(MAGIC) {
            return Err(invalid("unknown record format"));
        }
        let length = read_usize(data, 8)?;
        let data = data
            .get(..length)
            .filter(|d| d.len() >= HEADER_BYTES)
            .ok_or_else(|| invalid("incomplete/truncated record"))?;
        let semantic = HEADER_BYTES
            .checked_add(read_usize(data, 16)?)
            .ok_or_else(|| invalid("metadata overflow"))?;
        let kind = ModelKind::from_stored_tag(read_usize(data, 24)?)
            .ok_or_else(|| invalid("unknown representation"))?;
        let blocks = read_usize(data, 32)?;
        if semantic > data.len()
            || read_usize(data, 40)? != data.len() - semantic
            || blocks == 0
            || (kind == ModelKind::Text
                && (blocks != 1 || data.len() - semantic != TEXT_PAYLOAD_BYTES))
            || (kind == ModelKind::Code
                && blocks
                    .checked_mul(32)
                    .is_none_or(|n| n > data.len() - semantic))
        {
            return Err(invalid("invalid record boundaries"));
        }
        let decoded = codec::metadata(
            &data[HEADER_BYTES..semantic],
            read_usize(data, 56)?,
            decoder,
        )?;
        let mut metadata: Metadata = serde_json::from_slice(&decoded)?;
        if read_usize(data, 48)? != metadata.chunk.content.len()
            || metadata.chunk.start == 0
            || metadata.chunk.end < metadata.chunk.start
        {
            return Err(invalid("invalid chunk range/size"));
        }
        let length = metadata.counts.values().try_fold(0usize, |sum, n| {
            if *n == 0 {
                return Err(invalid("zero lexical frequency"));
            }
            sum.checked_add(*n)
                .ok_or_else(|| invalid("lexical length overflow"))
        })?;
        metadata.chunk.counts = metadata.counts;
        metadata.chunk.scores = None;
        Ok(Self {
            data,
            chunk: metadata.chunk,
            length,
            kind,
            blocks,
            semantic,
        })
    }
    pub fn kind(&self) -> ModelKind {
        self.kind
    }
    /// Header-only accounting after this immutable record was fully scored.
    pub(crate) fn scored_rows(&self) -> Result<usize> {
        if self.kind == ModelKind::Text {
            return Ok(1);
        }
        let mut at = self.semantic;
        let mut rows = 0usize;
        for _ in 0..self.blocks {
            let header = self
                .data
                .get(at..at + CODE_WINDOW_HEADER_BYTES)
                .ok_or_else(|| invalid("truncated checked window"))?;
            rows = rows
                .checked_add(u32::from_le_bytes(header[20..24].try_into()?) as usize)
                .ok_or_else(|| invalid("row count overflow"))?;
            let payload_bytes = u32::from_le_bytes(header[24..28].try_into()?) as usize;
            at = at
                .checked_add(CODE_WINDOW_HEADER_BYTES)
                .and_then(|at| at.checked_add(payload_bytes))
                .filter(|at| *at <= self.data.len())
                .ok_or_else(|| invalid("window size overflow"))?;
        }
        if at != self.data.len() {
            return Err(invalid("trailing checked windows"));
        }
        Ok(rows)
    }
    pub fn visit(&self, decoder: &mut codec::Decoder, sink: &mut BlockSink<'_>) -> Result<()> {
        let mut at = self.semantic;
        if self.kind == ModelKind::Text {
            let mut values = [f16::ZERO; TEXT_EMBEDDING_DIMENSION];
            for (value, bytes) in values
                .iter_mut()
                .zip(self.data[at..at + TEXT_VECTOR_BYTES].chunks_exact(2))
            {
                *value = f16::from_le_bytes(bytes.try_into()?);
                if !value.is_finite() {
                    return Err(invalid("non-finite cached vector"));
                }
            }
            let inverse_norm = f32::from_le_bytes(
                self.data[at + TEXT_VECTOR_BYTES..at + TEXT_PAYLOAD_BYTES].try_into()?,
            );
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
            let start = read_usize(self.data, at)?;
            let end = read_usize(self.data, at + 8)?;
            let pair = self
                .data
                .get(at + 16..at + 24)
                .ok_or_else(|| invalid("truncated window"))?;
            let input_tokens = u32::from_le_bytes(pair[..4].try_into()?) as usize;
            let rows = u32::from_le_bytes(pair[4..].try_into()?) as usize;
            let encoding = self
                .data
                .get(at + 24..at + CODE_WINDOW_HEADER_BYTES)
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
                || input_tokens > MAX_CODE_WINDOW_TOKENS
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
            let values = codec::code(payload, codec, rows * CODE_EMBEDDING_DIMENSION, decoder)
                .map_err(CorruptRecord::wrap)?;
            if values.iter().any(|v| !v.is_finite()) {
                return Err(invalid("non-finite cached vector"));
            }
            sink(DocumentBlock::Code {
                source: start..end,
                input_tokens,
                values,
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
}

/// Copy only after complete scoring and current source identity checks. Relocated
/// blocks keep identical encoder input/payload, but receive current line metadata.
pub(crate) fn copy_checked(
    data: &[u8],
    output: &mut (impl Write + Seek),
    relocated: Option<&Chunk>,
) -> Result<(u64, u64)> {
    let start = output.stream_position()?;
    let bytes = if let Some(chunk) = relocated {
        let semantic = HEADER_BYTES
            .checked_add(read_usize(data, 16)?)
            .ok_or_else(|| invalid("metadata overflow"))?;
        let payload = data
            .get(semantic..)
            .ok_or_else(|| invalid("invalid semantic section"))?;
        let (raw_bytes, metadata) = codec::pack_metadata(serde_json::to_vec(&MetadataRef {
            chunk,
            counts: &chunk.counts,
        })?)?;
        let mut header: [u8; HEADER_BYTES] = data
            .get(..HEADER_BYTES)
            .ok_or_else(|| invalid("truncated checked record"))?
            .try_into()?;
        let total = HEADER_BYTES
            .checked_add(metadata.len())
            .and_then(|n| n.checked_add(payload.len()))
            .ok_or_else(|| invalid("record length overflow"))?;
        for (offset, value) in [
            (8, total),
            (16, metadata.len()),
            (48, chunk.content.len()),
            (56, raw_bytes),
        ] {
            header[offset..offset + 8].copy_from_slice(&(value as u64).to_le_bytes());
        }
        output.write_all(&header)?;
        output.write_all(&metadata)?;
        payload
    } else {
        data
    };
    for block in bytes.chunks(COPY_IO_BYTES) {
        crate::request::check()?;
        output.write_all(block)?;
    }
    Ok((start, output.stream_position()? - start))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn relocated_record_keeps_payload_and_counts_but_updates_lines() -> Result<()> {
        let chunk = Chunk {
            path: "source.py".into(),
            start: 1,
            end: 2,
            content: "alpha\nbeta\n".into(),
            counts: HashMap::from([("alpha".into(), 1), ("beta".into(), 1)]),
            scores: None,
        };
        let mut original = Cursor::new(Vec::new());
        let mut writer = RecordWriter::begin(&mut original, &chunk, ModelKind::Code)?;
        let values = [f16::from_f32(0.25); 2 * CODE_EMBEDDING_DIMENSION];
        writer.push(DocumentBlock::Code {
            source: 0..chunk.content.len(),
            input_tokens: 4,
            values: &values,
        })?;
        writer.finish()?;
        let mut decoder = codec::Decoder::new()?;
        let record = Record::open(original.get_ref(), 0, &mut decoder)?;
        assert_eq!(record.scored_rows()?, 2);
        let mut moved = record.chunk;
        moved.start = 10;
        moved.end = 11;
        let mut output = Cursor::new(Vec::new());
        copy_checked(original.get_ref(), &mut output, Some(&moved))?;
        let restored = Record::open(output.get_ref(), 0, &mut decoder)?;
        assert_eq!((restored.chunk.start, restored.chunk.end), (10, 11));
        assert_eq!(restored.chunk.content, chunk.content);
        assert_eq!(restored.chunk.counts, chunk.counts);
        assert_eq!(restored.scored_rows()?, 2);
        let mut delivered = Vec::new();
        restored.visit(&mut decoder, &mut |block| {
            let DocumentBlock::Code { values, .. } = block else {
                panic!("code record expected");
            };
            delivered.extend_from_slice(values);
            Ok(())
        })?;
        assert_eq!(delivered, values);
        let old_payload = HEADER_BYTES + read_usize(original.get_ref(), 16)?;
        assert_eq!(
            &original.get_ref()[old_payload..],
            &output.get_ref()[restored.semantic..]
        );
        let mut unchanged = Cursor::new(Vec::new());
        copy_checked(original.get_ref(), &mut unchanged, None)?;
        assert_eq!(unchanged.into_inner(), original.into_inner());
        Ok(())
    }
}
