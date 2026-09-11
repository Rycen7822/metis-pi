# Changelog

## 0.8.1

Fix round on the 0.8.0 UI owner: structured Writing header, physical-row
streaming preview, event-driven phase feed, real thinking expansion, and the
document-edit diff surface. Display-only boundary unchanged.

- Writing header restored: the write CALL slot always owns a structured
  `• Writing <path>` header with a stage line (`Receiving content · preview,
  not yet committed` → ready → writing file). The live preview is a body
  UNDER the header — the 0.8.0 early-return that replaced the title with a
  bare preview once the first content chunk arrived is gone. Final results
  collapse to `Added/Edited/Wrote` with the result slot owning the body.
- Physical-row tail budget: `renderWritePreview` now wraps FIRST (full
  gutter + line-number deduction) and keeps the newest TERMINAL rows, so an
  early 1800-char logical line can no longer freeze the tail — the newest
  received character is always visible (0.8.0 measured: tail invisible at
  ≥128 KiB prefixes; now visible at 16 KiB–1 MiB, same per-frame cost).
- Event-driven phases: the Working line now follows the real
  `assistantMessageEvent` stream (`thinking_start/delta/end`, `text_*`,
  `toolcall_start/delta/end` + tool name at `contentIndex`). A stale
  thinking block in the accumulated message no longer keeps "Thinking" lit
  while write arguments stream — the status shows `Writing`.
- Real thinking expansion: the automatic collapse-to-label behavior was
  REMOVED. The default policy is `thinking: full/full` (config
  `codex-appearance.json`); thinking bodies stay open after
  `thinking_end`/text/tool start; Ctrl+T / clicks keep working through the
  host. The 0.8.0 adapter bug that overwrote EXPANDED thinking Markdown with
  a `Thought for …` label (broken `isCollapsedLabel` shape test) is fixed —
  the display layer never rewrites a thinking body into a label.
- semanticRuns host parity: an EMPTY text block now breaks a thinking run
  (barrier run), like the host rebuild loop; toolCall blocks between
  thinking blocks also split runs.
- Document edits use the Codex diff surface: the EXACT builtin edit
  tool's `renderShell: "self"` is now taken over (same structured
  `• Editing/Edited <path>` + full-row add/remove backgrounds as code
  edits). Third-party self-shells and unknown sourceInfo still back off;
  the ownership checks were not relaxed for them.
- Config wiring: `thinking.streaming/completed/rail` and
  `writePreview.enabled/rows` are actually applied (`rows` = body budget,
  `enabled: false` keeps the header and drops the live body). `/codex-ui`
  surfaces the effective values. Zentui registry probe removed (uninstalled).

## 0.8.0

The standalone Codex-style Pi UI. This release makes pi-codex-appearance the
single owner of the main-interface chrome (composer frame, footer, header,
working state) after the user uninstalled pi-zentui — no co-ownership designs,
no zentui fallbacks. Same display-only boundary as before: tool data, args,
results, model context and session message content are never touched.

- Interaction clock: ONE monotonic clock per user-visible interaction, opened
  on the first `agent_start` of a chain and closed on `agent_settled`.
  Auto-retries, compaction gaps and queued continuations do NOT reset it
  (`agent_end` only closes the open thinking interval). Phases (Thinking /
  Writing / Working / Waiting for input) derive ONLY from real content kinds
  (thinking/text/toolCall blocks, real write-args streaming), never from text
  heuristics. A 1s ticker drives `Working · 38s` in the native working-status
  slot; the timer is unref'd and torn down on settle/shutdown.
- Worked-for summary: after `agent_settled`, a dim Codex-grammar summary line
  (`Worked for 1m 05s · thought for 19s · ↓1.2k ↑8k`, `Interrupted after …`,
  `Failed after …`) is shown and — via the single granted UI exception —
  persisted as a namespaced CustomEntry (`pi-codex-appearance:interaction-
  summary:v1`) with its own registered renderer, so it survives session
  restore. Deduped per interaction; `summary.persist: false` or `--no-session`
  degrade to volatile display only.
- Chrome slots through public host APIs only, each identity-tracked for a
  clean hand-back: editor factory (Codex-look composer: accent border,
  paddingX 2, working status stays embedded; stock input behavior, IME,
  autocomplete and keybindings untouched — the Codex '›' per-line prefix is a
  recorded deviation: the Editor pipeline has no safe per-line hook), footer
  (model · effort · cwd, context % right, external `setStatus` items kept),
  minimal real-identity header (Pi + codex-appearance + model/dir; never
  impersonates OpenAI).
- Config: `<agentDir>/codex-appearance.json` (safe defaults; kill switch
  `enabled: false`; feature toggles `thinking`, `writePreview`, `working`,
  `summary`; malformed values fall back per-field with a warning).
- `/codex-ui` diagnostics: per-feature status (chrome / transcript /
  decorations / interaction clock) with the real cause per feature; no
  single-reason masking of partial failures.
