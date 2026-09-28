# Vendored upstream: `@howaboua/pi-codex-conversion`

This directory is a **local copy of one npm package**, vendored into metis-pi so that metis-pi
owns it: patches live in this repo's git history instead of being wiped by `pi update`.

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
local-checkout warning are removed, not muted. Upstream synchronization is an explicit
maintainer action and must preserve all applicable local patches.

## What is here

- `src/**` — the locally maintained upstream-derived TypeScript sources, excluding the retired voice implementation. **This is where patches are made.**
- `dist/**` — build output (`tsc -p tsconfig.build.json`), **committed** so pi can load the
  extension with no build step at install time.
- `vendor/**` — runtime assets: `tree-sitter-bash.wasm`, `js-tiktoken` ranks.
- `code-mode/**` — code-mode host assets and upstream notices.
- `types/**` — public type declarations.
- `changelog.ts` / `changelog.js` — the "what's new" payload the entry imports dynamically;
  `changelog.js` is generated from `changelog.ts` by `npm run vendor:build`.
- `CHANGELOG.md` — read by the vendored changelog module (its state file is
  `<agentDir>/howaboua-pi-stuff-changelog.json`) and by the host; omitting it prints a startup warning.
- `tsconfig.build.json` — upstream, unchanged.
- `tsconfig.json` — upstream except one line: it extends `./tsconfig.base.json` instead of the
  monorepo's `../../tsconfig.base.json`, so the tree stands alone.
- `tsconfig.base.json` — upstream's monorepo base config minus `stableTypeOrdering`, which is a
  bun-only option TypeScript 5.9.3 does not accept. These two config edits are the only ones.
- `package.json` — trimmed from upstream: identity, version, license, engines, dependencies and
  peer dependencies. `private: true` (we are not republishing it); its upstream identity
  and version record provenance, not an independently updated runtime package.

## Deliberate omissions (payload scope)

The vendored copy excludes upstream voice and keeps only the native tool binaries
needed on linux-x64. Excluded, by decision:

- `src/voice/**`, `src/realtime-voice.ts`, `src/ui/settings/config-items-voice.ts` —
  the complete upstream voice implementation, including its native helper source and binaries.
- `src/tools/{exec,apply-patch,view-image}/bin/{darwin,win32}-*` and `linux-arm64` — only
  **linux-x64** native tools are vendored (this machine's platform).

Re-vendoring for another platform: adjust the native-tool exclusions in
`scripts/vendor-codex-conversion.mjs` before running `sync`. The voice exclusions
remain in place.

Runtime asset lookups are relative to the package root (the code computes it as four levels up from
`dist/tools/native/binary.js`), so the directory structure above is not free-form: `dist/`,
`vendor/`, `code-mode/`, `src/tools/<tool>/bin/<platform>-<arch>/`, `changelog.js` and
`package.json` must stay where they are.

## Upgrading upstream

1. Refresh the pristine checkout: `cd references/howaboua-pi-stuff && git fetch --depth 1 origin main && git checkout FETCH_HEAD`
2. `npm run vendor:sync` — copies the new sources over this tree, replays `patches/local.patch`,
   rebuilds `dist/`, and reports any patch that no longer applies.
3. Run the gate suite (`npm test`, `npm run check`, `npm run vendor:check`, `npm run test:pty`).
4. Update the version/commit in this file and the entry in `CHANGELOG.md`.

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
