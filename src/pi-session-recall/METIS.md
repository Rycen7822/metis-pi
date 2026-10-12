# Metis-maintained pi-session-recall

Upstream: https://github.com/ogulcancelik/pi-extensions

Source path: `packages/pi-session-recall`, version **1.0.7**, commit
`92964e4c7023ae88788181bb2eeea4497a97de9d`.
Copyright (c) 2026 Can Celik; the upstream MIT license is retained in `LICENSE`.

Metis owns the source in this directory. `references/pi-session-recall` is only
temporary reference material. `extensions/session-recall.ts` loads this source
directly; no standalone npm package is needed.

Queries use the current host ModelRegistry/ModelRuntime's provider-neutral
streamSimple path. The host owns provider selection, request-time authentication,
dynamic endpoint/env/header resolution, virtual-model routing and transport.
Recall does not resolve a second auth snapshot or impose a Codex transport.
Schema construction uses Metis's existing `typebox` peer, rather than relying on
Pi's legacy `@sinclair/typebox` virtual alias.

The query model is managed by `[sessionRecall].queryModel` in Metis's global
`metis-pi.toml`: `"default"` follows the current session, while `"provider/model-id"`
selects a registered model. Each query rereads the setting. The shared Metis
init command imports the upstream `session-recall.json` when TOML is absent
and leaves the original intact. An existing TOML is authoritative.

The Metis entrypoint registers only deferred `session_recall`, with `search`,
`query` and per-action `describe` operations. Preserve the original search/query
implementations and existing session files when updating this module; the
registration callback keeps these operations internal to the grouped tool.
Compare against the pinned upstream commit, preserve the
native runtime boundary and TOML integration, update the provenance comment,
and verify tool registration, model selection and query transport.

Literal search counts matching JSONL lines consistently across rg, grep and the
streaming Node fallback. Empty strings are rejected; other literal whitespace
is preserved. Search and session reads are asynchronous and cancellable.
Queries retain the original current-leaf historical branch, including raw
messages already covered by compaction and native textual summaries. They do
not reuse remote checkpoints in a separate helper request. Search still covers
the whole file; an unselected branch can match search without belonging to the
query branch. Final
normalized input, including instructions, question and omission/truncation
markers, stays within 80% of the selected model's context under Pi's native
token estimate; output is explicitly capped to the reserved 20% and model cap.
This is Pi's estimate, not an exact count for every provider tokenizer.
