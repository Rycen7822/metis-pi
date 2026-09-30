# Codex module provenance: `@howaboua/pi-codex-conversion`

The implementation is maintained in `src/execution/ and src/code-mode/` as a metis-pi module. This directory
preserves its origin, license and local differences. The root manifest owns the
product version and dependencies; `pi update` updates metis-pi as a whole.

| | |
|---|---|
| Upstream repo | `https://github.com/IgorWarzocha/howaboua-pi-stuff` (monorepo) |
| Upstream path | `packages/pi-codex-conversion` |
| npm package | `@howaboua/pi-codex-conversion` |
| Source baseline | **3.0.34** |
| Upstream commit | `b4e228e049b7934a4350a9d9f14eaba6f9f59796` (2026-09-18, "Version Packages (#414)") |
| License | MIT — see `LICENSE` (upstream copyright, unchanged) |
| Pristine checkout | `references/howaboua-pi-stuff/` (local-only, gitignored) |

This copy retains the 3.0.34 source baseline plus the patches in `PATCHES.md`.
Selected fixes from upstream through 3.0.39 (`61b493c`) are ported: GPT-6 Sol/Luna
capabilities, Fast Mode identity preservation, branch-based saved-note reuse and
leading-system history ordering (`6accb42`, `e74d6cf`, `550b6b5`). This is not a
whole-package 3.0.39 upgrade; Notebook Mode was removed locally, and Deno changes and voice are excluded.
metis-pi owns its release and update lifecycle: the upstream npm version query and
local-checkout warning are removed, not muted. Upstream changes are compared and
selectively ported in an isolated branch, preserving the behavior in `PATCHES.md`.

## Repository layout

- `src/execution/` and `src/code-mode/` — retained local TypeScript execution tools and V8 runtime. `extensions/execution.ts` composes their lifecycle; Pi owns providers, authentication, tool selection and ordinary context management.
- `vendor/tree-sitter-bash/` — pinned shell-parser WASM with its license and provenance.
- `native/code-mode-host/` and `native/tools/` — independent Rust workspaces and build inputs. Linux x64 with glibc 2.34 or newer uses our Code Mode host release; other host targets retain pinned upstream assets.
- `assets/native-tools/` — executable Linux x64 tools. An optional `code-mode/<platform>-<arch>/` payload takes precedence over development builds and the versioned host cache.
- `src/changelog.ts` — dynamically loaded product notices using root `package.json` and `CHANGELOG.md`.
- `tsconfig.execution.json` — strict no-emit, erasable-syntax checks, included in `npm run check`.
- This provenance directory — unchanged MIT license, source baseline, local differences and `UPSTREAM_CHANGELOG.md` for historical upstream releases.

The root package ships TS and runtime assets, with no development compiler or install-time build. Old conversion entry/facade paths and the inner manifest have been removed. Extension filters and external imports must use the new TS paths. `vendor:check` now checks pi-condense only.

Pi 0.99.1 supplies providers, authentication, transcript conversion and constrained-sampling helpers. No second pi-ai copy is bundled.

## Published package

The root `package.json` publishes TypeScript, runtime WASM assets,
`assets/native-tools` payloads, `CUSTOM-TOOLS.md`, the product changelog and notices.
TypeScript is shipped and executed directly; Rust sources and development configuration remain in Git. No generated declarations are required. There is no cumulative patch or whole-tree sync command. Local/Git/npm installs require no build step. Runtime asset
paths and native executable permissions are preserved in packed releases.

## Deliberate omissions (payload scope)

The retained execution module excludes upstream voice and keeps only the native tool binaries
needed on linux-x64. Excluded, by decision:

- `src/voice/**`, `src/realtime-voice.ts`, `src/ui/settings/config-items-voice.ts` —
  the complete upstream voice implementation, including its native helper source and binaries.
- `src/tools/{exec,apply-patch,view-image}/bin/{darwin,win32}-*` and `linux-arm64` — only
  **linux-x64** native tools are vendored (this machine's platform).

Porting another platform is an explicit source/asset change: add and verify only the
required native payload, including its provenance, license and executable mode.
The retired voice implementation and unrelated platform payloads remain excluded.

Resource loaders use the canonical module URL to resolve root vendor/assets directories.
Code Mode custom-tool documentation stays beside its TS loader. Execution settings use
`metis-pi.json.execution`; the old conversion configuration is no longer read. The
versioned `pi-codex-conversion` host cache and retained execution event IDs preserve
their identities; this is a binary-cache namespace, not a compatibility configuration reader.

## Upgrading upstream

1. Create an isolated branch from the complete current source; keep a recoverable base.
2. Compare the intended upstream revision with the pinned baseline above. Selectively port
   source/assets while preserving `PATCHES.md`, the payload scope and runtime paths;
   do not overwrite this tree wholesale. `references/` is an optional comparison input.
3. Run `npm run check:execution` and `npm run verify` from a clean candidate, then verify
   local/Git/package loading and strict PTY for affected behavior. Commit source and reviewed
   module changes; there is no generated implementation output.
4. Update the reviewed upstream version/commit here and relevant `PATCHES.md`/CHANGELOG
   explanations. Git history records the actual changes; no separate patch is replayed.

## Runtime notices this copy can print

- **What's new block.** On the first fresh TUI session after the metis-pi version changes,
  `src/changelog.ts` renders root `CHANGELOG.md` entries. Its shared suppression state lives in
  `<agentDir>/howaboua-pi-stuff-changelog.json` (`{"suppress": true}` silences it — the pty harness does
  that, since the block shifts the layout its coordinate-based stages assert on).
- **Shortcuts.** The default `backgroundShellPrevShortcut` is `alt+q`, which collides with pi's built-in
  `app.message.dequeue`; pi then shows an "Extension issues" banner. Real installs set their own key in
  `metis-pi.json.execution` (for example `ui.backgroundShellPrevShortcut = "alt+u"`). The retained
  defaults are left untouched on purpose.

See `PATCHES.md` for what we change relative to upstream and why.

Pi 0.99.1 handoff retires providers, special context, Reserve, prewarm and tokenizer payload. Retained execution/V8 code and native binaries keep their original license and host pins.
