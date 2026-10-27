#ifndef SGREP_RUNTIME_ABI_H
#define SGREP_RUNTIME_ABI_H
/* v4.1 in-process CPU ABI. Rust owns tokenization/window mapping.
 * Buffers remain caller-owned; destroy only after encode returns. */
#include <stddef.h>
#include <stdint.h>
#if defined(_WIN32)
#define SGREP_API __declspec(dllexport)
#else
#define SGREP_API __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif
#define SGREP_RUNTIME_ABI_VERSION 1u
typedef struct sgrep_runtime sgrep_runtime;
typedef enum {SG_OK=0,SG_INVALID=1,SG_BUFFER_TOO_SMALL=2,SG_CANCELLED=3,
 SG_ASSET_MISMATCH=4,SG_BUDGET_EXCEEDED=5,SG_UNVERIFIED=6} sgrep_error;
typedef enum {SG_QUERY=0,SG_DOCUMENT=1} sgrep_role;
typedef struct {uint32_t abi_version;const char *artifact_manifest_utf8;
 uint32_t threads;uint64_t temp_bytes_cap;uint32_t strict_source_contract;} sgrep_options;
typedef struct {const uint32_t *token_ids;size_t token_count;sgrep_role role;
 const uint8_t *output_mask;size_t mask_count;uint64_t request_id;} sgrep_encoded_input;
typedef struct {float *vectors;size_t float_capacity;size_t rows_written;
 size_t required_float_capacity;uint32_t dimensions;} sgrep_encoded_output;
/* Caller owns options strings/input/output. Exceptions never cross the ABI.
 * A handle permits one in-flight encode; cancel is thread-safe and does not free it.
 * destroy is permitted only after encode has returned. */
SGREP_API sgrep_error sgrep_runtime_create(const sgrep_options*,sgrep_runtime**);
SGREP_API sgrep_error sgrep_runtime_encode(sgrep_runtime*,const sgrep_encoded_input*,sgrep_encoded_output*);
SGREP_API sgrep_error sgrep_runtime_cancel(sgrep_runtime*,uint64_t request_id);
SGREP_API sgrep_error sgrep_runtime_diagnostics(sgrep_runtime*,char *json,size_t capacity,size_t *required);
SGREP_API void sgrep_runtime_destroy(sgrep_runtime*);
SGREP_API sgrep_error sgrep_maxsim_update(const float *query,size_t query_rows,
 const uint16_t *document,size_t document_rows,float *query_maxima);
#ifdef __cplusplus
}
#endif
#endif
