# Execution supplement provenance

The locally maintained implementation lives in `src/execution/`, composed by
`extensions/execution.ts`. Pi owns providers, authentication, tool selection,
JS codemode and ordinary compaction. The root manifest owns this product and its updates.

| Source | Baseline | License |
| --- | --- | --- |
| IgorWarzocha/howaboua-pi-stuff, packages/pi-codex-conversion | npm 3.0.34, b4e228e049b7934a4350a9d9f14eaba6f9f59796 | MIT, see LICENSE |
| OpenAI Codex PTY/image utilities | Native helper source records under native/tools | Apache-2.0, see root LICENSE-APACHE-2.0 |

The retained conversion-derived code supplies PTY process sessions, shell display,
image loading and optional image descriptions. Native edit/write Action Fusion
uses Pi public tool factories. Earlier upstream provider/context improvements are
recorded in Git history; those implementations are retired locally.

## Current layout and payload

- `src/execution/`: process/image supplements, narrow settings and background shell UI.
- `native/tools/`: Cargo workspace for exec, view-image and their required utility crates.
- `assets/native-tools/`: Linux x64 exec/image executables, loaded by absolute path.
- `vendor/tree-sitter-bash/`: pinned shell parser WASM, license and source record.
- `tsconfig.execution.json`: strict no-emit, erasable-syntax checks.
- This directory: MIT source license, current local differences and historical upstream changelog.

The package runs TS directly and carries executable assets; install/startup does
not build Rust or download a JS host. V8, custom TOML, patch DSL, voice, Notebook
Mode and conversion-specific providers/context are not part of the current module.
Only Linux x64 helper binaries are distributed. Additional platforms require a
separate reviewed asset and source change.

## Selective upgrades

1. Compare the intended upstream change with the retained module in an isolated branch.
2. Port only changes needed by current owners; preserve process cancellation,
   output decoding/archives, image semantics, permission and native tool contracts.
   Do not sync the old conversion package wholesale.
3. Run execution/core/vendor checks and affected behavior tests, then verify
   the actual installed package and strict PTY when user interaction is affected.
4. Record reviewed source/asset changes here and in PATCHES.md. Git preserves
   implementation differences; there is no accumulated patch or generated TS copy.

Product history is recorded in the root `CHANGELOG.md`. Execution settings use
`metis-pi.json.execution`; a shortcut change requires restarting Pi.
