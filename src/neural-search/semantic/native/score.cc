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
float dot48_scalar(const float* a,const float* b) {
  float result=0;for(size_t d=0;d<48;++d) result+=a[d]*b[d];return result;
}
#if defined(__x86_64__)
__attribute__((target("avx2,f16c"))) float dot48_avx2(const float* a,const float* b) {
  __m256 sum=_mm256_setzero_ps();
  for(size_t d=0;d<48;d+=8) sum=_mm256_add_ps(sum,_mm256_mul_ps(_mm256_loadu_ps(a+d),_mm256_loadu_ps(b+d)));
  alignas(32) float parts[8];_mm256_store_ps(parts,sum);
  float result=0;for(float part:parts) result+=part;return result;
}
#endif
} // namespace

extern "C" SGREP_API sgrep_error sgrep_maxsim_update(const float* query,size_t query_rows,
    const uint16_t* document,size_t document_rows,float* maxima) {
  if(!query || !document || !maxima || !query_rows || query_rows>256 || !document_rows ||
      document_rows>std::numeric_limits<size_t>::max()/48) return SG_INVALID;
  const auto finite = sgrep::finite_checker();
  if (!finite(query, query_rows*48)) return SG_INVALID;
  for(size_t i=0;i<query_rows;++i) if(std::isnan(maxima[i]) || maxima[i]==std::numeric_limits<float>::infinity()) return SG_INVALID;
  auto decode=sgrep::half_decoder();
  auto dot=dot48_scalar;
#if defined(__x86_64__)
  if(__builtin_cpu_supports("avx2") && __builtin_cpu_supports("f16c")) {dot=dot48_avx2;}
#endif
  alignas(32) float tile[64*48];
  for(size_t start=0;start<document_rows;start+=64) {
    const size_t count=std::min<size_t>(64,document_rows-start);
    decode(document+start*48,tile,count*48);
    if (!finite(tile, count*48)) return SG_UNVERIFIED;
    for(size_t q=0;q<query_rows;q+=4) {
      for(size_t d=0;d<count;++d) {
        for(size_t row=q;row<std::min(q+4,query_rows);++row) {
          const float score=dot(query+row*48,tile+d*48);
          if(!std::isfinite(score)) return SG_UNVERIFIED;
          maxima[row]=std::max(maxima[row],score);
        }
      }
    }
  }
  return SG_OK;
}
