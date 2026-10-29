//! Lossless storage only. All sixteen FP16 bits survive; this is not quantization.
//! A decoder owns at most one 2048x48 window and bounded metadata, never a scope.
use crate::Result;
use half::f16;
use std::{borrow::Cow, io};

const MAX_METADATA: usize = 8 << 20;
const MAX_VALUES: usize = 2048 * 48;
const MAX_SCOPE_METADATA: usize = 128 << 20;

/// Owned by one scope pass, not global or per-record. Outputs still use the
/// existing bounded allocations; no decompressed corpus is retained here.
pub(crate) struct Decoder {
    zstd: zstd::bulk::Decompressor<'static>,
}
impl Decoder {
    pub(crate) fn new() -> Result<Self> {
        Ok(Self {
            zstd: zstd::bulk::Decompressor::new()?,
        })
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Zero raw_length denotes an uncompressed frame. Keep incompressible data raw.
pub(crate) fn pack_metadata(raw: Vec<u8>) -> Result<(usize, Vec<u8>)> {
    if raw.len() > MAX_METADATA {
        // Admission failure, not invalid source: the caller must continue uncached.
        return Err(io::Error::other("cache metadata scratch admission exhausted").into());
    }
    let encoded = zstd::bulk::compress(&raw, 1)?;
    if encoded.len() < raw.len() {
        Ok((raw.len(), encoded))
    } else {
        Ok((0, raw))
    }
}
pub(crate) fn metadata<'a>(
    stored: &'a [u8],
    raw_length: usize,
    decoder: &mut Decoder,
) -> Result<Cow<'a, [u8]>> {
    if stored.len() > MAX_METADATA || raw_length > MAX_METADATA {
        return Err(invalid("cache metadata scratch bound exceeded").into());
    }
    if raw_length == 0 {
        return Ok(Cow::Borrowed(stored));
    }
    if stored.len() >= raw_length {
        return Err(invalid("invalid compressed metadata length").into());
    }
    let decoded = decoder
        .zstd
        .decompress(stored, raw_length)
        .map_err(|_| invalid("invalid compressed metadata"))?;
    if decoded.len() != raw_length {
        return Err(invalid("partial compressed metadata").into());
    }
    Ok(Cow::Owned(decoded))
}

/// Pack sign+mantissa as eleven exact bits; compress the five-bit exponent symbols.
/// Row geometry makes the bitstream byte aligned. None means raw FP16 is smaller.
pub(crate) fn pack_code(values: &[f16]) -> Result<Option<Vec<u8>>> {
    if values.is_empty() || values.len() > MAX_VALUES || values.len() % 48 != 0 {
        return Err(invalid("invalid lossless window geometry").into());
    }
    let mut packed = Vec::with_capacity(values.len() * 11 / 8);
    let mut exponents = Vec::with_capacity(values.len());
    let (mut bits, mut available) = (0u32, 0u32);
    for value in values {
        let word = value.to_bits();
        exponents.push(((word >> 10) & 31) as u8);
        let sign_mantissa = (word & 0x3ff) | ((word >> 5) & 0x400);
        bits |= u32::from(sign_mantissa) << available;
        available += 11;
        while available >= 8 {
            packed.push(bits as u8);
            bits >>= 8;
            available -= 8;
        }
    }
    debug_assert_eq!(available, 0);
    let encoded = zstd::bulk::compress(&exponents, 1)?;
    if packed.len() + encoded.len() >= values.len() * 2 {
        return Ok(None);
    }
    packed.extend_from_slice(&encoded);
    Ok(Some(packed))
}
pub(crate) fn code(
    stored: &[u8],
    codec: u32,
    count: usize,
    decoder: &mut Decoder,
) -> Result<Vec<f16>> {
    if count == 0 || count > MAX_VALUES || count % 48 != 0 {
        return Err(invalid("invalid decoded window geometry").into());
    }
    if codec == 0 {
        if stored.len() != count * 2 {
            return Err(invalid("invalid raw window length").into());
        }
        return Ok(stored
            .chunks_exact(2)
            .map(|v| f16::from_bits(u16::from_le_bytes([v[0], v[1]])))
            .collect());
    }
    let packed_length = count * 11 / 8;
    if codec != 1 || stored.len() <= packed_length || stored.len() >= count * 2 {
        return Err(invalid("invalid lossless window length/codec").into());
    }
    let exponents = decoder
        .zstd
        .decompress(&stored[packed_length..], count)
        .map_err(|_| invalid("invalid exponent frame"))?;
    if exponents.len() != count || exponents.iter().any(|&v| v > 31) {
        return Err(invalid("invalid exponent symbols").into());
    }
    let mut values = Vec::with_capacity(count);
    // Valid geometry is a multiple of 48, so groups of eight values occupy
    // exactly eleven bytes. Reassemble all sixteen bits without FP arithmetic.
    for (bytes, exponents) in stored[..packed_length]
        .chunks_exact(11)
        .zip(exponents.chunks_exact(8))
    {
        let mut group = [0u8; 16];
        group[..11].copy_from_slice(bytes);
        let bits = u128::from_le_bytes(group);
        for (i, &exponent) in exponents.iter().enumerate() {
            let value = ((bits >> (11 * i)) & 0x7ff) as u16;
            values.push(f16::from_bits(
                (value & 0x3ff) | ((value & 0x400) << 5) | (u16::from(exponent) << 10),
            ));
        }
    }
    Ok(values)
}

/// Stream the potentially large source manifest; never materialize its JSON.
pub(crate) fn write_scope_metadata(
    output: &mut impl io::Write,
    value: &impl serde::Serialize,
) -> Result<usize> {
    struct Counted<W> {
        writer: W,
        count: usize,
    }
    impl<W: io::Write> io::Write for Counted<W> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > MAX_SCOPE_METADATA - self.count {
                return Err(io::Error::other(
                    "scope metadata scratch admission exhausted",
                ));
            }
            let count = self.writer.write(bytes)?;
            self.count += count;
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.writer.flush()
        }
    }
    let writer = zstd::stream::write::Encoder::new(output, 1)?;
    let mut counted = Counted { writer, count: 0 };
    serde_json::to_writer(&mut counted, value)?;
    counted.writer.finish()?;
    Ok(counted.count)
}
pub(crate) fn scope_metadata(stored: &[u8], raw_length: usize) -> Result<Vec<u8>> {
    if raw_length == 0 || raw_length > MAX_SCOPE_METADATA {
        return Err(invalid("scope metadata scratch bound exceeded").into());
    }
    let decoded = zstd::bulk::decompress(stored, raw_length)
        .map_err(|_| invalid("invalid scope metadata frame"))?;
    if decoded.len() != raw_length {
        return Err(invalid("partial scope metadata").into());
    }
    Ok(decoded)
}
