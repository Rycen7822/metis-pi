# Code mode source boundary

`vendor/code-mode-src/` is based on OpenAI Codex `rust-v0.145.0` at commit `25af12f7e61572b0bc18ddb1008be543b91519b0`.

Source copied from upstream:

- `codex-rs/code-mode-host/src`
- `codex-rs/code-mode-protocol/src`
- `codex-rs/code-mode/src`
- `codex-rs/protocol/src/tool_name.rs`
- upstream `LICENSE` and `NOTICE`

Upstream test modules are omitted. The unsupported `audio()` output helper, its Rust output variants and its model-facing audio type are also removed locally. Pi-owned TypeScript, TOML discovery, command execution, package manifests, installer scripts, and minimal Cargo packaging stay outside upstream source trees. Keep conversion-specific activation and nested tool adapters in `src/adapter/`.

The Pi bridge requires the standalone stdio host and never falls back to in-process V8. Unqualified `exec` waits 30 seconds initially; explicit pragmas, custom-tool overrides, and adaptive `wait` backoff remain authoritative.

## Linux x64 host release

On Linux x64 with glibc 2.34 or newer, the installer selects our `code-mode-host-rust-v0.145.0-metis.1` release from `Rycen7822/metis-pi`. Its only payload is `codex-code-mode-host-x86_64-unknown-linux-gnu.tar.gz`, built from the Rust source above with unsupported audio output removed. The archive SHA-256 is pinned in `src/tools/code-mode/host-assets.ts`; the selected release also names the cache directory, so an update fetches a new host instead of reusing an old one. Older glibc or musl Linux x64, Linux arm64, macOS and Windows continue using the pinned upstream `rust-v0.145.0` host. The Pi bridge rejects upstream `input_audio` results on those paths.

Build the Linux x64 asset with `scripts/build-code-mode-host-release.sh` from a clean source commit on Linux x64. The script builds the pinned Cargo workspace, strips the GNU binary, rejects a binary requiring newer than glibc 2.34, creates a reproducible archive in `.work/host-release/`, and writes `SHA256SUMS`. Verify a real V8 cell and delegated tool call with the resulting binary. Publish the archive under a release tag matching `METIS_HOST_RELEASE` only after the source commit is available in this repository; check the uploaded bytes against `SHA256SUMS`. For a later update, change the release tag and pinned hash together, run the installer and Code Mode checks, then verify a fresh cache install. Do not replace the six upstream fallback assets without their own platform builds and runtime checks.
