#include "custom_ops.h"
#include "include/sgrep_runtime.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
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
struct SequenceBounds {
  const int64_t* offsets;
  size_t count;
  std::pair<size_t, size_t> containing(size_t row) const {
    const auto* end = std::upper_bound(offsets+1, offsets+count, static_cast<int64_t>(row));
    return {static_cast<size_t>(end[-1]), static_cast<size_t>(*end)};
  }
};
SequenceBounds sequence_bounds(Ort::KernelContext& ctx, size_t input_index, size_t length) {
  auto input = ctx.GetInput(input_index);
  const auto dimensions = shape(input);
  require(dimensions.size() == 1 && dimensions[0] >= 2 && dimensions[0] <= SGREP_MAX_BATCH_WINDOWS+1, "invalid sequence count");
  const auto* offsets = input.GetTensorData<int64_t>();
  const size_t count = static_cast<size_t>(dimensions[0]);
  require(offsets[0] == 0 && offsets[count-1] == static_cast<int64_t>(length), "invalid sequence extent");
  for (size_t index = 1; index < count; ++index)
    require(offsets[index] > offsets[index-1], "empty or unordered sequence");
  return {offsets, count};
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
#if defined(__x86_64__)
__attribute__((target("avx2"), noinline))
void local_pv_avx2(const float* values, const float* weights, size_t low,
                  size_t high, size_t head, float denominator, float* out) {
  __m256 sums[8];
  for (auto& sum : sums) sum = _mm256_setzero_ps();
  for (size_t j = low; j < high; ++j) {
    const __m256 p = _mm256_set1_ps(weights[j-low]);
    const float* row = values+j*256+head*64;
    for (size_t d = 0; d < 8; ++d)
      sums[d] = _mm256_add_ps(sums[d], _mm256_mul_ps(p, _mm256_loadu_ps(row+d*8)));
  }
  const __m256 scale = _mm256_set1_ps(denominator);
  for (size_t d = 0; d < 8; ++d)
    _mm256_storeu_ps(out+d*8, _mm256_div_ps(sums[d],scale));
}
#endif
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
#if defined(__x86_64__)
constexpr size_t NORMALIZATION_GROUP_ROWS = 4; // One independent row per SSE lane.
// Measured coarse cutoff for residual/LN only; larger jobs retain the existing ORT pool.
constexpr size_t RESIDUAL_NORM_CALLER_MAX_ROWS = 128;

void normalize_four_rows(const float* input, const float* gamma, float* output) {
  constexpr size_t features = 256; // Fixed LateOn hidden width.
  const float* rows[] = {input, input+features, input+2*features, input+3*features};
  __m128 mean = _mm_setzero_ps();
  for (size_t column = 0; column < features; column += 4) {
    __m128 v0 = _mm_loadu_ps(rows[0]+column), v1 = _mm_loadu_ps(rows[1]+column);
    __m128 v2 = _mm_loadu_ps(rows[2]+column), v3 = _mm_loadu_ps(rows[3]+column);
    _MM_TRANSPOSE4_PS(v0, v1, v2, v3);
    // Each lane follows the original column order; no horizontal reduction or FMA.
    mean = _mm_add_ps(_mm_add_ps(_mm_add_ps(_mm_add_ps(mean, v0), v1), v2), v3);
  }
  mean = _mm_div_ps(mean, _mm_set1_ps(features));
  __m128 variance = _mm_setzero_ps();
  for (size_t column = 0; column < features; column += 4) {
    __m128 v0 = _mm_loadu_ps(rows[0]+column), v1 = _mm_loadu_ps(rows[1]+column);
    __m128 v2 = _mm_loadu_ps(rows[2]+column), v3 = _mm_loadu_ps(rows[3]+column);
    _MM_TRANSPOSE4_PS(v0, v1, v2, v3);
    for (__m128 values : {v0, v1, v2, v3}) {
      const __m128 delta = _mm_sub_ps(values, mean);
      variance = _mm_add_ps(variance, _mm_mul_ps(delta, delta));
    }
  }
  const __m128 denominator = _mm_add_ps(_mm_div_ps(variance, _mm_set1_ps(features)), _mm_set1_ps(1e-5f));
  const __m128 inverse = _mm_div_ps(_mm_set1_ps(1.0f), _mm_sqrt_ps(denominator));
  alignas(16) float means[NORMALIZATION_GROUP_ROWS], inverses[NORMALIZATION_GROUP_ROWS];
  _mm_store_ps(means, mean);
  _mm_store_ps(inverses, inverse);
  for (size_t row = 0; row < NORMALIZATION_GROUP_ROWS; ++row) {
    const __m128 mu = _mm_set1_ps(means[row]), scale = _mm_set1_ps(inverses[row]);
    for (size_t column = 0; column < features; column += 4) {
      const __m128 centered = _mm_sub_ps(_mm_loadu_ps(rows[row]+column), mu);
      _mm_storeu_ps(output+row*features+column, _mm_mul_ps(_mm_mul_ps(centered, scale), _mm_loadu_ps(gamma+column)));
    }
  }
}
#endif
} // namespace

