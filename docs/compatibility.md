# Compatibility boundaries

## Target and sources

The classic Pi 0.85.1 component contract was inspected in:

- `earendil-works/pi`, tag `v0.85.1`, `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` (blob `5355a3637aad9df5871ac907b680378ffd67b677`).
- The same tag's `packages/coding-agent/src/core/source-info.ts` and `packages/tui/src/components/text.ts`.
- Codex execution-row reference: `openai/codex`, `codex-rs/tui/src/exec_cell/snapshots/codex_tui__exec_cell__render__tests__truncated_live_output_preview_and_transcript.snap` (blob `eb47a610cc5d54ede53f8e5faee8dd5fb27578b4`).
- Codex edit/diff reference: `openai/codex` commit `94697375cb9d2aa8ae74d61957c6b396819bec94`, `codex-rs/tui/src/diff_render.rs`. The supplied Codex CLI screenshot was also used as the target visual reference. The project implements its own TypeScript formatter; it does not embed Codex Rust code.

## What changes

The `getCallRenderer` and `getResultRenderer` selectors return appearance-specific functions for builtin-owned rows. The `getRenderShell` selector chooses `self` after the first compact render. A wrapper around the tool row's original `render` refreshes its display once when that mode changes. The original render method remains responsible for width, image order, and `selfRenderHeight`; the original mouse method is untouched.

The constructor always sees the stock shell. Its original child tree is retained. Consequently a later owner change or uninstall can restore default rendering by repopulating the original content box. No transcript tree splicing is used.

## What stays unchanged

No tool registration/activation, executor replacement, schema changes, event content mutation, model messages, session entries, system prompts, global TUI rendering, theme forcing, footer/editor/spinner ownership or keyboard remapping. The runtime registers only `session_start` and `session_shutdown` lifecycle handlers. Source strings are sanitized only when producing a display copy.

Third-party tool definitions and renderers are left intact, including extensions which override a builtin name. Existing self-shell tools are not reformatted. Unknown ownership fails closed. Theme tokens can still affect a third-party tool's colours if the user explicitly selects the bundled theme.

## Known limits

This is an internal-UI compatibility adapter, not a stable public renderer registration API. Guard checks reduce risks but cannot prove compatibility with every future version or arbitrary monkey patch. A later plugin which completely replaces the same tool-row renderer can control the final output; this package will not overwrite it.

The local layout tests use an explicit harness, not real FFF/Zentui/LSP/RTK instances. A separate real-Pi test is supplied but could not run in the delivery environment. Terminal-specific image rendering, mouse interaction and clipboard behaviour require an actual target terminal run.

The scope is the tool transcript plus an optional palette selection. Existing editor, footer, thinking and Working-line layout are retained. There is no cross-tool grouping or imitation of Codex approval semantics. Full expansion displays every text block, with display-only terminal-control sanitization; it does not alter the stored result.

For dark-terminal edit rows, version 0.3.0 deliberately matches Codex's current changed-line tints (`#213A2B` add, `#4A221D` delete), line-number-first gutter order, full-row background fill and hanging indentation. Exact appearance can still vary with terminal font, width and color profile.
