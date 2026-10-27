#include "custom_ops.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <vector>
#if defined(__x86_64__)
#include <immintrin.h>
#endif

extern "C" void OrtSgrepTraceMarker(const char*,uint64_t);

namespace sgrep {
namespace {
void require(bool condition, const char* message) {
  if (!condition) throw Ort::Exception(message, ORT_INVALID_ARGUMENT);
}
void observe_scratch(KernelState& state, size_t bytes) {
  auto peak = state.scratch_peak.load();
  while (peak < bytes && !state.scratch_peak.compare_exchange_weak(peak, bytes)) {}
}
void cancelled(const KernelState& state) {
  if (state.cancelled.load()) throw Ort::Exception("SGREP: cancelled", ORT_FAIL);
}
template<class F> void parallel(Ort::KernelContext& ctx, size_t work, KernelState& state, F fn) {
  const size_t jobs = std::min<size_t>(state.threads, work);
  if (!jobs) return;
  auto task = [&](size_t rank) {
    for (size_t i = rank; i < work && !state.cancelled.load(); i += jobs) fn(i, rank);
  };
  ctx.ParallelFor([](void* opaque, size_t rank) { (*static_cast<decltype(task)*>(opaque))(rank); },
                  jobs, 0, &task);
  cancelled(state);
}
std::vector<int64_t> shape(const Ort::ConstValue& value) {
  return value.GetTensorTypeAndShapeInfo().GetShape();
}
float dot64_scalar(const float* a, const float* b) {
  float sum = 0;
  for (size_t d = 0; d < 64; ++d) sum += a[d] * b[d];
  return sum;
}
#if defined(__x86_64__)
__attribute__((target("avx2"))) float dot64_avx2(const float* a, const float* b) {
  __m256 sum = _mm256_setzero_ps();
  for (size_t d = 0; d < 64; d += 8)
    sum = _mm256_add_ps(sum, _mm256_mul_ps(_mm256_loadu_ps(a+d), _mm256_loadu_ps(b+d)));
  alignas(32) float parts[8]; _mm256_store_ps(parts, sum);
  float result = 0;
  for (float value : parts) result += value;
  return result;
}
#endif
float dot64(const float* a, const float* b) {
#if defined(__x86_64__)
  if (__builtin_cpu_supports("avx2")) return dot64_avx2(a, b);
#endif
  return dot64_scalar(a, b);
}
void normalize256(const float* input, const float* gamma, float* output) {
  float mean = 0;
  for (size_t d = 0; d < 256; ++d) mean += input[d];
  mean /= 256.0f;
  float variance = 0;
  for (size_t d = 0; d < 256; ++d) {
    const float delta = input[d] - mean;
    variance += delta * delta;
  }
  const float inverse = 1.0f / std::sqrt(variance / 256.0f + 1e-5f);
  for (size_t d = 0; d < 256; ++d) output[d] = (input[d] - mean) * inverse * gamma[d];
}
} // namespace

struct Kernel {
  Kind kind;
  KernelState* state;
  Ort::Op matmul{nullptr};
  Kernel(const CustomOp& op, const OrtKernelInfo* info) : kind(op.kind), state(op.state) {
    if (kind == Kind::Output) {
      const char* names[] = {"T"};
      const ONNXTensorElementDataType types[] = {ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT};
      matmul = Ort::Op::Create(info, "MatMul", "", 13, names, types, 1, nullptr, 0, 2, 1);
    }
  }
  void rope(Ort::KernelContext& ctx) {
    auto input = ctx.GetInput(0), cosine = ctx.GetInput(1), sine = ctx.GetInput(2);
    const auto dimensions = shape(input);
    require(dimensions.size() == 2 && dimensions[1] == 768 && dimensions[0] > 0 && dimensions[0] <= 2048, "invalid RoPE QKV");
    require(shape(cosine) == std::vector<int64_t>({2048,64}) && shape(sine) == shape(cosine), "invalid RoPE table");
    const size_t length = dimensions[0];
    const int64_t output_shape[] = {1, static_cast<int64_t>(length), 256};
    float* outputs[3];
    for (size_t i = 0; i < 3; ++i) outputs[i] = ctx.GetOutput(i, output_shape, 3).GetTensorMutableData<float>();
    const float* values = input.GetTensorData<float>();
    OrtSgrepTraceMarker("rope_raw_ptr",reinterpret_cast<uintptr_t>(values));
    OrtSgrepTraceMarker("rope_q_ptr",reinterpret_cast<uintptr_t>(outputs[0]));
    OrtSgrepTraceMarker("rope_k_ptr",reinterpret_cast<uintptr_t>(outputs[1]));
    OrtSgrepTraceMarker("rope_v_ptr",reinterpret_cast<uintptr_t>(outputs[2]));
    const float* cos = cosine.GetTensorData<float>();
    const float* sin = sine.GetTensorData<float>();
    parallel(ctx, length, *state, [&](size_t row, size_t) {
      for (size_t part = 0; part < 3; ++part) {
        for (size_t head = 0; head < 4; ++head) {
          for (size_t d = 0; d < 64; ++d) {
            float value = values[row*768+part*256+head*64+d];
            if (part < 2) {
              const size_t other = d < 32 ? d+32 : d-32;
              const float rotated = values[row*768+part*256+head*64+other] * (d < 32 ? -1.0f : 1.0f);
              value = value*cos[row*64+d] + rotated*sin[row*64+d];
            }
            outputs[part][row*256+head*64+d] = value;
          }
        }
      }
    });
  }
  void local(Ort::KernelContext& ctx) {
    auto query = ctx.GetInput(0), key = ctx.GetInput(1), value = ctx.GetInput(2);
    const auto dimensions = shape(query);
    require(dimensions.size()==3 && dimensions[0]==1 && dimensions[2]==256 && dimensions[1]>0 && dimensions[1]<=2048, "invalid local attention shape");
    require(shape(key)==dimensions && shape(value)==dimensions, "local Q/K/V shape mismatch");
    const size_t length = dimensions[1], blocks = (length+31)/32, work = 4*blocks;
    const size_t jobs = std::min<size_t>(state->threads, work);
    const size_t scratch_bytes = jobs * 32 * 160 * sizeof(float);
    auto memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    auto allocator = ctx.GetAllocator(*memory_info);
    auto allocation = allocator.GetAllocation(scratch_bytes);
    observe_scratch(*state, scratch_bytes);
    float* scratch = static_cast<float*>(allocation.get());
    const float* q = query.GetTensorData<float>(), *k = key.GetTensorData<float>(), *v = value.GetTensorData<float>();
    float* out = ctx.GetOutput(0, dimensions).GetTensorMutableData<float>();
    parallel(ctx, work, *state, [&](size_t block, size_t rank) {
      const size_t head = block/blocks, begin = (block%blocks)*32, end = std::min(begin+32, length);
      float* scores = scratch + rank*32*160;
      for (size_t row = begin; row < end && !state->cancelled.load(); ++row) {
        const size_t low = row > 64 ? row-64 : 0, high = std::min(length, row+65);
        float* row_scores = scores+(row-begin)*160;
        float maximum = -std::numeric_limits<float>::infinity();
        for (size_t j = low; j < high; ++j) {
          const float score = dot64(q+row*256+head*64, k+j*256+head*64)*0.125f;
          row_scores[j-low] = score; maximum = std::max(maximum, score);
        }
        // The entire <=129-key window fits one K tile. This is the first
        // online-softmax update (m=-inf, alpha=0), never a full LxL score.
        float denominator = 0;
        for (size_t j=low; j<high; ++j) { row_scores[j-low]=std::exp(row_scores[j-low]-maximum); denominator+=row_scores[j-low]; }
        float* result=out+row*256+head*64;
        std::fill(result,result+64,0.0f);
        for (size_t j=low; j<high; ++j)
          for (size_t d=0; d<64; ++d) result[d]+=row_scores[j-low]*v[j*256+head*64+d];
        for (size_t d=0; d<64; ++d) result[d]/=denominator;
      }
    });
    state->local_calls.fetch_add(1);
  }
  void residual_norm(Ort::KernelContext& ctx) {
    auto skip=ctx.GetInput(0), addition=ctx.GetInput(1), gamma=ctx.GetInput(2);
    const auto dimensions=shape(skip);
    require(dimensions.size()==2 && dimensions[1]==256 && shape(addition)==dimensions && shape(gamma)==std::vector<int64_t>({256}), "invalid residual/LN shape");
    const float* a=skip.GetTensorData<float>(), *b=addition.GetTensorData<float>(), *g=gamma.GetTensorData<float>();
    float* residual=ctx.GetOutput(0,dimensions).GetTensorMutableData<float>();
    float* normalized=ctx.GetOutput(1,dimensions).GetTensorMutableData<float>();
    parallel(ctx,dimensions[0],*state,[&](size_t row,size_t) {
      for (size_t d=0; d<256; ++d) residual[row*256+d]=a[row*256+d]+b[row*256+d];
      normalize256(residual+row*256,g,normalized+row*256);
    });
  }
  void geglu(Ort::KernelContext& ctx) {
    auto input=ctx.GetInput(0);
    const auto dimensions=shape(input);
    require(dimensions.size()==2 && dimensions[1]==768, "invalid GeGLU shape");
    const int64_t out_shape[]={dimensions[0],384};
    const float* in=input.GetTensorData<float>();
    float* out=ctx.GetOutput(0,out_shape,2).GetTensorMutableData<float>();
    parallel(ctx,dimensions[0],*state,[&](size_t row,size_t) {
      for (size_t d=0; d<384; ++d) {
        const float x=in[row*768+d];
        out[row*384+d]=(0.5f*x*(1.0f+std::erf(x*0.7071067811865475244f)))*in[row*768+384+d];
      }
    });
  }
  void output(Ort::KernelContext& ctx) {
    auto hidden=ctx.GetInput(0), rows=ctx.GetInput(1), gamma=ctx.GetInput(2), weight=ctx.GetInput(3);
    const auto dimensions=shape(hidden), row_shape=shape(rows);
    require(dimensions.size()==2 && dimensions[1]==256 && row_shape.size()==1 && row_shape[0]>0, "invalid output rows");
    require(shape(gamma)==std::vector<int64_t>({256}) && shape(weight)==std::vector<int64_t>({256,48}), "invalid output projection");
    const int64_t* indices=rows.GetTensorData<int64_t>();
    const size_t count=row_shape[0];
    for (size_t i=0; i<count; ++i) require(indices[i]>=0 && indices[i]<dimensions[0],"output row out of range");
    auto memory_info=Ort::MemoryInfo::CreateCpu(OrtArenaAllocator,OrtMemTypeDefault);
    auto allocator=ctx.GetAllocator(*memory_info);
    const size_t bytes=count*256*sizeof(float);
    auto allocation=allocator.GetAllocation(bytes);
    observe_scratch(*state,bytes);
    float* normalized=static_cast<float*>(allocation.get());
    const float* x=hidden.GetTensorData<float>(), *g=gamma.GetTensorData<float>();
    parallel(ctx,count,*state,[&](size_t row,size_t) { normalize256(x+indices[row]*256,g,normalized+row*256); });
    const int64_t normalized_shape[]={static_cast<int64_t>(count),256};
    auto matrix=Ort::Value::CreateTensor<float>(memory_info,normalized,count*256,normalized_shape,2);
    const int64_t out_shape[]={static_cast<int64_t>(count),48};
    auto out_value=ctx.GetOutput(0,out_shape,2);
    const OrtValue* inputs[]={matrix,weight};
    OrtValue* outputs[]={out_value};
    // Invoke the fixed ORT CPU MatMul kernel/MLAS and its existing pool.
    // This is not a private packed-layout ABI or a new GEMM implementation.
    matmul.Invoke(ctx.GetOrtKernelContext(),inputs,2,outputs,1);
    float* vectors=out_value.GetTensorMutableData<float>();
    parallel(ctx,count,*state,[&](size_t row,size_t) {
      float norm=0;
      for(size_t d=0;d<48;++d) norm+=vectors[row*48+d]*vectors[row*48+d];
      norm=std::max(std::sqrt(norm),1e-12f);
      for(size_t d=0;d<48;++d) vectors[row*48+d]/=norm;
    });
  }
  OrtStatus* ComputeV2(OrtKernelContext* context) noexcept {
    try {
      cancelled(*state);
      Ort::KernelContext ctx(context);
      switch(kind) {
        case Kind::Rope: rope(ctx); break;
        case Kind::LocalAttention: local(ctx); break;
        case Kind::ResidualNorm: residual_norm(ctx); break;
        case Kind::GeGLU: geglu(ctx); break;
        case Kind::Output: output(ctx); break;
      }
      return nullptr;
    } catch(const Ort::Exception& error) { return Ort::GetApi().CreateStatus(error.GetOrtErrorCode(),error.what()); }
      catch(const std::exception& error) { return Ort::GetApi().CreateStatus(ORT_FAIL,error.what()); }
  }
};

CustomOp::CustomOp(Kind value,KernelState* owner):kind(value),state(owner) {}
const char* CustomOp::GetName() const {
  constexpr const char* names[]={"SgrepRopePackF32","SgrepLocalAttentionF32","SgrepResidualNormF32","SgrepGeGLUF32","SgrepOutputF32"};
  return names[static_cast<unsigned>(kind)];
}
size_t CustomOp::GetInputTypeCount() const { return kind==Kind::Output?4:kind==Kind::GeGLU?1:3; }
size_t CustomOp::GetOutputTypeCount() const { return kind==Kind::Rope?3:kind==Kind::ResidualNorm?2:1; }
ONNXTensorElementDataType CustomOp::GetInputType(size_t index) const {
  return kind==Kind::Output && index==1?ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64:ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
}
OrtStatus* CustomOp::CreateKernelV2(const OrtApi& api,const OrtKernelInfo* info,void** out) const noexcept {
  try { *out=new Kernel(*this,info); return nullptr; }
  catch(const Ort::Exception& error) { return api.CreateStatus(error.GetOrtErrorCode(),error.what()); }
  catch(const std::exception& error) { return api.CreateStatus(ORT_FAIL,error.what()); }
}
} // namespace sgrep
