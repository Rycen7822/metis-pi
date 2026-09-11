# Validation record — 0.8.4 (footer details, Working widget, runtime outcomes)

Method: unit suites on REAL host data shapes + `host-smoke` (real Pi
component assembly) + `pty-verify` (the real `pi` binary in a real tmux PTY,
driven by a local mock OpenAI-compatible provider — zero paid requests;
screen frames asserted with `tmux capture-pane`, not raw byte-stream
greping). The PTY run uses HOME isolation so the published 0.8.3 copy in the
user's `~/.pi/agent` cannot shadow the code under test.

| Stage | Frame evidence (real TUI) |
| --- | --- |
| Idle footer | `pcx-mock-model · high · pcx-mock    ctx 0/1.0M · 0%` + `…/workspace    Σ↑0 · R0 W0` — model/effort/provider/capacity all from real host fields (0.8.3 showed a bare directory here because it read nonexistent `label/percentUsed`) |
| Live Working | `✦ Working… · … · Ns · ↑…` above the editor mid-stream; elapsed + token preview grow; editor border carries no second Working; native loader row hidden only after widget install |
| Thinking | `thinking Ns` grows while the mock streams `reasoning_content`; after the run the summary shows `thought for Ns` (same interaction-scope ledger) |
| Tool run | mock tool call → real `bash` executed (`PCX_TOOL_MARK` in output) → summary still `Worked for …` (a mid-run tool error no longer brands the run Failed — covered separately by the outcome unit suite: error→retry→stop = Worked, error→settle = Failed, abort = Interrupted, length = Ended·output limit, no evidence = Ended) |
| Provider error | forced HTTP 500 → summary `Failed after …` (real terminal evidence) |
| Footer after runs | `ctx 1.3k/1.0M · 0.1%` + `Σ↑200 ↓80 · cache(last) 83.3% · R1.0k W0 · $0.00` — Pi normalizes usage (input = uncached prompt tokens, 1200−1000 cached = 200; cacheRead = 1000 → 1000/1200 = 83.3%) |

Not verified (environment limits): real window mouse clicks, IME input,
paid-provider-specific reasoning splits. Unknown values render `—`
(verified in unit tests for null/NaN/negative/missing usage).

`npm test` 193/193 · `check`/`check:core` clean · `test:host` PASS (needs
`COLORTERM=truecolor` on hosts whose palette resolves to 256-color for the
diff-surface assertions — an environment property, not a code regression;
it fails identically on the 0.8.3 tree) · `test:pty` PASS (5 stages).

---

# Validation record — 0.8.3 (write title fixes)

Two real-use screenshot findings, both reproduced in the real host
component before fixing:

| Finding | Root cause | Fix | Verified |
| --- | --- | --- | --- |
| Completed write showed a bare lowercase `write` with no bullet/path | `component()` reuse helper called `setText` on the 0.8.1 write-call composite (no such method) → TypeError → host catch → `createCallFallback()` | reuse only components implementing `setText` | final frame now `• Wrote <path>` + `└` result rows — identical shape to `• Ran` |
| Streaming write header showed `• Writing .` (path not yet streamed) | content-first provider: `path` arrives after `content`; old `path()` fallback was `"."` | explicit dim `(path pending…)` placeholder; header re-renders with the real path when the frame lands | frame sequence: `• Writing (path pending…)` → `• Writing …/raw_body_draft.md` → `• Wrote …/raw_body_draft.md` |

`npm test` 148/148 · `test:chrome` 7/7 · `check` clean · `test:host` PASS.

---

# Validation record — 0.8.2 (crash hotfix)

Real-use crash captured by the user's `pi-capture` wrapper: every session
that streamed write arguments died within ~3 minutes with
`TypeError: Cannot read properties of undefined (reading 'visibleWidth')`
at `write-preview.ts:129` via `CodexWriteCallComponent.render` — the host
process exited through `uncaughtException` while tearing down the
alt-screen, so the terminal showed nothing.

