# Metis-maintained pi-web-access

Upstream: https://github.com/nicobailon/pi-web-access — **0.38.0**, commit `7e6e2386dc9a31d5e2a448172060dd1339c604f7`. Copyright (c) 2025 Nico Bailon; [MIT license](LICENSE) retained. Metis owns this directory; ignored `references/pi-web-access` is not an installation input.

## Local ownership and compatibility

- `extensions/web-access.ts` loads the generated extension bundle. Metis registers only deferred `web_access` with per-action discovery; enabled operations stay internal, and nested tracking/retrieval guidance uses the grouped name. Standalone extension/MCP retain their registration and activation behavior.
- Real action renderers own a two-column inset on **every visual row**, including wrapped query/URL rows and single/batch results. The group adds inset only to fallback/description output, not twice.
- Global `[webAccess]` TOML owns ordinary preferences. Adjacent `web-search.json` and existing env/command sources own credentials, auth headers, and authenticated proxies; initialization never rewrites those. Pi, provider adapters, and standalone MCP share the Metis configuration owner. Bundles leave shared TS imports external so packaged template paths remain correct (Node ≥22.19).
- Summary defaults/pickers support Luna/Terra under both `openai` and `openai-codex`. Search accepts either provider name for `openai-codex-responses` while retaining Codex API/backend guards; official `openai-responses` keeps its official route.
- Strict-null checking preserves validated-object/auth-union narrowing. The proxy-error fixture sets uppercase and lowercase proxy names so inherited settings cannot hide its invalid-URL case.

User operations, configuration fields, limits, privacy, and fallback contracts belong in [README.md](README.md); do not maintain a second provider/configuration inventory here.

## Build and update

Run at the Metis root:

```sh
npm run build:plugins
npm run test:plugins
```

The root dependency graph/lockfile owns both extension and MCP bundles; never install/update this directory separately. `scripts/build-web-access.mjs` derives externals from that owner, and the test runner preserves module cwd/isolation preload. The private local manifest records only MCP identity/version and ESM mode. Tests/evidence stay colocated but are excluded from the npm payload. Standalone MCP bundles TypeBox **1.3.27** with [its license](licenses/typebox.LICENSE); update the notice with that dependency.

For upstream updates, compare against the pinned commit, preserve local contracts and preferences/auth sources, update entrypoint provenance, run relevant upstream tests plus Metis package/loader checks, then rebuild. `cacheRoot` only selects an existing parent; it does not move/remove cached data. Captured contract evidence and upstream release history remain historical records, not current verification.
