# Upstream provenance

- Project: https://github.com/jjuraszek/pi-condense
- Version: 2.11.0
- Commit: `1bdbba695305419e97be179b412b1fb267298d7f`
- License: MIT; the original copyright notices are retained in `LICENSE`.
- Scope: upstream `index.ts` and production `src/` files. Upstream tests, development tooling and documentation are not included in the runtime payload.
- The npm manifest retains upstream peer ownership, with `typebox` matching the host Pi API instead of the older `@sinclair/typebox` import.

`extensions/condense.ts` is the only metis-pi entry. It loads committed `dist/index.js`; neither installation nor startup depends on `references/`.

Build with `node scripts/vendor-condense.mjs build`; type-check with `check`; compare a fresh temporary build with shipped files using `fresh`. The root vendor build/check/fresh commands include these checks. Build products are committed with source changes.

To update, obtain the intended upstream version, compare production files with this snapshot, retain the changes in `PATCHES.md`, rebuild, and run the condense host tests and `npm run verify`. Validate package discovery in an isolated Pi profile before changing the user's installed package list. Do not copy upstream defaults into existing user settings.
