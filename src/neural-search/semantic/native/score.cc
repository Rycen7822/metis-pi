#include "include/sgrep_runtime.h"
#include "half.h"
#include "finite.h"
#include <algorithm>
#include <cmath>
#include <limits>
#if defined(__x86_64__)
#include <immintrin.h>
#endif

namespace {
float dot48_scalar(const float* a, const float* b) {
  float result = 0;
  for (size_t d = 0; d < 48; ++d) result += a[d] * b[d];
  return result;
}
#if defined(__x86_64__)
__attribute__((target("avx2,f16c"))) float dot48_avx2(const float* a, const float* b) {
  __m256 sum = _mm256_setzero_ps();
  for (size_t d = 0; d < 48; d += 8) {
    sum = _mm256_add_ps(sum, _mm256_mul_ps(_mm256_loadu_ps(a + d), _mm256_loadu_ps(b + d)));
  }
  alignas(32) float parts[8];
  _mm256_store_ps(parts, sum);
  float result = 0;
  for (float part : parts) result += part;
  return result;
}

// Share document loads across four query rows without changing each dot's lane
// accumulation. Transpose the final stripes to reduce all four rows in one
// 128-bit chain, still adding lanes 0..7 in order from +0.0, bit-identically.
__attribute__((target("avx2,f16c"))) void quad48_avx2(const float* query, const float* document, float* scores) {
  __m256 s0 = _mm256_setzero_ps(), s1 = s0, s2 = s0, s3 = s0;
  for (size_t d = 0; d < 48; d += 8) {
    const __m256 doc = _mm256_loadu_ps(document + d);
    s0 = _mm256_add_ps(s0, _mm256_mul_ps(_mm256_loadu_ps(query + d), doc));
    s1 = _mm256_add_ps(s1, _mm256_mul_ps(_mm256_loadu_ps(query + 48 + d), doc));
    s2 = _mm256_add_ps(s2, _mm256_mul_ps(_mm256_loadu_ps(query + 96 + d), doc));
    s3 = _mm256_add_ps(s3, _mm256_mul_ps(_mm256_loadu_ps(query + 144 + d), doc));
  }
  __m128 low0 = _mm256_castps256_ps128(s0), low1 = _mm256_castps256_ps128(s1);
  __m128 low2 = _mm256_castps256_ps128(s2), low3 = _mm256_castps256_ps128(s3);
  __m128 high0 = _mm256_extractf128_ps(s0, 1), high1 = _mm256_extractf128_ps(s1, 1);
  __m128 high2 = _mm256_extractf128_ps(s2, 1), high3 = _mm256_extractf128_ps(s3, 1);
  _MM_TRANSPOSE4_PS(low0, low1, low2, low3);
  _MM_TRANSPOSE4_PS(high0, high1, high2, high3);
  const __m128 stripes[8] = {low0, low1, low2, low3, high0, high1, high2, high3};
  __m128 total = _mm_setzero_ps();
  for (const __m128 stripe : stripes) total = _mm_add_ps(total, stripe);
  _mm_storeu_ps(scores, total);
}
#endif
} // namespace

extern "C" SGREP_API sgrep_error sgrep_maxsim_update(const float* query, size_t query_rows,
    const uint16_t* document, size_t document_rows, float* maxima) {
  if (!query || !document || !maxima || !query_rows || query_rows > 256 || !document_rows ||
      document_rows > std::numeric_limits<size_t>::max() / 48) return SG_INVALID;
  const auto finite = sgrep::finite_checker();
  if (!finite(query, query_rows * 48)) return SG_INVALID;
  for (size_t i = 0; i < query_rows; ++i) {
    if (std::isnan(maxima[i]) || maxima[i] == std::numeric_limits<float>::infinity()) return SG_INVALID;
  }
  auto decode = sgrep::half_decoder();
  auto dot = dot48_scalar;
  bool quad = false;
#if defined(__x86_64__)
  if (__builtin_cpu_supports("avx2") && __builtin_cpu_supports("f16c")) {
    dot = dot48_avx2;
    quad = true;
  }
#endif
  alignas(32) float tile[64 * 48];
  for (size_t start = 0; start < document_rows; start += 64) {
    const size_t count = std::min<size_t>(64, document_rows - start);
    decode(document + start * 48, tile, count * 48);
    if (!finite(tile, count * 48)) return SG_UNVERIFIED;
    size_t q = 0;
#if defined(__x86_64__)
    // Preserve q-then-document traversal and row-wise stores, including the
    // maxima prefix left behind when a later dot overflows.
    if (quad) {
      for (; q + 4 <= query_rows; q += 4) {
        for (size_t d = 0; d < count; ++d) {
          float scores[4];
          quad48_avx2(query + q * 48, tile + d * 48, scores);
          for (size_t row = 0; row < 4; ++row) {
            if (!std::isfinite(scores[row])) return SG_UNVERIFIED;
            maxima[q + row] = std::max(maxima[q + row], scores[row]);
          }
        }
      }
    }
#endif
    for (; q < query_rows; q += 4) {
      for (size_t d = 0; d < count; ++d) {
        for (size_t row = q; row < std::min(q + 4, query_rows); ++row) {
          const float score = dot(query + row * 48, tile + d * 48);
          if (!std::isfinite(score)) return SG_UNVERIFIED;
          maxima[row] = std::max(maxima[row], score);
        }
      }
    }
  }
  return SG_OK;
}
