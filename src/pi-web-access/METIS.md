# Metis-maintained pi-web-access

Upstream: https://github.com/nicobailon/pi-web-access

Source version: **0.38.0**, commit `7e6e2386dc9a31d5e2a448172060dd1339c604f7`.
Copyright (c) 2025 Nico Bailon; the upstream MIT license is retained in `LICENSE`.

Metis owns the source in this directory. `references/pi-web-access` is temporary
reference material and is neither tracked nor used for installation.

Local compatibility changes:

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
rebuilding the bundles. Retain existing web-search settings, authentication, and
cache paths.
