#include "include/sgrep_runtime.h"
#include "custom_ops.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <nlohmann/json.hpp>

extern "C" void OrtSgrepConfigureGlobalAttention(int);
extern "C" void OrtSgrepGetGlobalAttentionStats(uint64_t*,uint64_t*,uint64_t*);
extern "C" void OrtSgrepTraceMarker(const char*,uint64_t);
using json=nlohmann::json;
namespace fs=std::filesystem;
namespace {
thread_local std::string creation_error;
struct BudgetError : std::runtime_error { using std::runtime_error::runtime_error; };
void require(bool condition,const char* message) { if(!condition) throw std::invalid_argument(message); }
struct Mapping {
  void* data=nullptr; size_t bytes=0;
  Mapping()=default;
  Mapping(const Mapping&)=delete;
  Mapping& operator=(const Mapping&)=delete;
  void open(const fs::path& path) {
    require(!data,"mapping already open");
    int fd=::open(path.c_str(),O_RDONLY|O_CLOEXEC);
    if(fd<0) throw std::runtime_error("cannot open model artifact: "+path.string());
    struct stat status{};
    if(fstat(fd,&status)!=0 || status.st_size<=0) { close(fd); throw std::runtime_error("invalid model artifact size"); }
    bytes=static_cast<size_t>(status.st_size);
    data=mmap(nullptr,bytes,PROT_READ,MAP_PRIVATE,fd,0);
    close(fd);
    if(data==MAP_FAILED) {data=nullptr;throw std::runtime_error("model mmap failed");}
  }
  ~Mapping() {if(data) munmap(data,bytes);}
};
uint32_t u32(const Mapping& file,size_t at) {uint32_t value;std::memcpy(&value,static_cast<const char*>(file.data)+at,4);return value;}
uint64_t u64(const Mapping& file,size_t at) {uint64_t value;std::memcpy(&value,static_cast<const char*>(file.data)+at,8);return value;}
sgrep_error serialize(const std::string& text,char* buffer,size_t capacity,size_t* required) {
  if(!required) return SG_INVALID;
  *required=text.size()+1;
  if(capacity<*required) return SG_BUFFER_TOO_SMALL;
  if(!buffer) return SG_INVALID;
  std::memcpy(buffer,text.c_str(),*required);return SG_OK;
}
} // namespace

struct sgrep_runtime {
  // Declaration order keeps domain, env and mappings alive until Session dies.
  sgrep::KernelState state;
  std::array<sgrep::CustomOp,5> operators;
  Ort::CustomOpDomain domain{"com.metis.sgrep"};
  Ort::ThreadingOptions threading;
  Ort::Env env{nullptr};
  Ort::MemoryInfo memory=Ort::MemoryInfo::CreateCpu(OrtArenaAllocator,OrtMemTypeDefault);
  Mapping table,graph;
  Ort::SessionOptions options;
  Ort::Session session{nullptr};
  Ort::RunOptions run_options;
  std::vector<std::string> debug_names;
  std::vector<Ort::Value> debug_values;
  std::mutex encode_mutex,cancel_mutex;
  std::atomic<uint64_t> active_request{0},forward_count{0},longest_input{0};
  std::atomic<uint64_t> query_forwards{0},document_forwards{0},query_tokens{0},document_tokens{0};
  uint64_t arena_cap;
  std::string last_error,graph_format;

