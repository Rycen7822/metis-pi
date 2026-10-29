# CPU semantic search core

Metis-owned fork of [sgrep](https://github.com/context-dot-dev/sgrep), based on
`dec6122c05be553c5a60bd647d1350b221b7b9c3`. Upstream and ported-component MIT
copyrights and terms remain in `LICENSE` and the source files.

## Ownership

- `src/`: Rust CLI, file/chunk discovery, lexical ranking, model-specific encoding,
  FP16 representations and complete-index record handling.
- `native/`: in-process CPU C ABI, fixed ORT/MLAS integration, fused operators,
  bounded attention and MaxSim. `native/patches/` owns the required ORT changes.
- `Cargo.toml` / `Cargo.lock`: reproducible Rust dependency inputs.

The existing sibling `../engine/` remains the FFF engine for path/content search.
This core is separate: it does not add FFF frecency or a candidate prefilter to
semantic ranking. Host action registration and CLI/JSON adaptation belong to the
parent neural-search component, not to this Rust/C++ implementation.

## Corpus cache

Complete indexes retain original chunk ranges, text, full word counts and tagged
FP16 representations. Format08 stores lexical counts once in each record rather
than a second corpus-wide dictionary/postings copy. The existing full-record
validation pass derives only the current query's DF; BM25 contributions retain
lexical query order and the empty-sum sign. Format07 remains readable and its old
postings are validated, not silently ignored. Hits require matching source bytes
and model/preprocessing identity; incomplete, stale, unsupported or corrupt files
are recomputed. Source changes cause at most one complete retry, never partial
results.

The shared corpus-cache ledger lives at `$HOME/.cache/sgrep-cpu-quota`. Changing
`--cache-dir`, `SGREP_CACHE_DIR` or `XDG_CACHE_HOME` selects a registered storage
root, not another budget. The shared policy supports 256, 512 and 1024MiB tiers,
defaulting to 512MiB when no policy exists. A standalone CLI inherits the recorded
policy. `SGREP_CACHE_MAX_BYTES` is only a stricter per-request byte ceiling; it
cannot select a larger tier. Model assets and separate FFF indexes are outside
this corpus-cache budget.

Metis owns configuration parsing. Its internal `SGREP_CACHE_POLICY_REQUEST` JSON
bridge carries the selected tier, absolute config source and exact device/inode/
size/mtime/ctime snapshot (decimal strings preserve Node bigint precision).
The core rejects stale or conflicting selections without granting another
quota. User-facing TOML/action wiring belongs to the parent component. Its
versioned host protocol is opt-in via `--json --metis-protocol 1`; it returns
`{protocol:1,results:[...]}` and leaves ordinary CLI JSON unchanged. An older
CLI rejects the host flag instead of silently ignoring the shared budget. A
short policy lock records changes even during a long
index writer; pending downgrades block new allocations/publication until actual
reader/writer responsibility can fit. Upgrades preserve valid index identities.
Neither tier changes nor mmap waive the independent memory/CPU limits.

Admission accounts actual file/directory blocks, in-flight reservations, old generations
and durable reader leases. The qualified allocation backends are ext4 and tmpfs;
unsupported allocation, contention, permissions or insufficient update peak
space disable that cache attempt while complete search continues. Growing writers
reclaim idle complete indexes in LRU order before declining a reservation;
locked readers and the target being replaced remain protected. Failed refresh
retains the prior immutable target; explicit budget-shrink LRU eviction is a
separate operation. Last leases refresh eviction age without changing payload
bytes. Interrupted policy transaction files are reclaimed only under the short
policy lock; symlinks are preserved. Private indexes/ledger records use mode 0600.
Reader leases are locked and fully serialized in PID/start-time-identified staging
files before atomic publication. Under the quota lock, recovery removes only
recognized stages whose exact owner has exited and whose kernel lock is free;
live owners, unknown payloads and symlinks remain preserved and charged. An
unverifiable malformed legacy lease fails closed to complete uncached search,
not unsafe deletion of potentially live reader responsibility.

CRC and record metadata are checked when opening an index. Vector payloads are
decoded and validated once, while the complete scoring scan consumes them;
corrupt stored bytes discard the provisional attempt and rebuild using the same
query encoder. Model/runtime errors are not reclassified as cache corruption.
Discarded cached scoring work is reported separately from successful scope work.
Each metadata/scoring pass owns one Zstd decoder context reused across records;
FP16 codec1 groups are unpacked exactly eight values at a time without changing
format or precision. No global decoder or decompressed corpus is retained.
LateOn loads its fixed BPE asset directly with the same tokenization processors,
role IDs, masks and length limits rather than dynamic model-wrapper dispatch.
Validation and scoring consume mapped files in bounded resident windows; owned
ranking/trace chunks release their consumed view as well. Only
this read-only immutable-inode mapping's PTEs are released, never model arenas or
another reader's view. This does not evict shared file-cache pages or excuse them
from cgroup accounting, and does not establish a cold-page/resource gate.

## Prepared asset acquisition

The runtime bundle must include `assets.json`, a trusted catalog of the prepared
artifact repository, immutable commit, pinned source-model revisions and exact
file sizes/SHA256 values. The catalog ships with the runtime, not with a response
from the model server. Bundle updates use a new runtime/catalog; the catalog is
not a floating model selector. No Python, compiler or model conversion runs in a
query.

The qualified development bundle uses verified local prepared payloads. Its
catalog is still an unpublished development fixture, not a working public
download origin. Public distribution requires a real prepared-artifact revision;
that release operation is separate from local CPU/host qualification. Conversion-
time status markers in the original model manifests are retained for provenance
and cache identity; final numerical admission is recorded in the runtime's
`manifests/runtime.lock.json` and `manifests/quality-gates.json`.

`HF_HUB_OFFLINE` values `1`, `true`, `YES` and `On` prohibit acquisition. Missing
or damaged offline assets fail explicitly. Online acquisition uses the existing
HF client and `HF_ENDPOINT`, validates each approved prepared file and publishes
by atomic replacement rather than truncating a live mapped inode. A warm query
uses an offline verification receipt bound to device/inode/size/mtime/ctime;
changed files require full verification, not blind reuse. Read-only installations
can reverify without writing a receipt.

`--fresh-assets` rejects offline mode, acquires the selected model and required
parsers in a private temporary namespace, bypasses all corpus-index reads and
writes, and removes the namespace on normal success/failure. Marked directories
record PID/start-time so a subsequent invocation can reclaim a killed owner's
assets without deleting live directories, unmarked payload or symlink targets. It does not
modify the normal installed model store. A
`--cache-dir` override isolates its prepared model store as well as parser/index
locations; it cannot silently borrow a missing model from another store.

## CPU execution

Cache misses retain compact scope metadata, then rehydrate one source file at a
time for full scoring; supplied ripgrep groups use the same bounded source view.
Miss/no-cache paths do not heap-retain a full-corpus text or embedding matrix.
Hits mmap the complete immutable index; resident mapped pages still count toward
PSS. The v4.1 development candidate passed actual 512MiB high / 768MiB max /
zero-swap cgroup checks for text, code and whole-scope auto at 1k/10k/100k chunks,
plus a complete 778MiB index scan. The nine core cases each have 500 independent
page-hot, new-CLI measurements; boundary lengths and actual ENOSPC recovery were
checked separately. This qualifies the pinned candidate on the measured host,
not every machine, physical-host cold I/O or a reliable P99 at fewer than 1000
samples. Disk tiers do not increase the independent memory or thread ceilings.

Cached Bekko scores use a 1024-row scratch block, tiled into eight independent
document lanes. Guarded AVX2/F16C and scalar paths preserve the original FP32
sum order and the stored FP16 norm; full blocks and tails have identical scores.
LateOn consumes all token windows with Q4/D64 MaxSim. There is no ANN/prefilter.

The fixed native pool uses at most four computing threads including the caller,
inter-op=1 and no spinning. Owned `rg --files` discovery is explicitly serial,
so it does not silently add ripgrep's default worker pool; native workers are
asleep during source verification. ORT must be built with
`onnxruntime_USE_TELEMETRY=OFF`; the default OneDS telemetry backend creates an
unneeded process-lifetime SDK worker independently of the computing pool.

## Query diagnostics

`SGREP_STAGE_TIMINGS_PATH` adds observed work counters to the existing stage
report. Query calls/tokens are separate from document chunks/windows/input
tokens. `scored_document_tokens` counts scored representation rows: one aggregate
vector per Bekko chunk, selected 48D token rows for LateOn. A scope hit has zero
document encodes but still counts every scored chunk/token row. Every successful
search enforces `semantic_scored_chunks == scope_chunks + supplied_extra_chunks`.
For pure stdin the base scope is zero and deduplicated inputs are the extra scope.

`SGREP_RETRIEVAL_TRACE_PATH` is opt-in profiling output, not a latency oracle.
It records raw scores/identities for all scored chunks, the base scope's actual
BM25/semantic Top200, supplied/exact candidate additions, their union and the
final result IDs. Stdin has no discovery lanes and its union is all input chunks.
The original 75/25 fusion, exact prioritization, stable ordering and containment
rules are unchanged. The trace streams identities without retaining source text
and is atomically published only after source verification. Put diagnostics
outside the searched scope; disable retrieval tracing for normal timing samples.
These observations support evaluation but are not independent quality labels or
proof that the complete P6 resource/quality gates have passed.

## Build and runtime layout

Rust requires the declared toolchain minimum in `Cargo.toml`. Direct build:

```sh
CARGO_TARGET_DIR="$BUILD_ROOT/rust" cargo build --release --locked --manifest-path Cargo.toml
cmake -S native -B "$BUILD_ROOT/native" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DORT_SOURCE="$ORT_SOURCE" -DORT_BUILD="$ORT_BUILD"
cmake --build "$BUILD_ROOT/native" --parallel 4
cmake --install "$BUILD_ROOT/native" --prefix "$BUILD_ROOT/runtime-stage"
```

`ORT_SOURCE` is the pinned `402979ac1bef89dcd55add41eaa7277c407599eb` checkout,
with the owned patch applied. `ORT_BUILD` is its reduced non-minimal CPU `Release`
configuration with telemetry disabled, exporting the private symbols in
`native/ort-extra-symbols.txt`.
An arbitrary system ORT is not interchangeable with this backend.

Stage the native library through CMake rather than copying its build-tree `.so`:
installation rewrites its dependency search path to `$ORIGIN` only, removing the
development ORT fallback. The command above stages only the native library inside
the build area; it does not install or activate Metis. The runtime bundle also needs
the pinned reduced ORT library and its SONAME symlinks beside it, the CLI and model
assets. A missing sibling ORT must not silently load one from the development tree.

Runtime uses `assets.json`, `bin/sgrep`, `lib/libsgrep_cpu.so`, its sibling ORT library and prepared
`models/bekko128` / `models/lateon-edge` assets. `SGREP_RUNTIME_DIR` selects that
layout explicitly. Original model downloads are not directly runnable artifacts.
No model weights, binaries, build outputs, Python reference environments,
verification fixtures or comparison scripts are stored in this source directory.
