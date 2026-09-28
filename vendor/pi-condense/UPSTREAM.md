# Upstream provenance

- Project: https://github.com/jjuraszek/pi-condense
- Version: 2.11.0
- Commit: `1bdbba695305419e97be179b412b1fb267298d7f`
- License: MIT; the original copyright notices are retained in `LICENSE`.
- Scope: upstream `index.ts` and production `src/` files. Upstream tests, development tooling and documentation are not included in the runtime payload.
- The npm manifest retains upstream peer ownership, with `typebox` matching the host Pi API instead of the older `@sinclair/typebox` import.

Automatic compression scheduling, deterministic packing and durable output import are local changes listed in `PATCHES.md`; this is not an unchanged upstream compression policy.

`extensions/condense.ts` is the only metis-pi entry. It loads `index.ts` directly through Pi's existing TS loader. `dist/index.js` remains a default re-export for the old path; no compiled implementation tree is shipped. Neither installation nor startup depends on `references/`, TypeScript development dependencies or lifecycle scripts.

Packed releases include `index.ts`, `src/**/*.ts`, the old entry facade, package manifest, license and provenance documents. Rust/build inputs are not added to the package. `npm run vendor:check` type-checks source without emitting files; `vendor:build` and `vendor:fresh` are compatibility aliases for that check. Local imports use `.ts`, and constructor parameter properties have equivalent explicit fields so Node's strip-only test runtime can load them.

To update, compare the intended upstream version with this snapshot, retain `PATCHES.md` behavior, run condense host tests and `npm run verify`, and validate isolated local/Git/npm installation. Do not copy upstream defaults into existing user settings.
