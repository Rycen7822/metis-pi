# CPU semantic search core

Metis-owned [sgrep](https://github.com/context-dot-dev/sgrep) fork, based on
`dec6122c05be553c5a60bd647d1350b221b7b9c3`. MIT notices remain in [LICENSE](LICENSE)
and the ported source files. The semantic runtime targets Linux x64.

## Ownership and search behavior

| Owner | Responsibility |
| --- | --- |
| `src/` | Rust CLI, discovery/chunking, lexical ranking, encoding and complete corpus indexes |
| `native/` | In-process CPU C ABI, ORT/MLAS operators, bounded attention and MaxSim |
| `native/patches/` | Required changes to the pinned ORT source |
| `Cargo.toml` / `Cargo.lock` | Rust toolchain requirements and dependency inputs |
| [Parent component](../METIS.md) | Pi action, TOML configuration, CLI/JSON adaptation and cancellation |

`--model auto` selects Bekko128 for prose-only candidates and LateOn-Code-edge
for code/mixed scopes. Complete-scope scoring retains sgrep's 75/25 fusion,
exact-match priority and stable ordering; LateOn consumes all token windows with
Q4/D64 MaxSim. Shared encoding reuses the request query/asset descriptors; score-only
moves its source strings and emits no window payloads. A failed writer stops block
delivery without stopping or replaying encoding. There is no ANN, FFF prefilter or frecency adjustment. The sibling
`../engine/` separately owns FFF path/content search.
Each lane selects its exact stable Top200 before sorting; supplied and exact
matches remain uncapped. AST splitting bisects sorted boundaries without
changing byte ranges, line ranges, or chunk content.

## CLI and shared service

Use a prepared runtime, not the original model downloads:

```sh
export SGREP_RUNTIME_DIR=/absolute/path/to/runtime
"$SGREP_RUNTIME_DIR/bin/sgrep" --shared-service --json "query" /path/to/repository
"$SGREP_RUNTIME_DIR/bin/sgrep" --service-control status
"$SGREP_RUNTIME_DIR/bin/sgrep" --service-control stop
```

Metis uses shared mode; omit `--shared-service` for a standalone CLI. Shared mode
rejects stdin, rg-json, fresh-assets and explicit cache-dir modes. CLI options
are listed by `sgrep --help` and defined in [src/main.rs](src/main.rs). Host output requires
`--json --metis-protocol 1` and returns `{protocol:1,results:[...]}` without
changing ordinary CLI JSON. A completed host-protocol search exits successfully
with empty results too; ordinary CLI keeps exit1 for no matches. Errors and
cancellation still fail, never masquerading as an empty successful response.

- One private Unix-socket service per UID/canonical HOME serves workspaces and
  Pi sessions. No system service or public TCP listener is installed. Runtime
  incompatibility fails explicitly rather than loading a second model process.
- LateOn and Bekko load lazily, each at most once per compatible asset generation;
  both may remain resident. Listener readiness does not preload either model.
- At most **3 searches × 4 computing threads** execute; excess work waits in a
  bounded FIFO with backpressure. LateOn encoding is serialized on its owning
  thread; cached scans can overlap. Sleeping/control threads are not compute lanes.
- Idle shutdown starts after running/queued work finishes. Metis's
  `[neuralSearch.semantic].idleTimeoutSeconds` defaults to 300 (integer 1–86400);
  status checks do not extend it. `stop` drains the service.
- Models and at most two read-only asset-verification proofs stay warm. Each
  request owns its cache-policy snapshot, query, scratch, mappings, leases and diagnostics. Disconnect/timeout cancels
  that request; its workers/discovery are collected before releasing the slot.
  Native cancel is thread-safe; the ORT handle remains on its owner thread.

## Corpus cache

Complete indexes store chunk ranges/text, word counts and tagged FP16
representations. Format08 stores counts once and derives the current query's DF;
Format07 remains readable with postings validation. Hits are provisional: matching
model/preprocessing identity permits a full cached scan, but its stored source
manifest must match one final complete content capture before any output. A stale
hit discards scores and rebuilds in the same request, reusing a compatible query.
Misses build the snapshot during their first source read, then retain Reader and
final content checks. Source changes during rebuilding permit one complete retry,
never partial results. The FP16 asset revision below invalidates old FP32/experimental indexes
through full-manifest identity, without changing the corpus-record format.

### Budget and eviction

- `[neuralSearch.semantic].cacheBudgetMiB` accepts **256, 512 or 1024**, default 512.
  One ledger at `$HOME/.cache/sgrep-cpu-quota` covers all registered cache roots;
  `--cache-dir`, `SGREP_CACHE_DIR` and `XDG_CACHE_HOME` do not create extra quotas.
  Model assets and FFF indexes are outside this budget.
- Standalone CLI calls inherit the recorded policy. `SGREP_CACHE_MAX_BYTES` can
  only impose a stricter request ceiling. Metis sends stat-bound policy selections
  through internal `SGREP_CACHE_POLICY_REQUEST`; stale/conflicting selections
  are rejected. Pending downgrades block growth/publication until responsibility
  fits; upgrades preserve valid indexes.
- Admission counts allocated blocks, in-flight reservations, old generations and
  reader leases. Growing writers reclaim idle indexes in LRU order, protecting
  active readers and the target being replaced. Failed refresh preserves the old
  target; explicit budget-shrink eviction is separate. Last-reader release updates
  LRU age without changing payload bytes.
- Allocation is qualified on ext4/tmpfs. Unsupported allocation, permissions,
  insufficient peak space or unavailable locks fall back to complete uncached
  search. Shared admission can wait cancellably on writer contention; eviction
  never waits for active readers.

### Integrity and lifetime

Private index/ledger records use mode 0600. Immutable payloads and locked reader
leases are published atomically; recovery removes only recognized abandoned
stages with an exited owner and a free kernel lock. Unknown/live objects and
symlinks remain preserved and charged; unverifiable leases disable caching.
Bounded scope metadata can reject a known identity mismatch before the full CRC;
a possible hit still checks its complete CRC and layout. Record metadata and
vectors are validated during the full scan. Ranking reopens text without rebuilding
counts.
Corruption discards provisional scores and rebuilds with the existing query
encoder; model/runtime failures are not disguised as cache corruption. Discarded
work is reported separately. Bounded tasks reuse local Zstd contexts, never a
process-resident decompressed corpus.

## Prepared assets and precision

`SGREP_RUNTIME_DIR` selects a bundle containing `assets.json`, `bin/sgrep`,
`lib/libsgrep_cpu.so`, sibling ORT libraries/SONAME-named regular copies, and prepared
`models/bekko128` / `models/lateon-edge` directories. The trusted catalog pins an
immutable prepared-artifact revision, source models and exact file sizes/SHA256;
it ships with the runtime, not a model-server response. Updates replace the
runtime/catalog together. No query-time Python, compiler or conversion runs.

- Online acquisition uses the HF client and `HF_ENDPOINT`, verifies approved
  files, then replaces them atomically without truncating mapped inodes. Warm
  verification receipts bind device/inode/size/mtime/ctime; changed files require
  full verification. When disk receipts cannot be persisted, the process can reuse
  at most two proofs bound to those same file identities; it never skips the first
  or changed-file SHA. No new fingerprint key or receipt directory is introduced.
- `HF_HUB_OFFLINE` values `1`, `true`, `YES` or `On` prohibit acquisition; missing
  or damaged assets fail explicitly. A `--cache-dir` override isolates models,
  parsers and indexes and cannot borrow assets from another store.
- `--fresh-assets` rejects offline mode, downloads models/parsers privately,
  bypasses all corpus-index reads/writes and cleans up on normal success/failure.
  Later invocations reclaim only marked directories whose PID/start-time owner
  exited, never live/unmarked objects or symlink targets. Installed assets stay intact.

LateOn's pre-LN table is **FP16 storage → per-row FP32 input**; backbone weights,
activations, normalization, query vectors and score accumulation remain FP32.
AVX2/F16C or scalar decoding fills the existing bounded arena, never a full FP32
table copy. Document representations remain FP16; Bekko's contract is unchanged.

The supported bundle requires native **ABI2**, `strict_artifact_contract=1` and
LateOn manifest3 (`arithmetic_revision=ort-1.31-erf-v1`, FP16 embeddings/FP32 backbone).
Its `embedding_preln_f16.pack` table uses magic `SGRPLN16`, pack-layout version1,
a 64-byte header and 50370×256 half values (25,789,504 bytes). Update CLI/native/assets as
one bundle: ABI1 callers, FP32 tables and older arithmetic manifests fail closed.
The complete manifest invalidates old document indexes; no new fingerprint is needed.
The [C header](native/include/sgrep_runtime.h) defines buffer ownership and errors.
FP16 storage is intentionally lossy relative to the FP32 source; valid asset
integrity does not imply zero numerical or retrieval-quality loss.

GeGLU owns one public ORT CPU `Erf` operator per graph kernel. It reuses its output
for scale → in-place Erf → gate, sharing the existing ORT pool without a new
tensor scratch or math-library dependency. ORT/MLAS Erf is not bit-identical to
the previous scalar `std::erf`; the arithmetic revision prevents mixed encodings.
Native output/MaxSim boundaries share guarded SIMD finite classification while
retaining scalar fallbacks and the original validation/error semantics. AVX2 MaxSim
shares document loads across four query rows and transposes the final lane sums;
per-row arithmetic, stable maxima and partial-error stores remain bit-identical.

## CPU and memory bounds

- Each request uses at most four computing threads including the caller;
  inter-op=1, no spinning. Validation, encoding, scanning/ranking and source
  verification do not overlap their compute pools. Owned `rg --files` is serial.
- Normal Format08 fuses metadata/DF, query frequencies and scoring, with geometry
  admission limiting additional query state to 1MiB. Wide/large geometries and
  Format07 retain the bounded two-pass fallback, not an unbounded corpus dictionary.
  Cached-code and fallback DF scans use scoped tasks within that ceiling, with
  serial small batches. Code batches admit at most 8MiB mapped data / 1MiB raw
  metadata; a larger record runs alone. These are work-admission bounds, not RSS
  limits. Workers join before mapped views are released or recovery begins.
- Each scan worker's decoder reuses at most one window's FP16 values (192KiB) and
  exponent symbols (96KiB), outside the native arena. A synchronous sink borrows
  only the current window's slice; retained capacity never exposes a previous
  window's tail. Twelve concurrent decoders need at most 3.375MiB for these two
  buffers, excluding existing Zstd/metadata state; no decoded scope is retained.
- Native temporary allocations use a hard arena cap of 128MiB, not a whole-process
  memory limit. Misses/no-cache rehydrate one source file at a time; hits consume
  immutable mappings in bounded resident windows. Releasing this reader's PTEs
  does not evict shared file-cache pages or remove their cgroup/PSS charge.
- Attention/scoring use guarded SIMD and scalar fallbacks. Adapter builds disable
  fast-math and FMA contraction; ORT/MLAS retains its pinned FP32 kernel semantics.
  Neither larger disk tiers nor shared service increase a request's compute/arena
  ceiling. Shared resident-model memory and
  three active requests require their own resource qualification.

## Build and staging

From this directory, use the Rust toolchain declared in `Cargo.toml` and absolute
`BUILD_ROOT`, `ORT_SOURCE` and `ORT_BUILD` paths:

```sh
CARGO_TARGET_DIR="$BUILD_ROOT/rust" cargo build --release --locked --manifest-path Cargo.toml
cmake -S native -B "$BUILD_ROOT/native" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DORT_SOURCE="$ORT_SOURCE" -DORT_BUILD="$ORT_BUILD"
cmake --build "$BUILD_ROOT/native" --parallel 4
cmake --install "$BUILD_ROOT/native" --prefix "$BUILD_ROOT/runtime-stage"
```

`ORT_SOURCE` must be commit `402979ac1bef89dcd55add41eaa7277c407599eb` with the
owned patches applied. `ORT_BUILD` is its reduced non-minimal CPU `Release` build,
with `onnxruntime_USE_TELEMETRY=OFF` and the exports in
[native/ort-extra-symbols.txt](native/ort-extra-symbols.txt). Its reduced registry must
include [native/ort-required-operators.config](native/ort-required-operators.config):
serialized graph operators alone omit the runtime-invoked CPU Erf kernel. A system
ORT is not interchangeable; telemetry otherwise adds a process-lifetime SDK worker.

Stage native libraries through CMake: installation sets `$ORIGIN`-only RPATH,
unlike copying the build-tree `.so`. Supply the CLI, pinned sibling ORT and assets
separately to complete the bundle; missing siblings must not load development
fallbacks. These commands stage a library, not install or activate Metis.

## Diagnostics and evidence

| Environment variable | Output |
| --- | --- |
| `SGREP_STAGE_TIMINGS_PATH` | Cache/phases and separate query/document/work counters |
| `SGREP_SERVICE_INFO_PATH` | Queue/execution times, service PID and model/native counters |
| `SGREP_RETRIEVAL_TRACE_PATH` | Raw identities/scores, BM25/semantic Top200, candidate union and final IDs |

A cache hit has zero document encodes but still scores every scope chunk;
`semantic_scored_chunks == scope_chunks + supplied_extra_chunks` (stdin's base
scope is zero). Scored token rows mean one vector per Bekko chunk or selected
48D LateOn rows. Traces publish only after source verification; keep diagnostics
outside the searched scope and disable tracing for normal latency measurements.
Counters/traces are not quality labels, cold-page evidence or memory qualification.

Plans, benchmarks, raw results and comparison fixtures belong in repository
`.work/`, not this source tree. Keep bundle identity/numerical admission in
`manifests/runtime.lock.json` and `manifests/quality-gates.json` alongside the
staged runtime. The development catalog is an unpublished fixture; public release
requires a real prepared-artifact revision. Qualification applies to the pinned
candidate, host and execution mode, not other bundles or concurrency.
