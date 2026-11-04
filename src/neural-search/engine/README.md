# Metis-owned Rust search engine

FFF **0.11.0** (`v0.11.0`), commit `95fd777c2529fc7b4d7572dabff64cc07268f2c5`, from [dmtrKovalenko/fff](https://github.com/dmtrKovalenko/fff). Copyright (c) 2025 Dmitriy Kovalenko; [MIT](LICENSE) retained. This is a specialized fork, not byte-identical upstream or a standalone SDK.

## Ownership and supported platform

| Owner | Contract |
| --- | --- |
| `crates/fff-core` | File/directory indexes, AI ranking, live updates, owned content reads, plain/regex/fuzzy/OR and compatible LMDB. Aho-Corasick OR verifies sensitive candidates for mixed smart-case; uniform fast paths remain. |
| `crates/fff-query-parser` | File/mixed grammar and explicit filters through zlob; needles are not filters, unsupported type: fails (use extensions/globs). |
| `crates/fff-grep` | Slice matcher/sink and line/context collection. |
| `crates/fff-c` | Private ABI v7, 16 `metis_search_*` exports in libmetis_neural_search.so / metis_neural_search.dll. Rust owns envelopes/payloads; JS copies borrowed data and releases in finally, only create transfers a finder destroyed once. Borrowed prefix is 24 bytes; release tail Rust-only. Progress owns readiness/scanning/errors. |
| `../native/binding/` | Linux/Windows x64 Node/Bun adapter, only consumed display/continuation data, no detailed rank/highlight wire objects. |
| `../assets/` | Library, paired source/binding/build/ABI manifest and notices. |

All assets/source/TS live under `src/neural-search/`; root scripts/CI build, `extensions/neural-search.ts` adapts Pi. Targets: Linux x64 **glibc ≥2.31**, Windows x64 static CRT (private exports, not bundled libgit2 exports). CPU detection/scalar fallback remains; x64 need not have AVX2. Private scores/context/limits stay covered by workspace tests.

Install uses bundled bytes, no Rust/Zig/download. Missing optional ffi-rs/library or wrong ABI fails on index use, not discovery.

## Persistent data

Preserve frecency/query-association encoding, keys/tables/retention and recognized rename/access history. Frecency/rename copies use one write transaction; open-time query cap covers the configured 10 MiB map. Never auto-open/copy/migrate old plugin/editor DBs or delete data.mdb/lock.mdb; explicit paths work, oversized/incompatible stores report failure and may fall back without persistence.

Pooled environment owns healthy/errors; trackers borrow it. Open ≠ healthy: startup maintenance/writes may be pending/failed, not permanently lost. Only successful cleanup marks startup healthy; worker-start/cleanup failures stay degraded, another tracker does not restart/reset them.

### Reader capacity

`METIS_NEURAL_SEARCH_LMDB_MAX_READERS`: default 1024, minimum 126, no FFF_LMDB_MAX_READERS alias. Existing LMDB users/lock state may hold capacity until all restart; it does not migrate paths/formats or replace global `[neuralSearch]` preferences.

## Indexing and live updates

### Scan readiness and failure

Reservation spans walk, classification, subscription ACKs and initial Git/recency attempt; busy requests coalesce without handoff gaps. Walk/commit errors are fatal. Watcher/Git-worker errors are nonfatal: committed snapshots stay searchable with degraded notices, readiness false, bounded wait ends, rescan can retry. Throttled invalidations retain dirty work on the existing owner, not extra timer threads.

Classify immutable inputs copied under lock, do IO outside it, then verify index/revision before publishing. Reclassify live unknown-extension binary→text changes; GC rereads in its write transaction and old association cleanup compares exact normalized paths. Multi-part scores accumulate before averaging; explicit content filters never disappear on zero candidates, fuzzy continuation starts at the earliest unreturned file.

Full/subtree walkers cooperate with picker shutdown at callbacks; cancelled candidates are discarded without scan-error/recovery publication, not force-aborting OS calls. A filesystem epoch detects updates a walk could overwrite; new subscriptions earn reconciliation. At most one immediate follow-up per admitted job; further debt uses the existing owner/cooldown, with classification/Git/no-op writes excluded.

### Filesystem event policy

- Recheck captured symlink policy for queued subscriptions, leaf and root-relative ancestors; stale events cannot bypass replaced directories.
- Outside working repositories, prune hidden ancestors/renamed paths; worktree hidden files remain supported.
- Register/revive empty directories independently of files; root sentinel is internal. Moved ignore definitions request retained root-policy refresh, not a differently based matcher.
- Non-missing metadata IO errors retain index and throttled recovery; explicit removal/missing/nonregular/policy-rejected paths retire entries.

Root deletion/move invalidates its watcher; prolonged absence may require explicit rescan after recreation, not promised automatic recovery.

### Git metadata and worktrees

Canonical physical roots own data/Git caches/watchers. Preserve .git-file working directories, actual worktree/submodule metadata and post-start Git initialization; never guess a gitdir parent. Config/config.worktree changes trigger refresh; distinct common dirs are watched nonrecursively, including external metadata, without dropping nested worktree data. Other-worktree indexes/config.lock/FETCH_HEAD do not trigger full status or enter the index. Only successful **full** refresh clears degradation, not a subset.

### Fuzzy file ranking

Use the same ≥2-byte effective query parts for path matching and filename bonuses; ignored one-byte terms cannot become fallback needles or distort spans. Keep case/path intent, typo limits and history keys.

## Content queries

Case policy is smart/sensitive/insensitive internally; private ABI smart-case bool chooses smart/sensitive, forced-insensitive remains a Rust capability.

### Owned bytes and cache limits

Only regular files enter content indexing. Nonblocking opens and descriptor checks prevent FIFO/type-race waits. Reads use indexed-length owned bytes/immutable caches, not file-backed mmap: truncation skips short reads rather than invalidating slices; cached snapshots update on managed invalidation, not an atomic whole-filesystem guarantee.

Retain the 4 KiB admission cutoff, file-count / 10 MiB file caps and 128/256/512 MiB repository caps, including concurrent reservations. Fresh commit owns reset/automatic sizing; explicit limits stay authoritative. Rayon jobs use bounded scratch only after uncached regular opens; cached jobs need none, cold/transfer capacity policies remain. These bounds are not process RSS limits.

### Regex fallback ownership

Compilation failure reports native metadata without literal scanning; TS adapter alone retries the original literal/filters/LF/backslashes. Private Rust callers choose explicit retry; valid regex constructs no unused literal matcher/buffer.

### Output limitations

Native compilation determines LF capability, conservatively flagged for by-line alternatives even if the matched branch is ordinary. Preserve coalesced blank-row coverage before terminator trim; actual byte/context clipping is a separate fact, not JS syntax inference or a second scan. Both survive buffered pages and report conservative outputTruncated; ordinary row counts remain, not complete per-occurrence multiline extraction.

### Pagination, revision and cancellation

Native calls are synchronous, not JS-signal interruptible; whole-file soft limits and complete zero-match semantics remain. Match/serialize captures offset+revision under one read lock; resumes and buffered rows verify it there, fuzzy suggestions match the no-hit batch. Never retag after queued writers; no-op mutable access can invalidate cursors. Guards cover managed updates, not arbitrary external interior mutation. No new full-content snapshot/ranking policy is introduced.

## Building and verification

Development only: Rust **1.94.0** + rust-docs, Zig **0.16.0**, libclang/Node; Linux additionally cargo-zigbuild **0.23.4**/readelf; Windows MSVC target, VS C++ Build Tools/SDK (cross-build variables in build-win32-x64.mjs).

```sh
rustup toolchain install 1.94.0 --component rust-docs
cargo +1.94.0 install cargo-zigbuild --locked --version 0.23.4
# Put Zig 0.16.0 on PATH.
RUSTUP_TOOLCHAIN=1.94.0 npm run build:neural-engine
npm run verify:neural-engine
```

Windows: x64 developer shell, `$env:RUSTUP_TOOLCHAIN="1.94.0"`, same npm commands. Locked ci profile uses baseline `x86_64-unknown-linux-gnu.2.31` / `x86_64-pc-windows-msvc`, rejecting host CPU overrides; manifest fixes ZLOB_ZIG_CPU=baseline. Direct Cargo profiling must not replace releases; outputs go under `.work/neural-engine/target`.

Verification pairs Rust/header/build/TS sources, exports, bytes/notices; Linux checks ELF/glibc, Windows inspects PE internally. Root verify:native-assets checks both inventories/current ABI; prepack verifies without compiling, not proof of source→binary provenance. Linux CI rebuilds and rejects differing library/manifest/notices, retains a compiled failed comparison candidate for diagnosis, not release approval.

Remap source/Cargo-home/target paths for reproducible bytes; verified PATH Zig is fixed for cargo-zigbuild/zlob, not Python's bundled Zig. Release objects/link wrappers use a toolchain-specific target subdirectory, not older compiler-policy objects.

### Checks

Keep tests for continuing filtering/ranking/context/live-update/persistence; SDK/editor/bigram-only tests retire with those features. New one-off diagnosis/migration/package probes stay in `.work/`, not permanent discovery.

```sh
mkdir -p .work/neural-engine/tmp
TMPDIR="$PWD/.work/neural-engine/tmp" \
  CARGO_TARGET_DIR="$PWD/.work/neural-engine/target" \
  cargo +1.94.0 test \
    --manifest-path src/neural-search/engine/Cargo.toml \
    --workspace --lib --locked
```

## Updates and resource lifetime

Deploy source/binding/manifest/library as **one package and restart Pi**; reload cannot unload native modules, ABI guards reject old layouts. Session/cwd releases finders; auxiliary idle expiration is five minutes via one unref timer, busy/pending leases protected, release restarts timeout, shutdown clears it. Expired roots are cold, not substituted continuations. Readiness belongs to the current watcher; failed registration stays unhealthy until successful retry.

## Redistribution

notices.mjs collects locked target runtime/build closures, bundled C and Rust stdlib notices. [licenses/SOURCE.md](licenses/SOURCE.md) pins texts absent from crates. Regenerate through builders after dependency changes; do not manually trim licenses. Manifests verify notice bytes with the library.
