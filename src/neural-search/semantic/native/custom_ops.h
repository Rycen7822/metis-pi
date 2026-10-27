#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include "onnxruntime_cxx_api.h"

namespace sgrep {
struct KernelState {
  unsigned threads = 1;
  std::atomic<bool> cancelled{false};
  std::atomic<uint64_t> scratch_peak{0};
  std::atomic<uint64_t> local_calls{0};
};
enum class Kind { Rope, LocalAttention, ResidualNorm, GeGLU, Output };
struct Kernel;
struct CustomOp : Ort::CustomOpBase<CustomOp, Kernel, true> {
  Kind kind;
  KernelState* state;
  CustomOp(Kind value, KernelState* owner);
  const char* GetName() const;
  const char* GetExecutionProviderType() const { return "CPUExecutionProvider"; }
  size_t GetInputTypeCount() const;
  size_t GetOutputTypeCount() const;
  ONNXTensorElementDataType GetInputType(size_t index) const;
  ONNXTensorElementDataType GetOutputType(size_t) const { return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT; }
  OrtStatus* CreateKernelV2(const OrtApi&, const OrtKernelInfo*, void**) const noexcept;
};
} // namespace sgrep