Root cause: the renderers' `lastComponent` reuse path builds a PARTIAL
input (it cannot know component-owned `layout`/`maxRows`);
`CodexWriteCallComponent.update()` replaced `#input` wholesale, dropping
`layout` for every frame after the first.

Fix + verification:

| Check | Result |
| --- | --- |
| `update()` merge semantics (partial input merged, component-owned fields kept) | applied |
| `renderWritePreview` defensive layout fallback (never kill the host) | applied |
| Regression test `write-stream-crash.test.mts` (real `ToolExecutionComponent.updateArgs` → `render` ×4) | pass; verified to reproduce the crash against the broken `update()` |
| `npm test` | 148/148 |
| `npm run test:chrome` | 7/7 |
| `npm run check` | clean |
| `npm run test:host` | PASS |

---

# Validation record — 0.8.1

## Scope

Version 0.8.1 is a fix round on the 0.8.0 standalone UI owner: structured
Writing header + streaming smoothness, document-edit diff surface, and real
thinking expansion. Display-only boundary unchanged (no tool/model/session
mutation; the UI-only CustomEntry summary exception stays as granted).
Executed in `/home/xu/project/tools/pi-codex-appearance`, Node v24.15.0,
Pi core/TUI 0.85.1.

Baseline: remote main `c3486a0815f0af6b4df2872ca5bb7fd5a555fab7` (0.8.0),
verified equal to local HEAD and to the live clone
`~/.pi/agent/git/github.com/Rycen7822/pi-codex-appearance` before any change.
No uncommitted user changes existed; nothing was reset or overwritten.

## Root causes confirmed against the baseline blob

1. **Writing title bypassed** — `src/renderers.ts` write branch early-returned
   `makeWritePreview(...)` whenever a non-empty `contentPrefix` existed; the
   preview component rendered stage + body but never the `• Writing <path>`
   title. Present unchanged since 0.7.0.
2. **Preview tail freeze** — `src/write-preview.ts` budgeted by LOGICAL lines
   and `slice(0, MAX)`d the wrapped result last: an early long logical line
   consumed the whole budget and every later frame dropped the newest content.
   Additionally the per-frame work was O(prefix) with no reuse.
3. **Phase from accumulated content** — `src/extension.ts` `message_update`
   derived the phase via `content.some(thinking)` on the WHOLE message: stale
   thinking blocks kept "Thinking" lit while write arguments streamed.
   `metrics.writeStreaming()` only fired at `tool_execution_start`.
4. **Expanded Markdown overwritten with a label** — the adapter's
   `isCollapsedLabel = typeof text === "string" && !markdown` is always true
   for the host's Markdown instances (they have `text`, no `markdown` field),
   so the 0.8.0 "collapsed enrichment" `setText("Thought for …")` hit EXPANDED
   thinking bodies. With the host's `hideThinkingBlock` default (`false`),
   thinking was ALREADY expanded — our injection actively broke it.
5. **Document edits routed to the native self-shell** — the builtin edit tool
   sets `renderShell: "self"`; the adapter backed off on ANY self-shell, so
   `.md` edits rendered the native pre-execution preview without the
   full-row add/remove backgrounds. The structured diff renderer and its
   `details.diff` parser already existed for write/edit results.
6. **semanticRuns continuity** — `if (!kind) continue` meant toolCall (and,
   before this round, empty text) blocks did not break a thinking run, unlike
   the host rebuild loop (break on first non-thinking block).

