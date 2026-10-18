# Metis-owned Rust search engine

This is the maintained runtime source closure from FFF **0.11.0**, tag `v0.11.0`, commit `95fd777c2529fc7b4d7572dabff64cc07268f2c5` in <https://github.com/dmtrKovalenko/fff>. Copyright (c) 2025 Dmitriy Kovalenko; MIT terms are retained in `LICENSE`. Local package/build changes are maintained by Metis.

## Ownership and scope

- `crates/fff-core`, `fff-query-parser`, `fff-grep`: original Rust searching, matching, index/watch and LMDB implementation.
- `crates/fff-c`: the original instance-based C ABI, built as `libmetis_neural_search.so`. Existing C symbol names and create-options ABI v2 remain private implementation details.
- `src/neural-search/native/binding/`: Metis's single, reduced `ffi-rs` binding for Linux Node and Bun. It is not a replacement public SDK for the old packages.
- `assets/neural-search/`: tracked, ready-to-load library, source/build/ABI/hash manifest and redistribution notices.

Only **Linux x64 with glibc >= 2.31** is delivered. No Windows, macOS, Android, ARM or musl builds/fallbacks are provided. Ordinary installation uses the bundled library and needs **no Rust or Zig compiler**. Missing optional `ffi-rs` or library bytes fail on actual index use, not tool discovery. No upstream FFF npm package or automatic binary download is used.

The scanner/glob backend remains `zlob`, matching the original released engine; switching to the default `ripgrep`/globset feature would change query semantics and is not part of this migration. Rust crate dependencies (and the Zig-built zlob helper) remain locked third-party build dependencies, not separate Pi plugins. Search algorithms and database format are unchanged. No old user database is copied, migrated or opened automatically.

## Build and verify

Development/release prerequisites: Rust **1.94.0** including `rust-docs`, Zig **0.16.0** on PATH, `cargo-zigbuild` **0.23.4**, Node and GNU binutils (`readelf`). The Rust documentation component supplies the matching standard-library redistribution notices.

```sh
rustup toolchain install 1.94.0 --component rust-docs
cargo +1.94.0 install cargo-zigbuild --locked --version 0.23.4
# Install Zig 0.16.0 and put its directory on PATH.
RUSTUP_TOOLCHAIN=1.94.0 npm run build:neural-engine
npm run verify:neural-engine
```

The builder uses the locked Cargo graph, `ci` profile and `x86_64-unknown-linux-gnu.2.31` target. Outputs stay under `.work/neural-engine/target`; no build is run by the normal install lifecycle. The build records source hashes, compiler/flags, native exports, ELF dependencies and glibc symbol requirements. Verification requires exact source, library and notice bytes; `prepack` runs it without compiling Rust. CI verifies the checked-in asset, rebuilds from owned sources, runs inherited Rust unit checks and retains the resulting Linux artifact.

Inherited inline Rust unit checks remain with their source. Unrelated upstream benchmark/integration suites, fixtures and application crates were not imported. One-off migration/ABI/package comparisons belong under `.work/`, never the permanent test suite.

```sh
mkdir -p .work/neural-engine/tmp
TMPDIR="$PWD/.work/neural-engine/tmp" CARGO_TARGET_DIR="$PWD/.work/neural-engine/target" \
  cargo +1.94.0 test --manifest-path native/neural-search/Cargo.toml \
  --workspace --lib --locked --no-default-features --features zlob
```

Native modules remain cached for the process lifetime. **Restart Pi after updating the native engine**; `/reload` alone is not an engine unload/reload operation. Finder instances still release their own native resources when their session/cwd lifetime ends.

## Redistribution

`notices.mjs` collects the locked Linux runtime/build dependency closure's license texts, including bundled C library notices. It also retains the Rust standard-library notices. `licenses/` supplies pinned upstream texts omitted by a few published crates; provenance is in `licenses/SOURCE.md`. Regenerate notices through the builder, not by hand. The manifest verifies the distributed notice bytes alongside the library.
