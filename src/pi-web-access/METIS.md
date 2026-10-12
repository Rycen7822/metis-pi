# Metis-maintained pi-web-access

Upstream: https://github.com/nicobailon/pi-web-access

Source version: **0.38.0**, commit `7e6e2386dc9a31d5e2a448172060dd1339c604f7`.
Copyright (c) 2025 Nico Bailon; the upstream MIT license is retained in `LICENSE`.

Metis owns the source in this directory. `references/pi-web-access` is temporary
reference material and is neither tracked nor used for installation.

Local compatibility changes:

- The Metis entrypoint registers only `web_access`, with deferred exposure and
  per-action parameter discovery. The registration callback retains enabled
  operations internally; nested search tracking and stored-content guidance use
  the grouped entrypoint. The standalone upstream entrypoint and MCP keep their
  original registration and activation behavior.
- Ordinary preferences are maintained in the existing global `metis-pi.toml`
  under `[webAccess]`. Credentials, authentication headers and authenticated
  proxies retain JSON/env/command sources; `web-search.json` shares the TOML
  directory. Metis initialization/migration backs up legacy mixed JSON and
  relocates credentials without removing external originals.
- Pi tools, provider adapters and standalone MCP share the Metis configuration
  owner. Bundles retain external imports of the shared TS modules so packaged
  template paths stay correct; the Metis Node >=22.19 engine supports them.

- Summary generation and the model picker include the preferred Luna and Terra
  models under both `openai` and `openai-codex`.
- Search accepts either provider name for `openai-codex-responses`, while keeping
  the Codex API and backend-address checks. Official `openai-responses` retains
  its existing official API route.
- Type checking enables strict null checks so validated objects and native auth
  result unions narrow correctly under the Metis TypeScript version.
- The proxy-agent error fixture sets both uppercase and lowercase proxy names,
  so inherited proxy settings cannot hide the intended invalid URL.

`extensions/web-access.ts` loads the generated extension bundle. Build both that
bundle and the standalone MCP entry from the maintained source with
`npm run build:plugins` at the Metis root. Dependencies and the lockfile are owned
by the Metis root; do not install or update this directory as a separate package.
The standalone MCP bundle includes `typebox` 1.3.27; its license is retained in
`licenses/typebox.LICENSE`. Keep that notice in sync when changing this bundled dependency.

When adopting a new upstream version, compare it against the pinned commit,
preserve these compatibility changes, update the entrypoint provenance comment,
and run the relevant upstream tests plus the Metis package/loader checks before
rebuilding the bundles. Preserve Metis preferences and authentication sources;
migration preserves legacy cache locations via cacheRoot without moving cached data.
