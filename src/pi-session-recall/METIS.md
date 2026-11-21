# Metis-maintained pi-session-recall

Source: [ogulcancelik/pi-extensions](https://github.com/ogulcancelik/pi-extensions), `packages/pi-session-recall` **1.0.7**, commit `92964e4c7023ae88788181bb2eeea4497a97de9d`. Copyright (c) 2026 Can Celik; [MIT license](LICENSE) retained.

Metis loads this `.ts` source through `extensions/session-recall.ts`; references are not install inputs and no standalone package is required. [User interface/configuration](../../docs/features/managed-plugins.md) belongs to the grouped deferred `session_recall` search/query/describe tool, not separate registrations.

## Implementation contracts

- Queries use the host ModelRegistry/ModelRuntime `streamSimple`: Pi owns provider, request-time auth, endpoint/env/headers, virtual routing and transport. No second auth snapshot or forced Codex transport; schema uses the root `typebox` peer, not the old `@sinclair/typebox` alias.
- Each query rereads global `[sessionRecall].queryModel`: default follows session, a registered provider/model selects another; absent TOML uses defaults. Preserve native runtime/TOML boundaries when updating.
- Hybrid search uses a separate native worker and private disposable FTS5/FP16 index. It never uses the provider, sgrep, or raw tool bodies. Every returned excerpt is checked against JSONL.
- Opt-in enhanced search adds a lazy, cascading Potion vector table to the same bounded SQLite cache; existing v4 cores do not migrate.
  Frozen exact shortlist views share one SQLite snapshot. Only their bounded center text reaches the bundled offline scorer.
  After scoring, the worker verifies the original root and every chosen byte span again; success never uses an older source binding.
  Python is a request-owned child, not part of the Pi process; local asset/setup failures are disclosed with ordinary scoped hybrid results.
- Maintainer staging: `npm run build:recall` (Linux x64, glibc ≥ 2.39) stages the worker at the npm package path. An independent stage can be selected with `METIS_RECALL_RUNTIME_DIR`; for tests use an approved model directory as `METIS_BEKKO_DIR`. The worker and model are separate assets.
- Literal search counts matching JSONL lines consistently in rg/grep/streaming Node; reject empty strings, retain literal whitespace. Search/reads are async and cancellable.
- Query keeps the current-leaf branch, including compacted raw messages and native textual summaries, but no remote checkpoint in the helper request. Whole-file search may match an unselected branch excluded from query.
- Final normalized input (instructions/question/omission markers included) stays within Pi's estimated 80% context; output is capped by reserved 20% and model limit. This is not a provider-exact token count.

Compare updates with the pinned source, preserve original sessions/search/query behavior and attribution, and verify registration, model selection and transport.