## Checks actually executed

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | 147/147 pass | +2 thinking-body persistence, +1 barrier run, +1 diff surface, +1 stale-thinking phase, updated self-shell routing test |
| `npm run test:chrome` | 7/7 pass | chrome modules incl. import rule, factory contract |
| `npm run check` (tsc) | clean | strict, whole project |
| `npm run test:host` | PASS | real Pi assembly + `/codex-ui` (now asserts `0.8.1 diagnostics:` AND `config: thinking=full/full`) |
| self-shell routing | pass | exact-builtin self-shell taken over; third-party/unknown sourceInfo self-shell still backs off (regression tested) |
| diff surface | pass | context rows plain; add rows `#213A2B` line bg; remove rows `#4A221D` + dim overlay; BLANK added row keeps full-row bg incl. right padding; every styled row closed by `\x1b[49m` |
| thinking body persistence | pass | body Markdown present after `thinking_end` + `message_end`, survives re-coordination; no `Thought for` label anywhere |
| run splitting | pass | `thinking / empty text / thinking` → 2 rails; `thinking / toolCall / thinking` → 2 rails (barrier run) |
| stale-thinking phase | pass | `thinkingEnd` idempotent + `writeStreaming` → phase `writing`, thinkingMs not extended; later text → `working` |
| config wiring | pass | `thinking.streaming/completed/rail`, `writePreview.enabled/rows` consumed by the production component (`rows`=body budget, `enabled:false`/`rows:0` keeps header, drops body); `/codex-ui` shows effective values |

## Streaming performance + visibility (same machine, same fixture)

Fixture: 1800-char logical lines interleaved with short lines (the freeze
scenario), 20 streaming frames per size, wrap/width via the real TUI ops.

| Prefix size | OLD 0.8.0 ms/frame | OLD newest-tail visible | NEW 0.8.1 ms/frame | NEW newest-tail visible |
| --- | --- | --- | --- | --- |
| 16 KiB | 0.22 | yes | 0.03 | yes |
| 128 KiB | 0.16 | **no (frozen)** | 0.10 | yes |
| 1 MiB | 0.90 | **no (frozen)** | 0.73 | yes |

p50 over 3 rounds at 128 KiB / 1 MiB: OLD 0.05 / 0.34 ms, NEW 0.06 / 0.35 ms
— no wall-clock regression; the fix is VISIBILITY (the 0.8.0 build silently
dropped the newest content from every frame once a long line was in budget).
No absolute wall-clock assertions in CI; per-frame cost stays far below any
frame cadence.

## Real-process verification

- `npm run test:host` runs against the REAL installed
  `@earendil-works/pi-coding-agent` (0.85.1 dist) and real pi-tui through
  `index.ts`'s default export — component-level behavior above is not faked.
- PTY-driven real `pi` TUI (user's own extension stack), HEAD `ae09669`:
  fresh start frame shows the `Pi 0.85.1 · codex-appearance 0.8.1` header and
  native footer; `/codex-ui` reports `0.8.1 diagnostics:`, chrome applied,
  transcript applied, `decorations: group-spacing=applied, separator=applied,
  thinking-rail=applied`, clock idle (timers=0), and
  `config: thinking=full/full rail=on writePreview=8 rows` — no crashes,
  no appearance warnings.
- `pi -p` print-mode smoke: extension loads without errors (chrome/`/codex-ui`
  are TUI-only by design; pre-existing third-party `pi-context-view` command
  error is unrelated to this package).

## Deviations & limits

- The `collapsed` value of `thinking.streaming/completed` remains ACCEPTED
  config for compatibility, but this release implements no automatic
  collapse-to-label (that mechanism was the 0.8.0 defect). If you set
  `collapsed`, the host's own toggle (`Ctrl+T` / click) still applies; we do
  not auto-collapse on your behalf. Defaults and the documented behavior are
  `full/full`.
- Zentui registry probe REMOVED (package uninstalled by the user). Unknown
  third-party rail owners still back off through the adapter's
  ownsMethods/sourceInfo checks — nothing blanket-overridden.
- The native edit self-shell takeover is gated on the EXACT builtin source
  (`source === "builtin"` AND `path === "<builtin:edit>"`). A third-party
  tool overriding edit with a self-shell keeps its renderer.
