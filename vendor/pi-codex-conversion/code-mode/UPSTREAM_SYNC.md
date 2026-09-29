# Code mode source boundary

`vendor/code-mode-src/` is based on OpenAI Codex `rust-v0.145.0` at commit `25af12f7e61572b0bc18ddb1008be543b91519b0`.

Source copied from upstream:

- `codex-rs/code-mode-host/src`
- `codex-rs/code-mode-protocol/src`
- `codex-rs/code-mode/src`
- `codex-rs/protocol/src/tool_name.rs`
- upstream `LICENSE` and `NOTICE`

Upstream test modules and the unused Rust `remote_session` client are omitted. The two `ProcessOwnedCodeModeSession*` exports are removed: the only shipped Rust consumer is the stdio host, which constructs `InProcessCodeModeSession` directly, while the Pi-facing client lives in TypeScript. The runtime crate no longer enables Tokio process/I/O features; host and protocol crates retain their own stdio dependencies. The unsupported `audio()` output helper, its Rust output variants and its model-facing audio type are also removed locally. Pi-owned TypeScript, TOML discovery, command execution, package manifests, installer scripts, and minimal Cargo packaging stay outside upstream source trees. Keep conversion-specific activation and nested tool adapters in `src/adapter/`.

The Pi bridge requires the standalone stdio host and never falls back to in-process V8. Unqualified `exec` waits 30 seconds initially; explicit pragmas, custom-tool overrides, and adaptive `wait` backoff remain authoritative.

## Selected runtime and V8 updates

The original source pin stays at 0.145.0. The following changes are backported from Codex 0.159.0 (`687a119f0fcaace47e1f1abcc77cec6c813fd6da`) without importing its runtime split, gRPC, telemetry or audio support:

| Upstream commit | Local behavior |
| --- | --- |
| `c1f1467f3028bd433c8f2063ecc28dd5be206df6` | Explicit undefined tool input follows omitted input handling. |
| `d77ebc72237a639b6d877f2edc3b20b54631f25e` | Tokio timers cancel when cleared or the cell runtime drops. |
| `1afffeabb2aaaed78d209d23864265ab6a45cd06` | Short delivery scopes let discarded tool results be collected. |
| `dd6eff3954949d074ca45ee80da89499b955bf8e` | Cells share immutable JSON payloads through Arc while snapshotting keys. |
| `12b3e88028b983051913fb6bb95d7a11218bdceb` | Rust v8 crate 150.4.0, corresponding to V8 15.0.245.2. |
| `2e32d958949792e0747bd9b24293778fec431012` | Sandbox is required by the crate and matching binary inputs. |
| `aaa2cabfbcb8d9997ce67e166f796f46d5b72342` | Disable Maglev, Turbolev and Turbo inline array builtins before initialization; ordinary JIT stays enabled. |
| `c0b6285711f788cfb65c6e46c6f23fa0f2a8b3ec` | Authenticate matching archive/binding inputs and keep public release assets immutable. |

Storage keeps the existing contract: load creates independent JS values; a later commit cannot mutate another cell's snapshot. Ordinary cell errors can commit preceding writes, whereas explicit termination discards uncommitted writes.

## Linux x64 host release

On Linux x64 with glibc 2.34 or newer, the installer selects our `code-mode-host-rust-v0.145.0-metis.2` release from `Rycen7822/metis-pi`. Its only payload is `codex-code-mode-host-x86_64-unknown-linux-gnu.tar.gz`, built from source `47adbb43711db857d6f401615ec99cd8d5d53eb6` with the selected runtime/V8 updates above and unsupported audio output removed. The archive SHA-256 is pinned in `src/tools/code-mode/host-assets.ts`; the selected release also names the cache directory, so an update fetches a new host instead of reusing an old one. Older glibc or musl Linux x64, Linux arm64, macOS and Windows continue using the pinned upstream `rust-v0.145.0` host. The Pi bridge rejects upstream `input_audio` results on those paths.

Build the Linux x64 asset with `scripts/build-code-mode-host-release.sh` from a clean source commit on Linux x64. The script derives the exact V8 crate version, authenticates the release manifest against `v8-release-manifests.sha256`, then verifies both the `ptrcomp_sandbox_release` GNU archive and its binding. Its cache lives under `${CARGO_TARGET_DIR:-.work/host-build}/v8-inputs/<version>/<target>/<profile>`. Valid cached inputs work offline; corrupt inputs or conflicting V8 build environment overrides stop the build. Downloads use curl and honor HTTPS_PROXY.

The script builds with `--release --locked`, strips the binary, rejects a requirement above glibc 2.34, then writes a deterministic tar/gzip and SHA256SUMS. Repeating packaging from the same executable must produce identical bytes; this alone does not claim reproducibility across different build environments. Users download the prebuilt host and do not compile Rust or V8 locally.

For each update:

1. Verify real host execution, GC, timer lifecycle, sandbox, sorting and package extraction. Temporary internal probes stay outside shipped sources. Node protocol tests alone do not verify V8.
2. Commit and push source A while the installer still selects the previous public asset. Tag A with a new metis revision; refuse a tag already assigned to another source or an existing public release.
3. Upload the archive and SHA256SUMS to a draft release using `gh release create --draft --verify-tag --notes-file`. Record source A and build inputs. Verify downloaded draft bytes and tag provenance, then publish and verify the public download.
4. Never overwrite public assets or use `--clobber`. To resume a draft, first verify its source commit and existing bytes; different bytes under an existing asset name require stopping and resolving the mismatch.
5. Only after the asset is publicly available, activate its tag and checksum together in commit B. Verify empty cache, coexistence with old cache, reuse of the new cache and an isolated Pi Code Mode session; then push B and check CI.

Rollback uses a new commit restoring the previous tag/checksum pair. Keep previous assets and caches available. Do not replace the six upstream fallback assets without their own platform builds and runtime checks.
