# Vendored upstream: `@howaboua/pi-codex-conversion`

This directory is a **locally maintained fork of one npm package**. Its source and
Git history own local changes; `pi update` updates metis-pi as a whole.

| | |
|---|---|
| Upstream repo | `https://github.com/IgorWarzocha/howaboua-pi-stuff` (monorepo) |
| Upstream path | `packages/pi-codex-conversion` |
| npm package | `@howaboua/pi-codex-conversion` |
| Vendored version | **3.0.34** |
| Upstream commit | `b4e228e049b7934a4350a9d9f14eaba6f9f59796` (2026-09-18, "Version Packages (#414)") |
| License | MIT — see `LICENSE` (upstream copyright, unchanged) |
| Pristine checkout | `references/howaboua-pi-stuff/` (local-only, gitignored) |

This copy deliberately stays on the 3.0.34 baseline + the patches in `PATCHES.md`.
metis-pi owns its release and update lifecycle: the upstream npm version query and
local-checkout warning are removed, not muted. Upstream changes are compared and
selectively ported in an isolated branch, preserving the behavior in `PATCHES.md`.

## What is here

- `src/**` — locally maintained, directly executed TypeScript; edit implementation here.
- `dist/*.js` — eight small hand-written public/entry re-exports to `src/*.ts`. Keeping `dist/index.js` preserves Pi's existing extension filters and tool ownership path; internal consumers share canonical TS URLs.
- `vendor/**` — runtime tokenizer ranks and tree-sitter WASM.
- `code-mode/**` and `src/tools/**/rust` — unchanged native source, build inputs and notices; native binaries retain their existing paths.
- `types/**` — source declarations.
- `changelog.ts` — the dynamically loaded changelog program; `changelog.js` preserves its former default-export path. `CHANGELOG.md` remains required.
- `tsconfig.json` / `tsconfig.base.json` — standalone no-emit, erasable-syntax type checks.
- `package.json` — upstream-derived identity, runtime/peer dependencies and engines; main remains the old entry facade.

The root package ships TS, public facades and runtime assets, with no development compiler or install-time build. `npm run vendor:build` and `vendor:fresh` remain aliases of the source checks. Generated `.d.ts` or deep dist JS are not runtime inputs.

Pi 0.87.0 or newer supplies the shared transcript and constrained-sampling helpers. Local wrappers retain historical-session compatibility and resolve the sampling API through the running host's public package exports; no second pi-ai copy is bundled.

## Published package

The root `package.json` publishes TypeScript, small compatibility re-exports, runtime tokenizer/WASM assets,
native `src/tools/*/bin` payloads, `CUSTOM-TOOLS.md`, changelog, manifests and notices.
TypeScript is shipped and executed directly; Rust sources and development configuration remain in Git. No generated declarations are required. There is no cumulative patch or whole-tree sync command. Local/Git/npm installs require no build step. Runtime asset
paths and native executable permissions are preserved in packed releases.

## Deliberate omissions (payload scope)

The vendored copy excludes upstream voice and keeps only the native tool binaries
needed on linux-x64. Excluded, by decision:

- `src/voice/**`, `src/realtime-voice.ts`, `src/ui/settings/config-items-voice.ts` —
  the complete upstream voice implementation, including its native helper source and binaries.
- `src/tools/{exec,apply-patch,view-image}/bin/{darwin,win32}-*` and `linux-arm64` — only
  **linux-x64** native tools are vendored (this machine's platform).

Porting another platform is an explicit source/asset change: add and verify only the
required native payload, including its provenance, license and executable mode.
The retired voice implementation and unrelated platform payloads remain excluded.

Runtime asset lookups are relative to the package root (the code computes it as four levels up from
`src/tools/native/binary.ts`), so the directory structure above is not free-form: `src/`,
`vendor/`, `code-mode/`, `src/tools/<tool>/bin/<platform>-<arch>/`, `changelog.js` and
`package.json` must stay where they are.

## Upgrading upstream

1. Create an isolated branch from the complete current source; keep a recoverable base.
2. Compare the intended upstream revision with the pinned baseline above. Selectively port
   source/assets while preserving `PATCHES.md`, the payload scope and runtime paths;
   do not overwrite this tree wholesale. `references/` is an optional comparison input.
3. Run `npm run vendor:build` and `npm run verify` from a clean candidate, then verify
   local/Git/package loading and strict PTY for affected behavior. Commit source and reviewed
   facade changes; there is no generated implementation output.
4. Update the reviewed upstream version/commit here and relevant `PATCHES.md`/CHANGELOG
   explanations. Git history records the actual changes; no separate patch is replayed.

## Runtime notices this copy can print

- **What's new block.** On the first session after the vendored version changes, the vendored changelog
  module renders that version's `CHANGELOG.md` entries into the transcript. Its state lives in
  `<agentDir>/howaboua-pi-stuff-changelog.json` (`{"suppress": true}` silences it — the pty harness does
  that, since the block shifts the layout its coordinate-based stages assert on).
- **Shortcuts.** The default `backgroundShellPrevShortcut` is `alt+q`, which collides with pi's built-in
  `app.message.dequeue`; pi then shows an "Extension issues" banner. Real installs set their own key in
  `pi-codex-conversion.json` (this machine uses `ui.backgroundShellPrevShortcut = "alt+u"`). The vendored
  defaults are left untouched on purpose.

See `PATCHES.md` for what we change relative to upstream and why.
