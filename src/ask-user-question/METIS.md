# Metis-owned ask_user_question

Source: [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono), `@juicesharp/rpiv-ask-user-question` **2.13.8**, tag `v2.13.8`, commit/npm gitHead `afc21bc25f7d07cae9fb3103dc309240a16b9f49`. [MIT license](LICENSE) retained; guidance/test helpers derive from the same release's `rpiv-config`/`test-utils`.

Metis owns schema/normalization, execution, UI/reducer, previews/notes/custom answers, RPC, envelopes/events/locales. No mandatory rpiv runtime remains; optional rpiv-i18n retains its namespace/events and English fallback. Source distribution uses `.ts` imports and the root toolchain.

## Integration boundaries

- `extensions/ask-user-question.ts` checks provenance before touching a same-name tool. UI+enabled means deferred, otherwise hidden; before_agent_start never eagerly activates it. Session-start gateway/guidance must match the usable discovery route; explicit activation persists, foreign providers are warned and untouched.
- Only global TOML `[askUserQuestion]`: no project/rpiv JSON or automatic migration. Preserve collapse-key grammar/default/off and full guidance replacement. One normalized registration snapshot; identical failures stay quiet, changed/recovered failures notify again.
- Abort reaches RPC/TUI cleanup without treating custom-answer dismissal as abort. Claims/blocked events remain per invocation; prewarm once per owner, release on shutdown. Abort external editors and await cleanup before freeing the UI slot; lazy imports/late results cannot revive closed work.
- Router emits intent/buffer snapshots; reducer owns answers, tab advancement and notes. Collapsed ignored input cannot edit a draft; protocol labels/neutral rows stay renderer-independent.
- Fixed view composition and props-driven single-select rendering; custom answer follows caret. Preview layout/render share width/row limits, narrow borders/clipping hints remain intact.

## Verification and delivery

Public usage/configuration belongs in [the feature guide](../../docs/features/ask-user-question.md). Do not enable the standalone npm provider alongside Metis; source integration does not install/uninstall it.

Colocated upstream-derived tests are excluded from production/core types; `check:test` uses `test/helpers/ask-user-question`. `test:ask-user-question` runs real SDK boundaries and scoped Vitest (`npm test` includes both; Vitest is dev-only). Metis package checks replace the retired standalone shipping assertion; TOML/deferred tests replace JSON/automatic-activation tests. Preserve runtime/UI/presentation/copy/parser protection. Headless checks do not establish Windows, physical terminal/clipboard or real-model behavior.
