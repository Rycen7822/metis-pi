//! Lossless storage only. All sixteen FP16 bits survive; this is not quantization.
//! A decoder owns at most one 2048x48 window and bounded metadata, never a scope.
use crate::{
    Result,
    semantic::{CODE_EMBEDDING_DIMENSION, MAX_CODE_WINDOW_TOKENS},
};
use half::f16;
use std::{borrow::Cow, io};

// Separate bounds for one decoded record and the complete scope snapshot.
const MAX_METADATA: usize = 8 * 1024 * 1024;
const MAX_VALUES: usize = MAX_CODE_WINDOW_TOKENS * CODE_EMBEDDING_DIMENSION;
const MAX_SCOPE_METADATA: usize = 128 * 1024 * 1024;

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
// Lossless FP16: sign + ten fraction bits form an 11-bit symbol; the five
// exponent bits are compressed separately. Eight symbols occupy 11 bytes.
pub(crate) fn pack_code(values: &[f16]) -> Result<Option<Vec<u8>>> {
    if values.is_empty()
        || values.len() > MAX_VALUES
        || values.len() % CODE_EMBEDDING_DIMENSION != 0
    {
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
    if count == 0 || count > MAX_VALUES || count % CODE_EMBEDDING_DIMENSION != 0 {
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
    unpack(&stored[..packed_length], exponents, values);
    Ok(values)
}

/// Rebuild validated FP16 words without floating-point arithmetic.
/// The runtime-dispatched prefix leaves the last group for the scalar tail.
fn unpack(packed: &[u8], exponents: &[u8], values: &mut [f16]) {
    debug_assert_eq!(values.len(), exponents.len());
    debug_assert_eq!(packed.len(), values.len() / 8 * 11);
    let done = vector_prefix(packed, exponents, values);
    unpack_scalar(
        &packed[done / 8 * 11..],
        &exponents[done..],
        &mut values[done..],
    );
}

/// Values rebuilt by the vector kernel: a multiple of eight, or zero when the
/// kernel is unavailable and the scalar helper must do every group.
#[cfg(target_arch = "x86_64")]
fn vector_prefix(packed: &[u8], exponents: &[u8], values: &mut [f16]) -> usize {
    if std::is_x86_feature_detected!("avx2") {
        // SAFETY: runtime feature detection; every access is bounded by slices.
        unsafe { unpack_avx2(packed, exponents, values) }
    } else {
        0
    }
}
#[cfg(not(target_arch = "x86_64"))]
fn vector_prefix(_packed: &[u8], _exponents: &[u8], _values: &mut [f16]) -> usize {
    0
}

/// Groups of eight values occupy exactly eleven bytes. Reassemble all sixteen
/// bits without FP arithmetic; this is also the tail of the vector path.
fn unpack_scalar(packed: &[u8], exponents: &[u8], values: &mut [f16]) {
    for (group_values, (bytes, symbols)) in values
        .chunks_exact_mut(8)
        .zip(packed.chunks_exact(11).zip(exponents.chunks_exact(8)))
    {
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
}

/// Rebuild eight values per step from one eleven-byte group. The 16-byte load
/// takes the five following bytes as slack, so a step needs one whole further
/// group and the last group always stays with the scalar helper.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn unpack_avx2(packed: &[u8], exponents: &[u8], values: &mut [f16]) -> usize {
    use std::arch::x86_64::*;
    // Field k starts at bit 11k, i.e. inside bytes 11k/8 and 11k/8+1; -1 clears
    // the bits belonging to its neighbours.
    const FIELD_BYTES: [i8; 32] = [
        0, 1, -1, -1, 1, 2, -1, -1, 2, 3, 4, -1, 4, 5, -1, -1, 5, 6, -1, -1, 6, 7, 8, -1, 8, 9, -1,
        -1, 9, 10, -1, -1,
    ];
    // Field k sits eleven bits into its lane and is shifted down by 11k mod 8,
    // which clears the slack bits the byte shuffle copied around it.
    let shifts = _mm256_setr_epi32(0, 3, 6, 1, 4, 7, 2, 5);
    // The prefix stops one group short, so both loads and the store stay inside
    // the slices even when the caller's lengths were not what the header claims.
    let usable = (values.len() / 8)
        .min(packed.len() / 11)
        .min(exponents.len() / 8);
    let steps = usable.saturating_sub(1);
    if steps == 0 {
        return 0;
    }
    let mantissa = _mm256_set1_epi32(0x3ff);
    let sign = _mm256_set1_epi32(0x400);
    unsafe {
        let shuffle = _mm256_loadu_si256(FIELD_BYTES.as_ptr().cast());
        for step in 0..steps {
            let at = step * 8;
            let bytes = _mm_loadu_si128(packed.as_ptr().add(step * 11).cast());
            let fields = _mm256_shuffle_epi8(_mm256_broadcastsi128_si256(bytes), shuffle);
            let fields = _mm256_srlv_epi32(fields, shifts);
            let symbols = _mm_loadl_epi64(exponents.as_ptr().add(at).cast());
            let symbols = _mm256_slli_epi32(_mm256_cvtepu8_epi32(symbols), 10);
            let signs = _mm256_slli_epi32(_mm256_and_si256(fields, sign), 5);
            let words = _mm256_or_si256(
                _mm256_and_si256(fields, mantissa),
                _mm256_or_si256(signs, symbols),
            );
            // Every lane holds at most 0xffff, so the unsigned pack is exact.
            let halves = _mm_packus_epi32(
                _mm256_castsi256_si128(words),
                _mm256_extracti128_si256(words, 1),
            );
            _mm_storeu_si128(values.as_mut_ptr().add(at).cast(), halves);
        }
    }
    steps * 8
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
