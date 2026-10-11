# Metis-maintained pi-session-recall

Upstream: https://github.com/ogulcancelik/pi-extensions

Source path: `packages/pi-session-recall`, version **1.0.7**, commit
`92964e4c7023ae88788181bb2eeea4497a97de9d`.
Copyright (c) 2026 Can Celik; the upstream MIT license is retained in `LICENSE`.

Metis owns the source in this directory. `references/pi-session-recall` is only
temporary reference material. `extensions/session-recall.ts` loads this source
directly; no standalone npm package is needed.

The dedicated WebSocket path requires `openai-codex-responses` and accepts both
`openai` and `openai-codex` provider names. Official `openai-responses` uses the
normal Pi completion path. Transient Codex session cleanup is preserved.
Schema construction uses Metis's existing `typebox` peer, rather than relying on
Pi's legacy `@sinclair/typebox` virtual alias.

The query model is managed by `[sessionRecall].queryModel` in Metis's global
`metis-pi.toml`: `"default"` follows the current session, while `"provider/model-id"`
selects a registered model. Each query rereads the setting. The shared Metis
init command imports the upstream `session-recall.json` when TOML is absent
and leaves the original intact. An existing TOML is authoritative.

Keep `session_search`, `session_query` and existing session files intact when
updating this module. Compare against the pinned upstream commit, preserve the
API-aware compatibility check and TOML integration, update the provenance
comment, and verify tool registration, model selection and query transport.