struct Kernel {
  Kind kind;
  KernelState* state;
  Ort::Op matmul{nullptr}, erf{nullptr}, attention{nullptr};
  Kernel(const CustomOp& op, const OrtKernelInfo* info) : kind(op.kind), state(op.state) {
    if (kind == Kind::GeGLU) {
      const char* names[] = {"T"};
      const ONNXTensorElementDataType types[] = {ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT};
      try {
        erf = Ort::Op::Create(info, "Erf", "", 13, names, types, 1, nullptr, 0, 1, 1);
      } catch (const Ort::Exception& error) {
        throw std::runtime_error(std::string("ORT CPU Erf kernel required (ort-required-operators.config): ") + error.what());
      }
    }
    if (kind == Kind::GlobalAttention) {
      const char* names[] = {"T"};
      const ONNXTensorElementDataType types[] = {ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT};
      const int64_t heads = 4, causal = 0; // Original exported MHA attributes.
      const Ort::OpAttr attributes[] = {
        Ort::OpAttr("num_heads", &heads, 1, ORT_OP_ATTR_INT),
        Ort::OpAttr("unidirectional", &causal, 1, ORT_OP_ATTR_INT)
      };
      attention = Ort::Op::Create(info, "MultiHeadAttention", "com.microsoft", 1, names, types, 1, attributes, 2, 3, 1);
    }
    if (kind == Kind::Output) {
      const char* names[] = {"T"};
      const ONNXTensorElementDataType types[] = {ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT};
      matmul = Ort::Op::Create(info, "MatMul", "", 13, names, types, 1, nullptr, 0, 2, 1);
    }
  }
  void rope(Ort::KernelContext& ctx) {
    auto input = ctx.GetInput(0), cosine = ctx.GetInput(1), sine = ctx.GetInput(2);
    const auto dimensions = shape(input);
    require(dimensions.size() == 2 && dimensions[1] == 768 && dimensions[0] > 0 && dimensions[0] <= SGREP_MAX_WINDOW_TOKENS, "invalid RoPE QKV");
    require(shape(cosine) == std::vector<int64_t>({2048,64}) && shape(sine) == shape(cosine), "invalid RoPE table");
    const size_t length = dimensions[0];
    const auto sequences = sequence_bounds(ctx, 3, length);
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
      const size_t position = row-sequences.containing(row).first;
      for (size_t part = 0; part < 3; ++part) {
        for (size_t head = 0; head < 4; ++head) {
          for (size_t d = 0; d < 64; ++d) {
            float value = values[row*768+part*256+head*64+d];
            if (part < 2) {
              const size_t other = d < 32 ? d+32 : d-32;
              const float rotated = values[row*768+part*256+head*64+other] * (d < 32 ? -1.0f : 1.0f);
              value = value*cos[position*64+d] + rotated*sin[position*64+d];
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
    require(dimensions.size()==3 && dimensions[0]==1 && dimensions[2]==256 &&
      dimensions[1]>0 && dimensions[1]<=SGREP_MAX_WINDOW_TOKENS, "invalid local attention shape");
    require(shape(key)==dimensions && shape(value)==dimensions, "local Q/K/V shape mismatch");
    const size_t length = dimensions[1], blocks = (length+31)/32, work = 4*blocks;
    const auto sequences = sequence_bounds(ctx, 3, length);
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
        const auto bounds = sequences.containing(row);
        const size_t low = std::max(bounds.first, row > 64 ? row-64 : 0);
        const size_t high = std::min(bounds.second, row+65);
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
#if defined(__x86_64__)
        if (__builtin_cpu_supports("avx2")) {
          local_pv_avx2(v,row_scores,low,high,head,denominator,result);
        } else
#endif
        {
          std::fill(result,result+64,0.0f);
          for (size_t j=low; j<high; ++j)
            for (size_t d=0; d<64; ++d) result[d]+=row_scores[j-low]*v[j*256+head*64+d];
          for (size_t d=0; d<64; ++d) result[d]/=denominator;
        }
      }
    });
    state->local_calls.fetch_add(1);
  }
  void global(Ort::KernelContext& ctx) {
    auto query = ctx.GetInput(0), key = ctx.GetInput(1), value = ctx.GetInput(2);
    const auto dimensions = shape(query);
    require(dimensions.size() == 3 && dimensions[0] == 1 && dimensions[2] == 256 &&
            dimensions[1] > 0 && dimensions[1] <= SGREP_MAX_WINDOW_TOKENS, "invalid global attention shape");
    require(shape(key) == dimensions && shape(value) == dimensions, "global Q/K/V shape mismatch");
    const auto sequences = sequence_bounds(ctx, 3, static_cast<size_t>(dimensions[1]));
    auto output = ctx.GetOutput(0, dimensions);
    auto memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    const float* sources[] = {query.GetTensorData<float>(), key.GetTensorData<float>(), value.GetTensorData<float>()};
    for (size_t sequence = 0; sequence+1 < sequences.count; ++sequence) {
      cancelled(*state);
      const size_t begin = static_cast<size_t>(sequences.offsets[sequence]);
      const size_t length = static_cast<size_t>(sequences.offsets[sequence+1])-begin;
      const int64_t tensor_shape[] = {1, static_cast<int64_t>(length), 256};
      auto tensor = [&](const float* pointer) {
        return Ort::Value::CreateTensor<float>(memory, const_cast<float*>(pointer), length*256, tensor_shape, 3);
      };
      std::array<Ort::Value, 3> inputs = {
        tensor(sources[0]+begin*256), tensor(sources[1]+begin*256), tensor(sources[2]+begin*256)
      };
      auto result = tensor(output.GetTensorMutableData<float>()+begin*256);
      // Invoke the same fixed original MHA/flash kernel on one independent sequence.
      attention.Invoke(ctx.GetOrtKernelContext(), inputs.data(), inputs.size(), &result, 1);
      cancelled(*state);
    }
  }
  void residual_norm(Ort::KernelContext& ctx) {
    auto skip=ctx.GetInput(0), addition=ctx.GetInput(1), gamma=ctx.GetInput(2);
    const auto dimensions=shape(skip);
    require(dimensions.size()==2 && dimensions[1]==256 && shape(addition)==dimensions &&
      shape(gamma)==std::vector<int64_t>({256}), "invalid residual/LN shape");
    const float* a=skip.GetTensorData<float>(), *b=addition.GetTensorData<float>(), *g=gamma.GetTensorData<float>();
    float* residual=ctx.GetOutput(0,dimensions).GetTensorMutableData<float>();
    float* normalized=ctx.GetOutput(1,dimensions).GetTensorMutableData<float>();
#if defined(__x86_64__)
    const size_t row_count = static_cast<size_t>(dimensions[0]);
    auto normalize_group = [&](size_t group, size_t) {
      const size_t begin = group*NORMALIZATION_GROUP_ROWS;
      const size_t end = std::min(begin+NORMALIZATION_GROUP_ROWS, row_count);
      for (size_t row = begin; row < end; ++row)
        for (size_t column = 0; column < 256; ++column) residual[row*256+column] = a[row*256+column]+b[row*256+column];
      if (end-begin == NORMALIZATION_GROUP_ROWS) {
        normalize_four_rows(residual+begin*256, g, normalized+begin*256);
      } else {
        for (size_t row = begin; row < end; ++row) normalize256(residual+row*256, g, normalized+row*256);
      }
    };
    const size_t groups = (row_count+NORMALIZATION_GROUP_ROWS-1)/NORMALIZATION_GROUP_ROWS;
    if (row_count <= RESIDUAL_NORM_CALLER_MAX_ROWS) {
      for (size_t group = 0; group < groups && !state->cancelled.load(); ++group) normalize_group(group, 0);
      cancelled(*state);
    } else {
      parallel(ctx, groups, *state, normalize_group);
    }
#else
    parallel(ctx,dimensions[0],*state,[&](size_t row,size_t) {
      for (size_t d=0; d<256; ++d) residual[row*256+d]=a[row*256+d]+b[row*256+d];
      normalize256(residual+row*256,g,normalized+row*256);
    });
#endif
  }
  void geglu(Ort::KernelContext& ctx) {
    auto input=ctx.GetInput(0);
    const auto dimensions=shape(input);
    require(dimensions.size()==2 && dimensions[1]==768, "invalid GeGLU shape");
    const int64_t out_shape[]={dimensions[0],384};
    const float* in=input.GetTensorData<float>();
    auto result = ctx.GetOutput(0, out_shape, 2);
    float* out = result.GetTensorMutableData<float>();
    // Reuse the output for the pointwise Erf, then finish the gate. Its CPU
    // kernel shares our ORT pool; no tensor scratch or nested parallel region.
    parallel(ctx, dimensions[0], *state, [&](size_t row, size_t) {
      for (size_t d = 0; d < 384; ++d) out[row*384+d] = in[row*768+d] * 0.7071067811865475244f;
    });
    if (state->cancelled.load()) return;
    const OrtValue* inputs[] = {result};
    OrtValue* outputs[] = {result};
    erf.Invoke(ctx.GetOrtKernelContext(), inputs, 1, outputs, 1);
    if (state->cancelled.load()) return;
    parallel(ctx, dimensions[0], *state, [&](size_t row, size_t) {
      for (size_t d = 0; d < 384; ++d) {
        const float x = in[row*768+d];
        out[row*384+d] = (0.5f*x*(1.0f+out[row*384+d]))*in[row*768+384+d];
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
        case Kind::GlobalAttention: global(ctx); break;
      }
      return nullptr;
    } catch(const Ort::Exception& error) { return Ort::GetApi().CreateStatus(error.GetOrtErrorCode(),error.what()); }
      catch(const std::exception& error) { return Ort::GetApi().CreateStatus(ORT_FAIL,error.what()); }
  }
};

CustomOp::CustomOp(Kind value,KernelState* owner):kind(value),state(owner) {}
const char* CustomOp::GetName() const {
  constexpr const char* names[] = {
    "SgrepRopePackF32", "SgrepLocalAttentionF32", "SgrepResidualNormF32",
    "SgrepGeGLUF32", "SgrepOutputF32", "SgrepSegmentedGlobalAttentionF32"
  };
  return names[static_cast<unsigned>(kind)];
}
size_t CustomOp::GetInputTypeCount() const {
  if (kind == Kind::GeGLU) return 1;
  if (kind == Kind::ResidualNorm) return 3;
  return 4;
}
size_t CustomOp::GetOutputTypeCount() const { return kind==Kind::Rope?3:kind==Kind::ResidualNorm?2:1; }
ONNXTensorElementDataType CustomOp::GetInputType(size_t index) const {
  const bool offsets = index == 3 && (kind == Kind::Rope || kind == Kind::LocalAttention || kind == Kind::GlobalAttention);
  return offsets || (kind == Kind::Output && index == 1)
    ? ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64 : ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
}
OrtStatus* CustomOp::CreateKernelV2(const OrtApi& api,const OrtKernelInfo* info,void** out) const noexcept {
  try { *out=new Kernel(*this,info); return nullptr; }
  catch(const Ort::Exception& error) { return api.CreateStatus(error.GetOrtErrorCode(),error.what()); }
  catch(const std::exception& error) { return api.CreateStatus(ORT_FAIL,error.what()); }
}
} // namespace sgrep