  explicit sgrep_runtime(const sgrep_options& settings):operators{{
    {sgrep::Kind::Rope,&state},{sgrep::Kind::LocalAttention,&state},
    {sgrep::Kind::ResidualNorm,&state},{sgrep::Kind::GeGLU,&state},{sgrep::Kind::Output,&state}}},arena_cap(settings.temp_bytes_cap) {
    state.threads=settings.threads;
    const fs::path manifest_path=settings.artifact_manifest_utf8;
    std::ifstream stream(manifest_path);
    if(!stream) throw std::runtime_error("cannot open LateOn manifest");
    const json manifest=json::parse(stream);
    require(manifest.at("format_version")==1 && manifest.at("model")=="lateon_code_edge" &&
      manifest.at("revision")=="4bcdf5ed93f791259eb130b577a240f753d68dd8" &&
      manifest.at("rows")==50370 && manifest.at("hidden")==256 && manifest.at("dimensions")==48 &&
      manifest.at("embedding_dtype")=="float32" && manifest.at("backbone_dtype")=="float32" &&
      manifest.at("require_global_flash")==true,"unsupported LateOn artifact contract");
    graph_format=manifest.at("graph_format").get<std::string>();
    debug_names=manifest.value("debug_outputs",std::vector<std::string>{});
    require(debug_names.empty() || graph_format=="onnx","debug outputs are development ONNX only");
    require(debug_names.size()<=7,"too many debug outputs");
    for(size_t i=0;i<debug_names.size();++i) require(debug_names[i]=="layers."+std::to_string(i)+".hidden","invalid debug output name");
    const std::string graph_file=manifest.at("graph_file");
    require((graph_format=="onnx" && graph_file=="backbone.onnx") ||
            (graph_format=="ort" && graph_file=="backbone.ort"),"invalid graph file/format");
    require(manifest.at("embedding_file")=="embedding_preln_f32.pack","invalid embedding file");
    const auto root=manifest_path.parent_path();
    table.open(root/"embedding_preln_f32.pack");graph.open(root/graph_file);
    OrtSgrepTraceMarker("preln_mapped_bytes",table.bytes);
    OrtSgrepTraceMarker("graph_mapped_bytes",graph.bytes);
    require(table.bytes==64+50370ULL*256*4,"invalid pre-LN table size");
    require(std::memcmp(table.data,"SGRPLN32",8)==0 && u32(table,8)==1 && u32(table,12)==50370 &&
      u32(table,16)==256 && u32(table,20)==0 && u64(table,24)==64 && u64(table,32)==0 &&
      u64(table,40)==table.bytes,"invalid pre-LN table header");
    threading.SetGlobalIntraOpNumThreads(settings.threads).SetGlobalInterOpNumThreads(1).SetGlobalSpinControl(0);
    env=Ort::Env(threading,ORT_LOGGING_LEVEL_WARNING,"sgrep-cpu");
    Ort::ArenaCfg arena(settings.temp_bytes_cap,1,1<<20,0);
    env.CreateAndRegisterAllocator(memory,arena);
    for(auto& op:operators) domain.Add(&op);
    options.Add(domain);
    options.DisablePerSessionThreads();
    options.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_DISABLE_ALL);
    options.DisableMemPattern();
    options.AddConfigEntry("session.use_env_allocators","1");
    options.AddConfigEntry("session.use_device_allocator_for_initializers","1");
    options.AddConfigEntry("session.prepack.enable_parallel","0");
    if(graph_format=="ort") {
      options.AddConfigEntry("session.load_model_format","ORT");
      options.AddConfigEntry("session.use_ort_model_bytes_directly","1");
      options.AddConfigEntry("session.use_ort_model_bytes_for_initializers","1");
    }
    if(const char* prefix=std::getenv("SGREP_OPERATOR_PROFILE_PREFIX")) options.EnableProfiling(prefix);
    OrtSgrepConfigureGlobalAttention(1);
    session=Ort::Session(env,graph.data,graph.bytes,options);
    // ORT environments may be shared by repeated C API consumers. Do not
    // claim a newly requested cap if an existing allocator ignored it.
    Ort::Allocator allocator(session,memory);
    const auto statistics=allocator.GetStats().GetKeyValuePairs();
    const auto limit=statistics.find("Limit");
    if(limit==statistics.end() || std::stoull(limit->second)==0 || std::stoull(limit->second)>arena_cap)
      throw BudgetError("SGREP: actual CPU allocator does not enforce the requested arena budget");
  }
  ~sgrep_runtime() {
    // Explicit opt-in profiling only. No raw input text or default output file.
    if(const char* path=std::getenv("SGREP_DIAGNOSTICS_PATH")) {
      try {std::ofstream stream(path);stream<<diagnostics(true).dump()<<'\n';
           if(!stream) std::fprintf(stderr,"sgrep: could not write requested CPU diagnostics\n");}
      catch(...) {std::fprintf(stderr,"sgrep: could not collect requested CPU diagnostics\n");}
    }
  }
  json diagnostics(bool include_allocator) {
    uint64_t calls=0,scratch=0,fallbacks=0;
    OrtSgrepGetGlobalAttentionStats(&calls,&scratch,&fallbacks);
    json result={{"backend","ort_cpu_mlas"},{"ort_version",OrtGetApiBase()->GetVersionString()},
      {"device","cpu"},{"threads",state.threads},
      {"query_forward_count",query_forwards.load()},{"document_forward_count",document_forwards.load()},
      {"query_tokens",query_tokens.load()},{"document_tokens",document_tokens.load()},
      {"graph_format",graph_format},{"arena_cap_bytes",arena_cap},{"active_request",active_request.load()},
      {"forward_count",forward_count.load()},{"max_input_tokens",longest_input.load()},
      {"global_flash_calls",calls},{"global_flash_scratch_peak_bytes",scratch},
      {"global_fallback_attempts",fallbacks},{"local_attention_calls",state.local_calls.load()},
      {"custom_scratch_peak_bytes",state.scratch_peak.load()}};
    if(include_allocator) {
      result["last_error"]=last_error;
      Ort::Allocator allocator(session,memory);
      result["allocator_stats"]=allocator.GetStats().GetKeyValuePairs();
    }
    return result;
  }
};

