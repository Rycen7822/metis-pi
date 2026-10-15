# Owned questionnaire implementation

Keep the v2.13.8 provenance and MIT license in METIS.md/LICENSE. Maintain existing answer envelopes, normalization, previews, notes, RPC and cancellation behavior. Configuration belongs only to global Metis TOML; do not reintroduce rpiv JSON or an automatic active-tool restore. Deferred is availability, not permission to advertise without a usable gateway/UI. Only mutate the owned entrypoint, never a foreign same-name provider.

Use `npm run test:ask-user-question` for scoped SDK/UI contracts and `npm run check:core`, `check:entries`, `check:test` for affected types. Tests are colocated upstream-derived `.test.ts` files, excluded from production distribution. Public feature behavior/configuration lives in docs/features/ask-user-question.md and metis-pi-config.md.
