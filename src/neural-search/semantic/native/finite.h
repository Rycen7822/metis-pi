#pragma once
#include <cmath>
#include <cstddef>
#if defined(__x86_64__)
#include <immintrin.h>
#endif

namespace sgrep {
inline bool finite_scalar(const float* values, size_t count) {
  for (size_t i = 0; i < count; ++i) if (!std::isfinite(values[i])) return false;
  return true;
}
#if defined(__x86_64__)
__attribute__((target("avx2"))) inline bool finite_avx2(const float* values, size_t count) {
  const __m256i magnitude = _mm256_set1_epi32(0x7fffffff);
  const __m256i largest = _mm256_set1_epi32(0x7f7fffff);
  size_t i = 0;
  for (; i + 8 <= count; i += 8) {
    const __m256i bits = _mm256_castps_si256(_mm256_loadu_ps(values + i));
    if (_mm256_movemask_epi8(_mm256_cmpgt_epi32(_mm256_and_si256(bits, magnitude), largest))) return false;
  }
  return finite_scalar(values + i, count - i);
}
#endif
using Finite = bool (*)(const float*, size_t);
inline Finite finite_checker() {
#if defined(__x86_64__)
  if (__builtin_cpu_supports("avx2")) return finite_avx2;
#endif
  return finite_scalar;
}
} // namespace sgrep
