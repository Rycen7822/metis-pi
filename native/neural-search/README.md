# Metis-owned Rust search engine

Based on FFF **0.11.0** (`v0.11.0`), commit `95fd777c2529fc7b4d7572dabff64cc07268f2c5` from <https://github.com/dmtrKovalenko/fff>.
Copyright (c) 2025 Dmitriy Kovalenko; MIT terms remain in `LICENSE`.
Metis maintains a specialized fork, not a byte-identical copy or a standalone FFF SDK.

## Ownership and supported platform

- `crates/fff-core`: file/directory indexes, AI ranking, live filesystem updates, content reads, plain/regex/fuzzy/OR orchestration and compatible LMDB storage.
  Literal OR uses Aho-Corasick, verifying sensitive candidates for mixed smart-case without changing uniform-case fast paths.
  Content-bigram indexing, editor mode and unused SDK operations are retired.
- `crates/fff-query-parser`: file/mixed query grammar and explicit content filters, using the single `zlob` backend.
  Content needles are not filter expressions. Unsupported `type:` filters fail explicitly; use extensions/globs.
- `crates/fff-grep`: slice searching, matcher/sink interfaces and line/context collection.
- `crates/fff-c`: private **ABI v6** in `libmetis_neural_search.so`, with `metis_search_*` symbols.
  Rust owns result envelopes and payloads; JS copies a borrowed view and releases the envelope in `finally`.
  Only creation transfers an instance, subsequently destroyed once. This is not a public C SDK.
- `src/neural-search/native/binding/`: one Linux Node/Bun binding.
  Only consumed display/continuation data crosses it, not detailed rank/highlight objects.
- `assets/neural-search/`: bundled library, paired source/binding/build/ABI/hash manifest and redistribution notices.

Only **Linux x64 with glibc >=2.31** is delivered. There are no other-platform builds or upstream binary fallbacks.
Runtime CPU detection and scalar fallbacks remain: x64 does not imply AVX2.

Ordinary installation uses the bundled library, needs **no Rust/Zig compiler** and performs no engine download.
Missing optional `ffi-rs`, missing library bytes or an ABI mismatch fail on index use, not during tool discovery.

## Persistent data

Frecency/query-association encoding, keys, named tables and retention remain supported.
Frecency updates and rename-history copies use one write transaction; the query open-time cap covers its configured 10 MiB map.
AI filesystem events still record access and copy history for recognized renames.

No old plugin/editor database is opened, copied or migrated automatically. Explicit database paths remain supported.
Oversized or incompatible databases are **not erased or repaired**: initialization reports the problem and the host may retry without persistence.
Never remove `data.mdb` or `lock.mdb` as automatic recovery.

Database health preserves the store's healthy flag and errors.
An opened store is not necessarily healthy: false can mean pending/failed startup maintenance or failed writes, not proof of permanent data loss.
Cleanup success alone marks initialization healthy; cleanup or worker-start failure remains degraded.

### Reader capacity

`METIS_NEURAL_SEARCH_LMDB_MAX_READERS` is the low-level capacity override (default 1024, minimum 126).
The former `FFF_LMDB_MAX_READERS` name is not an alias.
Global search preferences still belong to `[neuralSearch]`; this override is not a second preference source.

Existing LMDB users/lock state can determine capacity until all users restart.
Renaming the override does not migrate database formats or paths.

## Indexing and live updates

### Scan readiness and failure

A scan reservation covers walking, classification, subscription acknowledgements and the initial Git status/recency attempt.
Busy requests coalesce without an idle handoff gap.

- Walk/commit failures remain fatal through progress and health.
- Watcher initialization and Git-worker failures are separate non-fatal diagnostics.
  A committed index stays searchable with unavailable-monitoring or degraded-metadata notices.
- Failed monitoring keeps readiness false; rescan can retry without destroying the usable snapshot.
  A completed scan with unavailable monitoring returns partial state without spending the rest of the host's bounded timeout.
- Throttled invalidations retain a dirty request on the existing watcher owner.
  They are not discarded and do not create new timer threads.

Classification copies immutable inputs under the index lock, performs IO outside it, then checks index identity/content revision before publishing results.

A separate filesystem-mutation epoch detects live updates that a candidate walk could overwrite.
New monitoring coverage is reconciled after subscription, including newly imported descendants.
One immediate automatic follow-up is allowed per admitted job; further coverage debt stays incomplete and uses the existing owner/cooldown instead of an unbounded scan loop.
Classification, Git metadata and no-op control writes do not create filesystem debt.

### Filesystem event policy

Live admissions preserve the walk's symlink and hidden-path rules:

- Queued directory subscriptions recheck symlink policy before watching.
  Leaf events also check ancestors within the search root, so stale queued events cannot bypass a rejected replacement directory.
- Non-working-repository hidden paths remain pruned, including hidden ancestors and renamed directories.
  Git worktree hidden files remain supported.
- New directories and empty descendants register/revive rows independently of file additions.
  The empty root bookkeeping sentinel is not a search result.
- Moved-in ignore definitions request a retained root-policy rescan, not a replacement matcher based at a different directory.
- Non-missing metadata IO failures retain the previous index and request retained/throttled recovery.
  Explicit removal, missing targets, nonregular files and policy-rejected symlinks still retire entries.

Root deletion/move invalidates the current watcher immediately.
If recovery fails while the root remains absent, recreate it and explicitly rescan to install fresh monitoring.
Automatic recovery after an arbitrarily long absence is not promised.

### Git metadata and worktrees

Search roots resolve symlink aliases to one physical identity for data paths, Git caches and watcher events.
Discovery preserves the working directory when a `.git` file points to separate metadata; it does not reopen the gitdir and guess its parent.
Subscriptions use the actual repository directory for worktrees/submodules and refresh when a repository is initialized after startup.

