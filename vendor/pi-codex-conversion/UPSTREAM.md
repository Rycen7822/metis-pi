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

## What is here

- `src/**` — the 321 upstream TypeScript sources. **This is where patches are made.**
- `dist/**` — build output (`tsc -p tsconfig.build.json`), **committed** so pi can load the
  extension with no build step at install time.
- `changelog.ts` / `changelog.js` — the "what's new" payload the entry imports dynamically;
  `changelog.js` is generated from `changelog.ts` by `npm run vendor:build`.
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
  peer dependencies. `private: true` (we are not republishing it); the runtime reads
  `name` + `version` out of this file for its "npm is ahead of this checkout" notice.

## Deliberate omissions (payload scope)

Upstream ships 73 MB (43 MB of it voice helper binaries). This copy is **11.7 MB of real file bytes**:
`dist/` 1.8 MB, `src/` 5.9 MB (of which the linux-x64 native tools are 3.7 MB), runtime assets `vendor/`
3.5 MB, `code-mode/` 0.4 MB. Excluded, by decision:

- `src/voice/bin/**` — the 43 MB of per-platform voice helper binaries. Voice features therefore
  fail at use time (not at load time).
- `src/tools/{exec,apply-patch,view-image}/bin/{darwin,win32}-*` and `linux-arm64` — only
  **linux-x64** native tools are vendored (this machine's platform).

Re-vendoring for another platform: rerun the copy with a wider `--exclude` set (see
`scripts/vendor-codex-conversion.mjs`, `sync` action).

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
- **"Behind npm" notice.** Because this copy is not under `node_modules`, upstream's local-checkout
  logic compares its `package.json` version against the published npm version and warns when npm is
  ahead. Treat that warning as an upstream-moved signal: run the upgrade procedure below.
- **Shortcuts.** The default `backgroundShellPrevShortcut` is `alt+q`, which collides with pi's built-in
  `app.message.dequeue`; pi then shows an "Extension issues" banner. Real installs set their own key in
  `pi-codex-conversion.json` (this machine uses `ui.backgroundShellPrevShortcut = "alt+u"`). The vendored
  defaults are left untouched on purpose.

See `PATCHES.md` for what we change relative to upstream and why.