- Thinking automation: once a thinking run closes (first text/toolCall after
  thinking, or message_end), the collapsed label is enriched with the measured
  duration (`Thought for 19s (ctrl+t to expand)`). The host's own visibility
  override map stays the sole owner of collapse state — user clicks always
  beat the automatic default.
- 0.7.x defect fixes folded in: tool-call-only `message_update` growth no
  longer closes the exploration group or marks assistant text; every non-empty
  text block is its own semantic run (consecutive thinking merges only when
  truly adjacent); thinking rail unwrap restores the host's original node
  verbatim on dispose/rebuild.

## 0.7.0

Fixes and additions on top of 0.6.0, same display-only boundary: tool data,
args, results, model context and session files are never touched.

- Separator persistence fix (the 0.6.0 defect): the separator plan was consumed
  once (takeTextPlan) and the inserted line was dropped by the host's next
  `updateContent()` rebuild. Plans are now STABLE identities (`generation:seq`
  message keys + open→sealed aliasing) resolved by display-order events; the
  assistant coordination layer re-coordinates the rebuilt subtree after EVERY
  `updateContent`, re-attaching exactly one separator per text run. 100
  streaming updates → exactly one line throughout. The fragile host source
  fingerprint check was replaced by a structural contract (descriptor shape +
  verified host v0.85.1), so benign patches (e.g. zentui) no longer block
  installation and diagnostics are per-feature.
- Thinking rail: a narrow static `▏` rail (accent teal, `|` for no-color) on
  every semantically-typed `thinking` block. Implemented as a width-aware
  wrapper around the host's thinking component INSIDE the existing MouseRegion,
  so click-to-collapse, streaming and geometry keep working; rail offset is
  compensated for mouse coordinates. English text or "Writing…" strings are
  never classified as thinking. If pi-zentui's thinking display takes over
  (detected via its prototype patch registry), our rail stays passive.
- Write live preview: while the model is still streaming a write tool call's
  arguments, the call slot renders the received `args.content` prefix in
  real time (host `updateArgs` → `renderCall`), with a dim stage label
  (Receiving content / Content ready / Executing / Written / Failed-aborted ·
  "preview, not yet committed"). Bounded rolling tail (8 logical lines,
  ≤12 screen rows), CJK/ANSI-aware wrapping, incomplete-UTF-16-safe, expandable
  to the full received prefix. Collapses to the verified-diff result on
  completion. No disk writes, no extra tool executions; aborted runs keep the
  received draft with an honest state label.
- Duplicate image totals fix: with 0.6.0's grouping, stale per-member
  components kept their own accumulated count (`1 image` repeated per member).
  The aggregate notice now resolves through the shared plan (only the CURRENT
  last member shows the total, refreshed on every append via dirty-view
  invalidation); per-member payloads and expandability are unchanged.
- Host field completion: `argsComplete`/`executionStarted` are read from the
  real `ToolExecutionComponent.getRenderContext()` (verified v0.85.1).

## 0.6.0

Transcript presentation release: serial exploration grouping, the
tool→assistant-text separator, and full-body output dimming. Display copy only
— tool data, args, results, model context and session files are never touched.

- Serial exploration grouping: consecutive builtin read/grep/find/ls calls
  (serial or parallel, across any number of tool-call-only assistant messages)
  share one `• Explored/Exploring` header. The first member owns the header and
  `  └ ` gutter; later members draw a four-space row with no leading spacer.
  Membership survives completion (the group stays open until a semantic
  boundary), and the aggregated image notice (counted from real image blocks,
  never filenames) prints once per group. Ownership checks (`sourceInfo`) keep
  third-party renderers out; failures split the group and stay visible.
- Tool→assistant-text separator: a light width-aware `─` rule (dim, ASCII
  fallback for no-color) before the first non-empty assistant text that follows
  tool activity. One line per boundary; streaming deltas, final replacements,
  history replay and re-renders never duplicate it. Thinking is never moved or
  hidden; conservative split on visible thinking keeps the structure honest.
- Output body dimming: `renderShellResult` now dims the ENTIRE body (prefix +
  text) through a small SGR state machine (`styleToolOutputLine`) instead of a
  scoped prefix dim. Source colors (truecolor/256/16) survive; inner resets
  (`0m`, empty `m`, `22m`) re-acquire our DIM; SGR parameters like
  `38;2;0;22;39` are never misread as resets; no-color emits no SGR; DIM never
  leaks past the row.
- New modules: `transcript-state.ts` (pure display-order projection), 
  `transcript-adapter.ts` (scoped, ownership-checked prototype decorations with
  full restore), `output-style.ts` (SGR dim composition). `explore.ts` now
  exposes separate header/member builders. New event listeners are read-only
  (`message_start/update/end`): no context mutation, no new storage.

## 0.5.0

Runtime correctness release: the two-slot combination contract, physical-row
budgets, honest write states, a single diff renderer, and pipeline-wide color
handling. Display copy only — tool data, args, results and session files are
never modified.