- Status-affecting `config`/`config.worktree` writes trigger targeted refreshes, even without a directory identity change.
- Linked worktrees subscribe non-recursively to a distinct common directory, including external metadata, and recognize shared config changes.
- A worktree inside that common directory still routes its files as data.
  Other-worktree indexes, `config.lock` and `FETCH_HEAD` do not trigger another full status pass or enter the file index.
- A recorded Git failure stays degraded until a successful full refresh.
  A successful path subset cannot establish recovery.

## Content queries

### Owned bytes and cache limits

Workspace content uses indexed-length owned reads and immutable cached bytes, never file-backed mmap.
External truncation cannot invalidate a borrowed search slice. Short reads are skipped; cached bytes remain a previous snapshot until managed invalidation.
This is not an atomic filesystem-wide content snapshot.

Only regular files enter the content index.
Classification and content reads use nonblocking opens and descriptor type checks, so a FIFO or raced type change cannot wait for a pipe writer.

Cache admission retains its 4 KiB cutoff, file-count caps, 10 MiB per-file limit and 128/256/512 MiB repository byte caps.
Concurrent reservations cannot exceed those caps.
Fresh-index commit owns cache reset and automatic sizing together; explicit limits remain authoritative, with no independent budget replacement.

Owned snapshots consume private heap rather than file-backed pages. Each active worker can also hold a bounded read buffer.
Cache limits are **not a total RSS ceiling**.

### Output limitations

Emitted native rows carry facts about actual cross-line matches, coalesced regions and native byte projection loss.
The SDK no longer guesses multiline limitations from regex source syntax.
These facts survive buffered pages and cause explicit notices and conservative `outputTruncated` metadata.
Ordinary single-line matches keep their row counts; this does not promise complete per-occurrence multiline extraction.

### Pagination, revision and cancellation

Native queries are synchronous and cannot be interrupted mid-call by a JS abort signal.
Whole-file soft pagination and complete zero-match semantics remain.

Matching/serialization captures the conservative index revision under the same native read lock.
Cursors carry offset plus revision; continuations verify both under that lock before applying an offset.

Fresh queries remain valid read-consistent batches even if a queued writer runs immediately afterwards; never retag them with a later revision.
Buffered rows also check the saved revision, and optional fuzzy suggestions must match the exact no-match batch's revision.

No full content snapshot or ranking change is introduced. No-op mutable access can invalidate a continuation.
These guards cover Metis-managed updates, not arbitrary interior mutation by external Rust consumers.

## Building and verification

Development prerequisites:

- Rust **1.94.0** with `rust-docs`, which supplies standard-library notices.
- Zig **0.16.0** on PATH and `cargo-zigbuild` **0.23.4**.
- Node and GNU binutils (`readelf`).

Tool installation is separate from ordinary package installation:

```sh
rustup toolchain install 1.94.0 --component rust-docs
cargo +1.94.0 install cargo-zigbuild --locked --version 0.23.4
# Put Zig 0.16.0 on PATH.
RUSTUP_TOOLCHAIN=1.94.0 npm run build:neural-engine
npm run verify:neural-engine
```

The builder uses the locked graph, `ci` profile, `x86_64-unknown-linux-gnu.2.31` and baseline x64 CPU settings.
It rejects host-specific CPU overrides and pins `ZLOB_ZIG_CPU=baseline` for the Zig helper in the manifest.
Local profiling may use Cargo directly, but must not replace the published artifact. Outputs stay under `.work/neural-engine/target`.

Verification checks paired Rust/header/build and TS binding sources, exported ABI, ELF dependencies, glibc symbol floor, library bytes and notices.
Packing a source/Git checkout also requires Linux x64 and GNU binutils; delivery checks are not skipped on unsupported hosts.
`prepack` verifies without compiling Rust; this checks declared source, library, ABI and notice consistency, not proof that the library was compiled from those sources.
CI also rebuilds with the pinned toolchain and rejects any difference from the checked-in library, manifest or notices.
Rust source locations are remapped to stable workspace, Cargo-home and target prefixes so local checkout paths do not become shipped bytes.

### Checks

Inherited unit checks stay with continuing behavior.
SDK/editor/bigram-only checks retire with those features; shared filtering, sorting, context, live updates and persistence protection remain.

New one-off diagnosis, migration and package probes belong **only under `.work/`**, never in permanent test discovery.

```sh
mkdir -p .work/neural-engine/tmp
TMPDIR="$PWD/.work/neural-engine/tmp" \
  CARGO_TARGET_DIR="$PWD/.work/neural-engine/target" \
  cargo +1.94.0 test \
    --manifest-path native/neural-search/Cargo.toml \
    --workspace --lib --locked
```

## Updates and resource lifetime

**Restart Pi after updating or rolling back the native engine.**
Native modules are process-cached; `/reload` alone does not unload them. ABI/cache guards reject mismatched layouts rather than reinterpret old pointers.

Finder instances release resources when their session/cwd lifetime ends.
Readiness comes from the current watcher instance, not a shared success latch; failed registrations stay unhealthy and rescan can retry them.

Deploy source, binding, manifest and library as **one package**, not independently.

## Redistribution

`notices.mjs` collects the locked Linux runtime/build dependency closure, including bundled C notices, and retains Rust standard-library notices.
`licenses/` supplies pinned texts missing from some published crates; provenance is in `licenses/SOURCE.md`.

Regenerate notices through the builder after dependency removal, not by trimming copyright/license text manually.
The manifest verifies distributed notice bytes alongside the library.