extern "C" SGREP_API sgrep_error sgrep_runtime_create(const sgrep_options* settings,sgrep_runtime** output) {
  if(!output) return SG_INVALID;
  *output=nullptr;
  if(!settings || settings->abi_version!=SGREP_RUNTIME_ABI_VERSION || !settings->artifact_manifest_utf8 ||
     settings->threads<1 || settings->threads>4 || settings->temp_bytes_cap==0 ||
     settings->temp_bytes_cap>(128ULL<<20) || settings->strict_source_contract!=1) {
    creation_error="invalid CPU ABI version/options";return SG_INVALID;
  }
  try {
    static std::once_flag initialized;
    std::call_once(initialized,[]{Ort::InitApi(OrtGetApiBase()->GetApi(ORT_API_VERSION));});
    *output=new sgrep_runtime(*settings);
    creation_error.clear();return SG_OK;
  } catch(const BudgetError& e) {creation_error=e.what();return SG_BUDGET_EXCEEDED;}
    catch(const std::bad_alloc& e) {creation_error=e.what();return SG_BUDGET_EXCEEDED;}
    catch(const std::exception& e) {
      creation_error=e.what();
      return creation_error.find("BFCArena")!=std::string::npos || creation_error.find("Failed to allocate")!=std::string::npos?SG_BUDGET_EXCEEDED:SG_ASSET_MISMATCH;
    }
}