- Two-slot combination: the call region renders the title/command once and the
  result region renders only output. Fixes the duplicated "Ran" header (the
  old `formatCall` + `renderShellRow` double path) and unifies the old and
  rich renderers behind one implementation per region.
- Physical-row budgets (`VisualRow`): wrap before truncation, every wrapped
  row costs one, ellipsis rows included in the budget. Fixes NaN/`+0 lines`
  from mismatched `lines`/`rowCounts`, restores streaming tails (partial
  output), and makes expanded mode wrap at terminal width instead of
  returning over-wide lines or truncating the command.
- Write five states: `Added (+N -0)` / `Edited (+A -D)` / unchanged /
  unavailable / failed — every state shows expandable content, the failed
  state marks attempt content as "not written", and no diff is fabricated
  when no reliable pre-image exists.
- Tracker honesty: exact builtin ownership via `sourceInfo`
  (`source=builtin`, `path=builtin:write`), expected-content verification
  after the tool finishes, bounded reads (stat/size/type first), the mature
  line-diff implementation with input budgets instead of unbounded 2D LCS,
  and a context window computed from change indices without backward drift.
- Single diff renderer: one-line-number parser (digits after the first
  number stay content, indentation preserved), padding before the background
  reset so surfaces fill the row, syntax colors kept on delete rows under a
  dim overlay, and a structured style pipeline instead of regex-assembled
  control codes.
- Pipeline `ColorContext` resolved once (NO_COLOR / FORCE_COLOR 0-3 /
  COLORTERM / terminal capabilities): truecolor, 256, 16 and none modes share
  one resolver; exploration rows no longer hardcode truecolor while shell
  rows read the environment.
- Bash highlighting fixes: command position re-established after control
  operators (`a; echo b` colors the second command), heredoc bodies carried
  across lines (`<<EOF`, `<<-EOF`, `<<'EOF'`), plain spans get the Mocha
  base foreground, and oversized lines are truncated ANSI-aware (no split
  escape sequences, no dropped source text).
- Real-entry tests: host smoke drives Pi's `ToolExecutionComponent` (one
  structural title per toolCallId, mouse expand/fold through the component,
  third-party `write` back-off with zero file reads, teardown restore) plus
  a layout golden matrix (12 commands × 9 widths, CJK/emoji/ANSI outputs,
  resize round-trips). Preview now runs through the production two-slot
  renderers instead of bypassing them.

## 0.4.0

- Catppuccin Mocha syntax palette constants (`palette.ts`) with truecolor →
  256 → 16 degradation and a safe SGR filter.
- Lexical-state-aware bash tokenizer (`bash-lexer.ts`) for command words,
  flags, strings, numbers, comments, heredoc starts and backslash
  continuations.
- Width-aware exec-cell shell layout (`shell.ts`): `  │ ` command
  continuation, `  └ ` output block, middle truncation with expand hints.
- Codex-layout diff renderer (`diff.ts`) with line numbers, signs, full-row
  surfaces and hanging indent; structured file-change rows (`file-change.ts`).
- Ephemeral write tracker (`write-tracker.ts`) with pre-image snapshots for
  builtin writes only.

## 0.3.0

- Rebuild edit diffs to match the supplied Codex CLI screenshot: line number first, then gutter sign and content.
- Use Codex dark truecolor diff surfaces exactly: add `#213A2B`, delete `#4A221D`.
- Fill changed-row backgrounds to the full tool-row width, including every physical wrapped continuation row.
- Wrap diff content independently and apply a hanging indent so wrapped text stays aligned under the content column.
- Keep context rows background-free and render Pi's already-compact edit context window in full instead of truncating it a second time.
- Dim deleted content while retaining red/green gutter signs and same-redraw `(+N -N)` counters.
- Keep the rich diff renderer presentation-only; no tool/result/context mutation is introduced.
- Expand formatter tests for Pi diff parsing, exact RGB SGR output, width fill, hanging indentation and rich-component delegation.

## 0.2.0

- Enable `index.ts` by default; remove the separate optional entry.
- Switch builtin-owned tool rows to compact self-shell layout instead of changing only card colours.
- Add Codex-like `Running/Ran`, `Exploring/Explored`, command gutters, folded successful exploration, streamed tail previews and completed head/tail previews.
- Add same-redraw edit statistics, coloured diff previews and truthful write-content previews.
- Add native PowerShell display support and optional host command syntax highlighting.
- Preserve the stock constructor child tree and restore it on unload; repaint pre-existing rows when activating.
- Extend tests for default activation, shell geometry, owner changes, history, image order, same-redraw state and failures.
- Include generated ANSI/HTML/PNG formatter previews and the one-step local GitHub publication script.
- Keep third-party renderers, context middleware, tool execution, working timers, editor/footer and thinking untouched.

## 0.1.0

Initial derivative with theme-only default and opt-in builtin formatting. Superseded by 0.2.0's default compact transcript.
