# Metis-owned ask_user_question

Source: [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono), package `@juicesharp/rpiv-ask-user-question` **2.13.8**, tag `v2.13.8`, commit `afc21bc25f7d07cae9fb3103dc309240a16b9f49` (also npm gitHead). MIT license is preserved in `LICENSE`. Guidance validation and test utilities derive from that release's `rpiv-config` and `test-utils`, under the same repository license.

Metis owns execution, parameter normalization/schema, UI/state machine, preview/notes/custom answers, RPC fallback, result envelopes, events and locales. No mandatory rpiv runtime dependency remains. Optional rpiv-i18n loading and the original namespace/events are retained; absent SDK means English fallback. Relative source imports use `.ts` for the Metis source distribution.

Local changes:
- `extensions/ask-user-question.ts` loads this implementation; session-start registration checks entrypoint provenance before touching same-name tools.
- Tool availability is `deferred` with UI/enabled configuration, `hidden` otherwise. `before_agent_start` never eagerly activates it; explicit tool_search/user activation is retained. Native discovery gateway is enabled only at session start, and the prompt hint matches the usable route. Foreign providers remain untouched with a warning.
- Configuration is global `metis-pi.toml [askUserQuestion]`, not project or rpiv JSON. Collapse key grammar/default/off and full guidance replacement semantics are preserved. No personal files are migrated automatically.
- Execution abort is threaded into RPC select/input and TUI done/cleanup, without confusing abort with custom-answer dismissal. Presentation claims and blocked events remain per invocation. Prewarming is once per registration owner with shutdown cleanup.
- Closing an invocation aborts its external editor and waits for child cleanup before releasing the UI slot. Lazy imports cannot launch an editor after cancellation, and late results cannot update a closed session.
- The router emits input intent and buffer snapshots; the reducer owns answers, tab advancement and saved notes. Collapsed ignored input cannot mutate a draft. Protocol labels and neutral row types do not depend on renderers.
- View composition wires the fixed component tree directly. Single-select rendering has one props-driven owner; custom-answer scrolling follows the caret. Preview measurement and rendering share width/row limits, preserving closed borders and clipping hints on narrow terminals.
- Registration uses one normalized TOML snapshot. Repeated identical failures stay quiet; changed failures and failures after recovery are reported again. Unused upstream workflow helpers and internal compatibility surfaces are retired.

Tests are retained beside the source (excluded from production package/typecheck). The retired upstream standalone shipping assertion is covered by Metis `test/package.test.mjs`; JSON config/automatic activation tests now cover TOML/deferred ownership. Runtime/UI/presentation/copy/parser regressions remain. `npm run test:ask-user-question` runs real SDK boundary tests plus the scoped upstream-derived Vitest suite; `npm test` includes both. Vitest is development-only. Test helper copies are in `test/helpers/ask-user-question`.

Do not run the external npm extension alongside this owned entry. Installation/uninstallation is separate from source integration. No Windows, physical terminal/clipboard or real model call is asserted by headless contract checks.
