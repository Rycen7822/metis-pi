# Upstream provenance

- Project: https://github.com/jjuraszek/pi-condense
- Version: 2.11.0
- Commit: `1bdbba695305419e97be179b412b1fb267298d7f`
- License: MIT; the original copyright notices are retained in `LICENSE`.
- Scope: upstream `index.ts` and production `src/` files. Upstream tests, development tooling and documentation are not included in the runtime payload.
- The npm manifest retains upstream peer ownership, with `typebox` matching the host Pi API instead of the older `@sinclair/typebox` import.

Automatic compression scheduling, deterministic packing and durable output import are local changes listed in `PATCHES.md`; this is not an unchanged upstream compression policy.

`extensions/condense.ts` is the only metis-pi entry. It loads committed `dist/index.js`; neither installation nor startup depends on `references/`.

Packed releases include `dist/**/*.js`, the package manifest, license and provenance documents. Source and build configuration remain in Git; generated declarations are ignored and recreated by development checks. Committed runtime JavaScript still supports local/Git installation without a build step.

Build with `node scripts/vendor-condense.mjs build`; type-check with `check`; compare a fresh temporary build with local files using `fresh`. Direct `fresh` requires locally generated declarations; use `npm run vendor:fresh` from a clean checkout to generate only declarations before comparing JavaScript with an independent build. Runtime JavaScript is committed with source changes; declarations remain local build output.

To update, obtain the intended upstream version, compare production files with this snapshot, retain the changes in `PATCHES.md`, rebuild, and run the condense host tests and `npm run verify`. Validate package discovery in an isolated Pi profile before changing the user's installed package list. Do not copy upstream defaults into existing user settings.
