#[inline]
pub fn ascii_swap_case(b: u8) -> u8 {
    b ^ 0x20
}

#[inline]
fn eq_lowered_scalar(h: *const u8, needle_lower: &[u8]) -> bool {
    for (i, &n) in needle_lower.iter().enumerate() {
        if unsafe { *h.add(i) }.to_ascii_lowercase() != n {
            return false;
        }
    }
    true
}

/// AVX2 only has a **signed** byte compare (`cmpgt`), but we need an
/// **unsigned** range check (`'A' <= byte <= 'Z'`). XOR-ing every byte with
/// `0x80` maps the unsigned range `[0, 255]` into the signed range
/// `[-128, 127]` preserving order, so signed `cmpgt` becomes correct
#[target_feature(enable = "avx2")]
unsafe fn eq_lowered_avx2(h: *const u8, needle_lower: &[u8]) -> bool {
    use core::arch::x86_64::*;

    let len = needle_lower.len();
    let mut i = 0usize;

    let flip = _mm256_set1_epi8(0x80u8 as i8);
    let a_minus_1 = _mm256_set1_epi8((b'A' - 1) as i8 ^ 0x80u8 as i8);
    let z_plus_1 = _mm256_set1_epi8((b'Z' + 1) as i8 ^ 0x80u8 as i8);
    let bit20 = _mm256_set1_epi8(0x20u8 as i8);

    while i + 32 <= len {
        let hv = unsafe { _mm256_loadu_si256(h.add(i) as *const __m256i) };
        let nv = unsafe { _mm256_loadu_si256(needle_lower.as_ptr().add(i) as *const __m256i) };

        // Signed-domain range check selects uppercase lanes, OR bit 5 folds them.
        let x = _mm256_xor_si256(hv, flip);
        let ge_a = _mm256_cmpgt_epi8(x, a_minus_1);
        let le_z = _mm256_cmpgt_epi8(z_plus_1, x);
        let upper = _mm256_and_si256(ge_a, le_z);
        let folded = _mm256_or_si256(hv, _mm256_and_si256(upper, bit20));

        let eq = _mm256_cmpeq_epi8(folded, nv);
        if _mm256_movemask_epi8(eq) != -1i32 {
            return false;
        }

        i += 32;
    }

    while i < len {
        if unsafe { *h.add(i) }.to_ascii_lowercase() != needle_lower[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// Case-insensitive equality of `needle_lower` against the haystack bytes
/// starting at `h`. `needle_lower` must be pre-lowercased (ASCII).
///
/// # Safety
/// `h` must be valid for reads of `needle_lower.len()` bytes.
#[inline]
pub(crate) unsafe fn eq_lowered_case(haystack: *const u8, needle_lower: &[u8]) -> bool {
    if needle_lower.len() >= 32 && std::is_x86_feature_detected!("avx2") {
        return unsafe { eq_lowered_avx2(haystack, needle_lower) };
    }

    eq_lowered_scalar(haystack, needle_lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eq_lowered(haystack: &[u8], needle_lower: &[u8]) -> bool {
        assert!(haystack.len() >= needle_lower.len());
        unsafe { eq_lowered_case(haystack.as_ptr(), needle_lower) }
    }

    #[test]
    fn swap_case_toggles_letters() {
        assert_eq!(ascii_swap_case(b'n'), b'N');
        assert_eq!(ascii_swap_case(b'N'), b'n');
        assert_eq!(ascii_swap_case(b'z'), b'Z');
    }

    #[test]
    fn eq_matches_std_semantics() {
        assert!(eq_lowered(b"Hello", b"hello"));
        assert!(eq_lowered(b"HELLO WORLD", b"hello"));
        assert!(!eq_lowered(b"Hellp", b"hello"));
        // Non-letters must not fold: '[' (0x5B) vs '{' (0x7B) differ only in bit 5.
        assert!(!eq_lowered(b"A[", b"a{"));
        assert!(eq_lowered(b"A{", b"a{"));
        // Long inputs exercise the SIMD kernels.
        let hay = b"INT STRUCT MUTEX *LOCK(STRUCT MUTEX *LOCK) { RETURN 0; }";
        let needle: Vec<u8> = hay.iter().map(|b| b.to_ascii_lowercase()).collect();
        assert!(eq_lowered(hay, &needle));
        let mut bad = needle.clone();
        *bad.last_mut().unwrap() = b'!';
        assert!(!eq_lowered(hay, &bad));
    }
}
