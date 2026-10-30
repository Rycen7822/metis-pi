#ifndef SGREP_HALF_H
#define SGREP_HALF_H
#include <cstddef>
#include <cstdint>
#include <cstring>
#if defined(__x86_64__)
#include <immintrin.h>
#endif

namespace sgrep {
// The same IEEE half decoder serves pre-LN rows and cached MaxSim tiles.
// Arithmetic remains FP32; F16C only expands the stored representation.
inline float half_scalar(uint16_t value) {
  const uint32_t sign=static_cast<uint32_t>(value&0x8000)<<16;
  const uint32_t exponent=(value>>10)&31;
  uint32_t fraction=value&1023,bits;
  if(exponent==0) {
    if(!fraction) bits=sign;
    else {
      int power=-14;
      while(!(fraction&1024)) {fraction<<=1;--power;}
      bits=sign|(static_cast<uint32_t>(power+127)<<23)|((fraction&1023)<<13);
    }
  } else if(exponent==31) bits=sign|0x7f800000|(fraction<<13);
  else bits=sign|((exponent+112)<<23)|(fraction<<13);
  float result;std::memcpy(&result,&bits,4);return result;
}
inline void decode_half_scalar(const uint16_t* source,float* target,size_t values) {
  for(size_t i=0;i<values;++i) target[i]=half_scalar(source[i]);
}
#if defined(__x86_64__)
__attribute__((target("avx2,f16c"))) inline void decode_half_avx2(const uint16_t* source,float* target,size_t values) {
  size_t i=0;
  for(;i+8<=values;i+=8)
    _mm256_storeu_ps(target+i,_mm256_cvtph_ps(_mm_loadu_si128(reinterpret_cast<const __m128i*>(source+i))));
  decode_half_scalar(source+i,target+i,values-i);
}
#endif
using HalfDecoder=void(*)(const uint16_t*,float*,size_t);
inline HalfDecoder half_decoder() {
#if defined(__x86_64__)
  if(__builtin_cpu_supports("avx2") && __builtin_cpu_supports("f16c")) return decode_half_avx2;
#endif
  return decode_half_scalar;
}
} // namespace sgrep
#endif
