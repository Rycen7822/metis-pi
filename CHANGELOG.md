# Changelog

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
