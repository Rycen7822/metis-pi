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
- The Linux x64 worker is packaged with the plugin. Build with `npm run build:recall`; release checks verify the source fingerprint and payload.
  Recall uses the shared read-only [Semantic asset catalog reader](../neural-search/runtime/catalog.mts) to locate Bekko128;
  Semantic Search owns installation. There is no separate model download or copy. For development,
  `METIS_RECALL_RUNTIME_DIR` can select an independent worker and `METIS_BEKKO_DIR` can select already prepared weights.
- Literal search counts matching JSONL lines consistently in rg/grep/streaming Node; reject empty strings, retain literal whitespace. Search/reads are async and cancellable.
- Query keeps the current-leaf branch, including compacted raw messages and native textual summaries, but no remote checkpoint in the helper request. Whole-file search may match an unselected branch excluded from query.
- Query windows retain existing word matches and additionally score distinct adjacent Han pairs (isolated Han characters count as single terms).
- Budget the complete system/user prompt against 80% of the selected query model's context. Output is capped by the reserved 20% and model limit.
  For recognized OpenAI text models use the mapped tiktoken encoding and local chat framing; otherwise use Pi's estimate. Neither is server usage.
  To avoid quadratic BPE work on the host thread, pieces with a whitespace or non-whitespace run over 8,192 UTF-16 units use a UTF-8 byte upper bound.
  Window assembly counts only changed excerpts and omission markers at independent tokenizer boundaries.
  It skips truncation only when the mandatory suffix cannot fit, then rechecks the fully assembled request before dispatch.
  Successful query details report the encoding name or `pi-estimate` in `inputTokenCounter`.

Compare updates with the pinned source, preserve original sessions/search/query behavior and attribution, and verify registration, model selection and transport.
