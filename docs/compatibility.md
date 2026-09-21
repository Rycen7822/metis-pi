# Compatibility boundaries

## Target and sources

Current runtime checks target Pi 0.87.0; see [VALIDATION](../VALIDATION.md). The classic two-slot component contract was initially traced in:

- `earendil-works/pi`, tag `v0.85.1`, `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` (blob `5355a3637aad9df5871ac907b680378ffd67b677`).
- The same tag's `packages/coding-agent/src/core/source-info.ts` and `packages/tui/src/components/text.ts`.
- Codex execution-row reference: `openai/codex`, `codex-rs/tui/src/exec_cell/snapshots/codex_tui__exec_cell__render__tests__truncated_live_output_preview_and_transcript.snap` (blob `eb47a610cc5d54ede53f8e5faee8dd5fb27578b4`).
- Codex edit/diff reference: `openai/codex` commit `94697375cb9d2aa8ae74d61957c6b396819bec94`, `codex-rs/tui/src/diff_render.rs`. The supplied Codex CLI screenshot was also used as the target visual reference. The project implements its own TypeScript formatter; it does not embed Codex Rust code.

Pi 0.86.1 was re-checked in `earendil-works/pi`, tag `v0.86.1` (`13cbf77df2396303013a41646bcfa77b4271ae56`) for the two changes that touch this package:

- `packages/ai/src/utils/transcript.ts` and `utils/text.ts` moved the provider-facing prompt and tool declarations out of `Context.systemPrompt` / `Context.tools` into transcript `system` messages, and `models.ts` normalizes before provider dispatch. The vendored Codex transport was migrated to that protocol; `vendor/pi-codex-conversion/src/providers/transcript.ts` is the local copy of the replay semantics it uses.
- `packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts` wraps the entry in a `MouseRegion` and renders `Box → MouseRegion → Container → Text/Markdown`. The skill-label patch follows that bounded structure and leaves the host's own click handler in place; `packages/tui/src/components/mouse-region.ts` shows a `click` only reaches it after a matching `press` was claimed, so the local fold override and the upstream handler cannot toggle twice.

Pi 0.87.0 was checked in `earendil-works/pi`, tag `v0.87.0` (`16787ad5`), for the two contracts the vendored Codex conversion consumes:

- `context_edit` entries are append-only projections of an earlier entry. Requests rebuild provider context from the SessionManager, so vendored replay and repeated compaction apply the effective edit before serializing any slice. Validity is relative to the checkpoint: an edit recorded before it was already absorbed by its window and stays reusable, while a later edit that rewrites kept content has no rewrite path there. Replay, repeated compaction, the portable summary and the Pi-fallback window share that judgment, and a pending window is re-resolved before injection. An unresolvable `firstKeptEntryId` is invalid rather than an empty window: replay reports it, and native compaction cancels before any summary request, so neither the native attempt nor the optional portable summary sends the previous opaque window. When the window really is stale, ordinary replay fails explicitly and a new compaction rebuilds from the edited context without carrying the old encrypted history forward. Pi < 0.87 sessions have no such entries and keep the previous request prefix.
- `SessionManager.appendCompaction(summary, null, tokensBefore, details)` is a legal retain-none checkpoint: 0.87 stores the checkpoint's own id as `firstKeptEntryId`, 0.86 stored `null`, and both hosts project either shape as an empty kept window. Replay treats exactly those two markers as an empty kept window; a missing field, an explicit `undefined`, an unknown id and an id after the checkpoint still fail the existing checks.

## What changes

The `getCallRenderer` and `getResultRenderer` selectors return appearance-specific functions for builtin-owned rows. The `getRenderShell` selector chooses `self` after the first compact render. A wrapper around the tool row's original `render` refreshes its display once when that mode changes. The original render method remains responsible for width, image order, and `selfRenderHeight`; the original mouse method is untouched.

The constructor always sees the stock shell. Its original child tree is retained. Consequently a later owner change or uninstall can restore default rendering by repopulating the original content box. No transcript tree splicing is used.

## What stays unchanged

No tool registration/activation, executor replacement, schema changes, event content mutation, model messages, session entries, system prompts, global TUI rendering, theme forcing, footer/editor/spinner ownership or keyboard remapping. The runtime registers `session_start`/`session_shutdown` plus read-only lifecycle observers: `tool_execution_start/end` (write tracking, exploration grouping) and `message_start/update/end` (display-order boundaries). Message handlers only read the content shape (text/thinking/toolCall presence); they never mutate events, results or messages. Source strings are sanitized only when producing a display copy.

Third-party tool definitions and renderers are left intact, including extensions which override a builtin name. Existing self-shell tools are not reformatted. Unknown ownership fails closed. Theme tokens can still affect a third-party tool's colours if the user explicitly selects the bundled theme.

## Known limits

This is an internal-UI compatibility adapter, not a stable public renderer registration API. Guard checks reduce risks but cannot prove compatibility with every future version or arbitrary monkey patch. A later plugin which completely replaces the same tool-row renderer can control the final output; this package will not overwrite it.

The local layout tests use an explicit harness, not real FFF/Zentui/LSP/RTK instances. A separate real-Pi test is supplied but could not run in the delivery environment. Terminal-specific image rendering, mouse interaction and clipboard behaviour require an actual target terminal run.

The scope is the tool transcript plus an optional palette selection. Existing editor, footer, thinking and Working-line layout are retained. There is no imitation of Codex approval semantics. Since 0.6.0, consecutive builtin exploration calls may share one group header and a separator line may appear before assistant text; both are display-only projections computed from lifecycle events (no cross-tool merging of results, no third-party renderer takeover, no data changes). Full expansion displays every text block, with display-only terminal-control sanitization; it does not alter the stored result.

For dark-terminal edit rows, version 0.3.0 deliberately matches Codex's current changed-line tints (`#213A2B` add, `#4A221D` delete), line-number-first gutter order, full-row background fill and hanging indentation. Exact appearance can still vary with terminal font, width and color profile.
