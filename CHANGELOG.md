# Changelog

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