extern "C" SGREP_API sgrep_error sgrep_runtime_encode(sgrep_runtime* runtime,const sgrep_encoded_input* input,sgrep_encoded_output* output) {
  if(!runtime || !input || !output) return SG_INVALID;
  output->rows_written=0;output->required_float_capacity=0;output->dimensions=48;
  if(!input->token_ids || !input->output_mask || input->mask_count!=input->token_count ||
      input->token_count==0 || input->request_id==0 ||
      (input->role!=SG_QUERY && input->role!=SG_DOCUMENT) ||
      input->token_count>(input->role==SG_QUERY?256:2048)) return SG_INVALID;
  size_t rows=0;
  for(size_t i=0;i<input->token_count;++i) {
    if(input->token_ids[i]>=50370 || input->output_mask[i]>1) return SG_INVALID;
    rows+=input->output_mask[i];
  }
  if(!rows) return SG_INVALID;
  output->required_float_capacity=rows*48;
  if(output->float_capacity<rows*48) return SG_BUFFER_TOO_SMALL;
  if(!output->vectors) return SG_INVALID;
  std::unique_lock<std::mutex> lock(runtime->encode_mutex,std::try_to_lock);
  if(!lock.owns_lock()) return SG_INVALID;
  runtime->last_error.clear();
  runtime->debug_values.clear();
  {
    std::lock_guard<std::mutex> cancel_lock(runtime->cancel_mutex);
    runtime->state.cancelled.store(false);
    runtime->run_options.UnsetTerminate();
    runtime->active_request.store(input->request_id);
  }
  sgrep_error result=SG_OK;
  OrtSgrepTraceMarker("forward_begin_length",input->token_count);
  OrtSgrepTraceMarker("caller_output_bytes",rows*48*sizeof(float));
  try {
    Ort::Allocator allocator(runtime->session,runtime->memory);
    auto allocation=allocator.GetAllocation(input->token_count*256*sizeof(float));
    auto* embeddings=static_cast<float*>(allocation.get());
    const float* table=reinterpret_cast<const float*>(static_cast<const char*>(runtime->table.data)+64);
    // Runtime-owned row-selection scratch belongs to the same hard arena as
    // activations/custom kernels, not an unaccounted std::vector allocation.
    auto row_indices=allocator.GetAllocation(rows*sizeof(int64_t));
    auto* selected=static_cast<int64_t*>(row_indices.get());
    size_t selected_count=0;
    OrtSgrepTraceMarker("selected_rows_bytes",rows*sizeof(int64_t));
    for(size_t i=0;i<input->token_count;++i) {
      if(runtime->state.cancelled.load()) break;
      std::memcpy(embeddings+i*256,table+input->token_ids[i]*256,256*sizeof(float));
      if(input->output_mask[i]) selected[selected_count++]=static_cast<int64_t>(i);
    }
    if(runtime->state.cancelled.load()) throw std::runtime_error("cancelled");
    const int64_t embed_shape[]={static_cast<int64_t>(input->token_count),256};
    const int64_t row_shape[]={static_cast<int64_t>(rows)};
    const int64_t out_shape[]={static_cast<int64_t>(rows),48};
    std::array<Ort::Value,2> values={
      Ort::Value::CreateTensor<float>(runtime->memory,embeddings,input->token_count*256,embed_shape,2),
      Ort::Value::CreateTensor<int64_t>(runtime->memory,selected,rows,row_shape,1)};
    std::vector<Ort::Value> encoded;
    encoded.push_back(Ort::Value::CreateTensor<float>(runtime->memory,output->vectors,rows*48,out_shape,2));
    const char* names[]={"embedding_input","output_rows"};
    std::vector<const char*> outputs={"embeddings"};
    for(const auto& name:runtime->debug_names) {outputs.push_back(name.c_str());encoded.emplace_back(nullptr);}
    runtime->session.Run(runtime->run_options,names,values.data(),values.size(),outputs.data(),encoded.data(),encoded.size());
    for(size_t i=1;i<encoded.size();++i) runtime->debug_values.push_back(std::move(encoded[i]));

    if(runtime->state.cancelled.load()) throw std::runtime_error("cancelled");
    for(size_t i=0;i<rows*48;++i) if(!std::isfinite(output->vectors[i])) throw std::runtime_error("non-finite model output");
    output->rows_written=rows;runtime->forward_count.fetch_add(1);
    if(input->role==SG_QUERY) {runtime->query_forwards.fetch_add(1);runtime->query_tokens.fetch_add(input->token_count);}
    else {runtime->document_forwards.fetch_add(1);runtime->document_tokens.fetch_add(input->token_count);}
    uint64_t longest=runtime->longest_input.load();
    while(longest<input->token_count && !runtime->longest_input.compare_exchange_weak(longest,input->token_count)) {}
  } catch(const std::bad_alloc& error) {runtime->last_error=error.what();result=SG_BUDGET_EXCEEDED;}
    catch(const std::exception& error) {
      runtime->last_error=error.what();
      result=runtime->state.cancelled.load()?SG_CANCELLED:SG_UNVERIFIED;
      if(runtime->last_error.find("allocate")!=std::string::npos || runtime->last_error.find("memory")!=std::string::npos) result=SG_BUDGET_EXCEEDED;
    }
  {
    std::lock_guard<std::mutex> cancel_lock(runtime->cancel_mutex);
    runtime->active_request.store(0);
  }
  OrtSgrepTraceMarker("forward_end_status",result);
  return result;
}

