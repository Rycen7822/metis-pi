# Metis-owned Rust search engine

Based on FFF **0.11.0**, tag `v0.11.0`, commit `95fd777c2529fc7b4d7572dabff64cc07268f2c5` in <https://github.com/dmtrKovalenko/fff>. Copyright (c) 2025 Dmitriy Kovalenko; MIT terms remain in `LICENSE`. Metis now maintains a specialized fork, not a byte-identical copy or a standalone FFF SDK.

## Ownership and scope

- `crates/fff-core`: local file/directory indexes, AI ranking, live filesystem updates, content reads and compatible LMDB persistence. Content-bigram indexing, editor-specific mode and unused SDK operations are not supported.
- `crates/fff-query-parser`: file/mixed query grammar and explicit content filters, using the single `zlob` backend. Content needles are not parsed as filter expressions. Unsupported `type:` filters fail explicitly; use extensions/globs.
- `crates/fff-grep`: shared slice matching, line/context collection and plain/regex/fuzzy execution. Literal OR continues to use Aho-Corasick.
- `crates/fff-c`: private **ABI v3** in `libmetis_neural_search.so`, with `metis_search_*` symbols. Rust owns each result envelope and its payload; JS copies a borrowed view then releases the envelope in `finally`. Only index creation explicitly transfers an instance, subsequently destroyed once. The header and owned `ffi-rs` binding are not a public C SDK.
- `src/neural-search/native/binding/`: one Linux Node/Bun binding. Only required display/continuation data crosses the boundary; detailed rank/highlight objects are not a supported SDK surface.
- `assets/neural-search/`: ready-to-load library, source/binding/build/ABI/hash manifest and redistribution notices.

Only **Linux x64 with glibc >=2.31** is delivered. No Windows/macOS/Android/ARM/musl builds or upstream binary fallbacks. x64 CPU feature detection and scalar fallbacks remain: x64 does not imply AVX2. Ordinary installation uses the bundled library, needs **no Rust/Zig compiler**, and performs no automatic engine download. Missing optional `ffi-rs`, missing library bytes or an ABI mismatch fail explicitly on index use, not tool discovery.

## Data and lifecycle

Existing frecency/query-association encoding, keys, named tables and retention remain supported. Frecency read/modify/write and rename-history copying use one write transaction; the query open-time cap covers its configured 10 MiB map. AI filesystem events still record access and copy history for recognized renames. No old plugin/editor database is opened, copied or migrated automatically; explicit database paths are still honored. Oversized or incompatible databases are **not erased or repaired**: native initialization reports the problem and the host may retry without persistence. Never remove `data.mdb`/`lock.mdb` as an automatic recovery step.

The low-level capacity override is `METIS_NEURAL_SEARCH_LMDB_MAX_READERS` (default 1024, valid values >=126). The former `FFF_LMDB_MAX_READERS` name is not an alias. This is not a second preference source; global search preferences remain in `[neuralSearch]`. Existing LMDB users/lock state can determine capacity until all users restart; no data-format migration accompanies the rename.

Scan admission reserves one queued/running job; busy requests coalesce until it finishes walking, classifying and installing its watcher. Readiness waits for those phases rather than just the filesystem walk. Classification copies immutable inputs under the index lock, performs IO outside it, then checks index identity/content revision before applying results. This protects Rust ownership, not a filesystem-wide content snapshot. mmap caching/fresh reads remain; external in-place truncation is not made safe by a watcher lock. Native queries are synchronous and cannot be interrupted mid-call by a JS abort signal. Whole-file soft pagination and complete zero-match search semantics remain.

## Build and verify

Prerequisites: Rust **1.94.0** with `rust-docs`, Zig **0.16.0** on PATH, `cargo-zigbuild` **0.23.4**, Node and GNU binutils (`readelf`). Rust documentation supplies the matching standard-library notices. Development tool installation is separate from ordinary package installation:

```sh
rustup toolchain install 1.94.0 --component rust-docs
cargo +1.94.0 install cargo-zigbuild --locked --version 0.23.4
# Put Zig 0.16.0 on PATH.
RUSTUP_TOOLCHAIN=1.94.0 npm run build:neural-engine
npm run verify:neural-engine
```

The builder uses the locked graph, `ci` profile, `x86_64-unknown-linux-gnu.2.31`, and explicit baseline x64 CPU settings. It rejects host-specific CPU overrides; local profiling may use Cargo directly, but must not replace the published artifact. Outputs remain under `.work/neural-engine/target`. Verification checks the paired Rust/header/build and TS binding sources, exact exported ABI, ELF dependencies, glibc symbol floor, library bytes and notices. Packing a source/Git checkout therefore requires Linux x64 and GNU binutils as well; these delivery checks are not skipped on unsupported hosts. `prepack` verifies without compiling Rust; CI verifies the committed payload and rebuilds it.

Inherited unit checks stay with the continuing implementation. Tests solely for retired SDK/editor/bigram behavior retire with that behavior; shared filtering, sorting, context, live updates and persistence protection remain. New one-off diagnosis/migration/package probes belong only under `.work/`, never permanent test discovery.

```sh
mkdir -p .work/neural-engine/tmp
TMPDIR="$PWD/.work/neural-engine/tmp" CARGO_TARGET_DIR="$PWD/.work/neural-engine/target" cargo +1.94.0 test --manifest-path native/neural-search/Cargo.toml --workspace --lib --locked
```

Native modules are process-cached. **Restart Pi after updating or rolling back the native engine**; `/reload` alone does not unload it. ABI/cache version guards refuse mismatched layouts rather than reinterpret old pointers. Finder instances still release their resources when their session/cwd lifetime ends. Deploy source, binding, manifest and library as one package, not independently.

## Redistribution

`notices.mjs` collects the locked Linux runtime/build dependency closure, including bundled C notices, and retains Rust standard-library notices. `licenses/` supplies pinned upstream texts missing from some published crates; provenance is in `licenses/SOURCE.md`. Regenerate notices through the builder after dependency removal, not by trimming copyright/license text manually. The manifest verifies the distributed notice bytes alongside the library.
