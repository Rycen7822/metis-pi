//! Lossless storage only. All sixteen FP16 bits survive; this is not quantization.
//! A decoder owns at most one 2048x48 window and bounded metadata, never a scope.
use crate::Result;
use half::f16;
use std::{borrow::Cow, io};

const MAX_METADATA: usize = 8 << 20;
const MAX_VALUES: usize = 2048 * 48;
const MAX_SCOPE_METADATA: usize = 128 << 20;

/// Owned by one scope pass, not global or per-record. The buffers hold at most
/// one validated window each (192 KiB of values, 96 KiB of exponent symbols),
/// so no decompressed corpus is retained here.
pub(crate) struct Decoder {
    zstd: zstd::bulk::Decompressor<'static>,
    values: Vec<f16>,
    exponents: Vec<u8>,
}
impl Decoder {
    pub(crate) fn new() -> Result<Self> {
        Ok(Self {
            zstd: zstd::bulk::Decompressor::new()?,
            values: Vec::new(),
            exponents: Vec::new(),
        })
    }
}

/// Hand out the first `count` slots of one scratch buffer. The buffer only grows
/// to the largest window seen and `count` is already bounded by `MAX_VALUES`, so
/// a shorter window after a longer one neither reallocates nor rewrites the whole
/// span. Callers must use only the returned slice: slots past `count` still hold
/// an earlier window.
fn scratch<T: Clone + Default>(buffer: &mut Vec<T>, count: usize) -> &mut [T] {
    if buffer.len() < count {
        if buffer.capacity() < count {
            // `reserve_exact` takes the number of ADDITIONAL slots.
            buffer.reserve_exact(count - buffer.len());
        }
        buffer.resize(count, T::default());
    }
    &mut buffer[..count]
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
/// Decode into the decoder's bounded scratch and borrow it for this block. A
/// caller must drop the slice before decoding the next window; the borrow
/// checker enforces that without unsafe aliasing.
pub(crate) fn code<'a>(
    stored: &[u8],
    codec: u32,
    count: usize,
    decoder: &'a mut Decoder,
) -> Result<&'a [f16]> {
    if count == 0 || count > MAX_VALUES || count % 48 != 0 {
        return Err(invalid("invalid decoded window geometry").into());
    }
    if codec == 0 {
        if stored.len() != count * 2 {
            return Err(invalid("invalid raw window length").into());
        }
        let values = scratch(&mut decoder.values, count);
        for (value, bytes) in values.iter_mut().zip(stored.chunks_exact(2)) {
            *value = f16::from_bits(u16::from_le_bytes([bytes[0], bytes[1]]));
        }
        return Ok(values);
    }
    let packed_length = count * 11 / 8;
    if codec != 1 || stored.len() <= packed_length || stored.len() >= count * 2 {
        return Err(invalid("invalid lossless window length/codec").into());
    }
    // Disjoint field borrows: the exponent scratch stays readable while values
    // are rebuilt, and both remain owned by this decoder.
    let Decoder {
        zstd,
        values,
        exponents,
    } = decoder;
    let exponents = scratch(exponents, count);
    // The slice exposes exactly `count` slots, so zstd keeps the output bound a
    // fresh allocation had and frame length errors keep their error category.
    let written = zstd
        .decompress_to_buffer(&stored[packed_length..], exponents)
        .map_err(|_| invalid("invalid exponent frame"))?;
    if written != count || exponents.iter().any(|&v| v > 31) {
        return Err(invalid("invalid exponent symbols").into());
    }
    let values = scratch(values, count);
    // Valid geometry is a multiple of 48, so groups of eight values occupy
    // exactly eleven bytes. Reassemble all sixteen bits without FP arithmetic.
    for (group_values, (bytes, symbols)) in values.chunks_exact_mut(8).zip(
        stored[..packed_length]
            .chunks_exact(11)
            .zip(exponents.chunks_exact(8)),
    ) {
        let mut group = [0u8; 16];
        group[..11].copy_from_slice(bytes);
        let bits = u128::from_le_bytes(group);
        for (i, (value, &exponent)) in group_values.iter_mut().zip(symbols).enumerate() {
            let eleven = ((bits >> (11 * i)) & 0x7ff) as u16;
            *value = f16::from_bits(
                (eleven & 0x3ff) | ((eleven & 0x400) << 5) | (u16::from(exponent) << 10),
            );
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
