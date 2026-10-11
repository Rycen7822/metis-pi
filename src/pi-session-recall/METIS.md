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

Keep `session_search`, `session_query`, existing session files and
`~/.pi/agent/session-recall.json` unchanged when updating this module. Compare
against the pinned upstream commit, preserve the API-aware compatibility check,
update the provenance comment, and verify tool registration and query transport.