extern "C" SGREP_API sgrep_error sgrep_runtime_cancel(sgrep_runtime* runtime,uint64_t request_id) {
  if(!runtime) return SG_INVALID;
  try {
    std::lock_guard<std::mutex> lock(runtime->cancel_mutex);
    if(runtime->active_request.load()==request_id && request_id!=0) {
      runtime->state.cancelled.store(true);runtime->run_options.SetTerminate();
    }
    return SG_OK;
  } catch(...) {return SG_INVALID;}
}
extern "C" SGREP_API sgrep_error sgrep_runtime_diagnostics(sgrep_runtime* runtime,char* buffer,size_t capacity,size_t* required) {
  try {
    if(!runtime) return serialize(json({{"last_error",creation_error}}).dump(),buffer,capacity,required);
    std::unique_lock<std::mutex> lock(runtime->encode_mutex,std::try_to_lock);
    return serialize(runtime->diagnostics(lock.owns_lock()).dump(),buffer,capacity,required);
  } catch(...) {return SG_UNVERIFIED;}
}
extern "C" SGREP_API sgrep_error sgrep_runtime_save_optimized(sgrep_runtime* runtime,const char* destination) {
  if(!runtime || !destination) return SG_INVALID;
  std::unique_lock<std::mutex> lock(runtime->encode_mutex,std::try_to_lock);
  if(!lock.owns_lock()) return SG_INVALID;
  try {
    require(runtime->graph_format=="onnx","offline conversion requires the source ONNX graph");
    auto options=runtime->options.Clone();
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
    options.SetOptimizedModelFilePath(destination);
    options.AddConfigEntry("session.save_model_format","ORT");
    Ort::Session converted(runtime->env,runtime->graph.data,runtime->graph.bytes,options);
    return SG_OK;
  } catch(const std::exception& error) {runtime->last_error=error.what();return SG_UNVERIFIED;}
}
extern "C" SGREP_API sgrep_error sgrep_runtime_copy_debug(sgrep_runtime* runtime,size_t layer,float* output,size_t capacity,size_t* required) {
  if(!runtime || !required) return SG_INVALID;
  std::unique_lock<std::mutex> lock(runtime->encode_mutex,std::try_to_lock);
  if(!lock.owns_lock() || layer>=runtime->debug_values.size()) return SG_INVALID;
  try {
    const auto& tensor=runtime->debug_values[layer];
    const size_t count=tensor.GetTensorTypeAndShapeInfo().GetElementCount();
    *required=count;
    if(capacity<count) return SG_BUFFER_TOO_SMALL;
    if(!output) return SG_INVALID;
    std::memcpy(output,tensor.GetTensorData<float>(),count*sizeof(float));return SG_OK;
  } catch(...) {return SG_UNVERIFIED;}
}
extern "C" SGREP_API void sgrep_runtime_destroy(sgrep_runtime* runtime) {delete runtime;}
