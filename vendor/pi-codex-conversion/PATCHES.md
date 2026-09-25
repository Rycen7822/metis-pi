# Local patches: pi-codex-conversion 3.0.34

Edit `src/**`, run `npm run vendor:build`, then `npm run vendor:patch`. `patches/local.patch` is generated against the pristine source named in [UPSTREAM.md](UPSTREAM.md); apply with `git apply -p1` from the vendor directory. Never edit `dist/` directly. Build config and payload trimming are maintained separately in UPSTREAM.

## 1. Notebook parameters are a top-level object

`tools/code-mode/notebook-tool.ts`: replace the top-level union with an object containing all action variants and optional fields. Strict providers reject a union with no top-level `type`. Keep `additionalProperties: false` and runtime normalization; all previously valid inputs remain accepted.

## 2. Pi 0.86/0.87 transcript, tool placement and compaction/replay

`providers/transcript.ts` implements the required 0.86.1/0.87.0 semantic subset without importing 0.87-only host helpers. Provider boundaries still accept legacy Context, needed by direct registry callers and old sessions.

`providers/openai-responses/shared.ts` owns preparation once: normalize Context, resolve model system-message capability, place tools, convert wire items. Request bodies, compaction serializers and native replay consume this same preparation. The tool placement object is authoritative:

- Additive history keeps initial tools at the top and anchors additions at their message, using additional_tools or paired tool_search items.
- Removal or same-name redefinition declares the complete current tool table once and disables both new and legacy in-place declarations. Removed tools must not reappear; redeclarations use the latest definition.
- Legacy addedToolNames remains supported. Its cumulative additional_tools behavior differs from incremental tool_search and is preserved.
- Full transcripts and slices distinguish their head explicitly. A slice-leading system update is not a global prompt. Replay slices inherit the full-history placement decision; kept-window system entries follow the host's checkpoint folding.
- tool_search IDs derive from anchor content rather than slice position. Existing tool-search sessions can incur one cache-prefix change; full and sliced conversion then agree.
- Reconstructed compacted input and top-level tools are updated together. A canonical request retains its own verified baseline. Final tool call/result pairing stays at the dedicated history-normalization boundary.
- `adapter/replay/context-edits.ts` owns one `inspectCheckpointWindow` result: the checkpoint boundary together with the effective `context_edit` projection. Edits the checkpoint already absorbed stay reusable, a later edit that rewrites kept content is not replayed stale, and live-tail targets keep the host projection. Replay, repeated compaction, the portable summary and the Pi-fallback window consume that one judgment, and a pending window is re-resolved at the injection boundary. An unresolvable `firstKeptEntryId` is reported as such: ordinary replay fails explicitly, and native compaction cancels with that reason before any summary request, so neither the native attempt nor the optional portable summary falls back to an empty kept window or sends the previous opaque window. A genuinely stale window rebuilds from the edited context without carrying the old encrypted history forward. Sessions without edits keep the previous request prefix.
- A retain-none checkpoint (`appendCompaction(summary, null, ...)`: 0.87 stores the checkpoint's own id, 0.86 stored null; both hosts project either shape as an empty kept window) replays an empty kept window plus the live tail. Only those two markers are accepted: a missing field, an explicit `undefined`, an unknown id, an id after the checkpoint or a wrong-branch id keep failing the existing checks.

Related files: `providers/openai-codex/request-body.ts`, `adapter/compaction/{serializer,compaction,remote-v2-client}.ts`, `adapter/replay/{context-edits,native-replay-segments,payload-rewrite}.ts`. Built-provider cases in `test/vendor-codex-{transcript,compaction-replay,compaction-request}.test.mjs` plus the 0.87 `test/vendor-codex-context-edits.test.mjs` protect normal, replay and final rewritten requests.

## 3. Grammar and namespace tools

`providers/openai-codex-custom-provider.ts`, `providers/openai-responses/stream.ts`, `providers/openai-codex/transport-recovery.ts`, `providers/code-mode-proxy-provider.ts` and `context-management/namespace-tools.ts` resolve tools from the transcript. Grammar mapping and namespace routing retain their distinct responsibilities; blindly replacing every `context.tools` read is insufficient.

`context-management/tool-contract.ts` owns the nine history/notes operation schemas,
required fields and encryption/empty-text policy. Flat action tools, runtime field
validation and namespace declarations derive from it. Keep per-action required
fields distinct from optional flat-router fields, nonnullable `read_item.window_id`,
empty note writes, and Remote's omitted bounds/additionalProperties. Namespace
requests clone their schemas rather than mutating the shared contract.

## 4. Direct provider calls

`extension/runtime.ts`, `adapter/compaction/portable-summary.ts`, `voice/context.ts` and `voice/native-context.ts` normalize legacy Context at direct-call boundaries. Preserve prewarm/keepalive and summary semantics; do not add a second system/tool injection to an already normalized transcript.

`adapter/provider-request.ts` shares common live/prewarm preparation while leaving
native-window injection, replay and prompt capture at the final-request boundary.
Ordinary prewarm cannot consume pending compaction state. The compaction callback
retains its transport predicate; it is not the API predicate used for live context
tool rewriting. Offline contracts and failure boundaries are covered in
`test/vendor-context-contracts.test.mjs` and `test/vendor-provider-preparation.test.mjs`.

## 5. Pi 0.86 JSON types

Provider and model-related patches use the tightened JSON object contract and omit undefined diagnostic properties. Preserve runtime values and error classification.

## 6. Pi-owned Codex model catalog

`openai-codex-custom-provider.ts` initially registers only its request stream, leaving Pi's current `openai-codex` models intact. At session start, its native provider delegates model lookup and refresh to that Pi-backed provider and adds only the hidden Luna Reserve model. Do not restore a vendored snapshot of ordinary Codex models: it masks models added by newer Pi releases.

## 7. Notebook capture and payload validation

`tools/notebook-mode/{capture-bindings-source,checkpoint-runtime,checkpoint,project-state-runtime,project-state-format,project-state-metadata,profile-state-format}.ts` share lexical-binding capture, hashed project/profile payload reads and checkpoint/metadata layout validation.

Preserve partial writes, close/commit order, function metadata, byte limits, scope-specific error text and checkpoint-only invalid-name entries. Callers retain schemas, restores, locks and transactions. Layout checks intentionally do not hash content. Generated-code tests use Node V8 with a Deno file-API substitute, not a live kernel.

## 8. Configuration and settings ownership

`adapter/activation/config-normalize.ts` normalizes common boolean fields from their defaults, then applies dependent switches once. Enum readers, legacy `toolRendering`, optional fields, invalid-root defaults and input immutability retain their existing behavior. The public config facade remains unchanged.

`ui/settings/config-items-shared.ts` owns simple boolean controls used by display/tools/voice/OpenAI tabs: read the displayed config, update the latest draft without mutating it. Custom controls, action markers and coupled compaction updates remain explicit. `test/vendor-config.test.mjs` covers alias/dependency/optional-field semantics and all 15 converted controls.

## 9. metis-pi-owned update lifecycle

`extension/events.ts` no longer checks the upstream npm version at session startup.
`adapter/local-version-warning.ts` is deleted, including its registry request, version
comparison and checkout-path detection. metis-pi owns releases and updates; the vendored
manifest retains upstream provenance only. Do not restore this check during manual sync.
`test/package.test.mjs` guards both source and shipped output against its return.

## 10. Shared apply_patch diff display

`tools/apply-patch/render-state.ts` owns a single structured pre-execution file
preview, exposed read-only by `getApplyPatchRenderSnapshot`. Native text views
derive from that snapshot instead of caching three formatted strings or rereading
changed/deleted files. metis-pi's appearance adapter recognizes only this package's
exact extension entry and paints folded and expanded successful/pending patch previews using
the same Codex diff component as edit/write. The snapshot carries the tool's
`showDiffWhenCollapsed` policy; folded previews share a wrapped row budget across
files instead of falling back to the native text painter. Compact preferences, failure results,
third-party tools and execution remain unchanged. `scripts/host-smoke.mjs` checks
real multi-file patch execution and rendering, including CJK wrapping and deletion.

Snapshot and display-controller storage is keyed by physical module URL on
`globalThis`: Pi uses isolated Jiti contexts per extension when a normal install
omits host peers, so module-local state alone is not a cross-entry contract.
Existing clear/shutdown paths still own cleanup, and separate installs stay isolated.
`test/transcript/apply-patch-module-context.test.mjs` checks isolated contexts,
failure updates, compact policy and cleanup.

## 11. Shared command layout and syntax colors

`ui/tool-rendering/codex-rendering.ts` accepts an optional `highlightCommandLines`
theme callback for raw command rows (including expanded exploration commands).
metis-pi supplies its existing bash script highlighter through a call-local theme
only for the exact packaged `exec_command` source. No tracker, tool execution,
output, grouping or session behavior is replaced. An optional `renderCommandCall`
factory delegates ordinary command calls to metis-pi's existing builtin bash
component, passing the original untruncated command and tracker status. That
component owns width-dependent wrapping, physical-row budgets, highlighting and
copy metadata; the tool returns it directly rather than wrapping it in `Text`.
Exploration summaries still use the vendor renderer. Missing callbacks
retain the original accent/muted fallback, and there is no module-global painter
to diverge across Pi's isolated extension contexts. Root adapter/renderer tests
and the real host smoke cover ownership, color capability, multiline previews,
background-session status, failure output, terminal resizing and folded/expanded
single-line chains without the legacy 100-character cutoff.

## 12. Background shell mouse toggle

`ui/background-bash-widget.ts` installs its above-editor content as a component
factory wrapped in Pi's native `MouseRegion`, just like tool cards. Only a left
click toggles it; pointer motion, dragging, wheels and other buttons pass through.
Mouse and keyboard use the same toggle function and existing `state.folded`.
Session selection, output refresh, termination and empty-widget removal remain
unchanged; no global mouse hook or secondary expansion state is introduced.
`test/vendor-background-bash-widget.test.mjs` exercises both inputs, rendering at
narrow widths, headless contexts, cleanup and real host widget hit routing.

## Maintenance verification

Run project/vendor checks and real built-provider tests. Rebuild twice to check deterministic output; regenerate the patch twice to check idempotence. Apply it to an isolated pristine 3.0.34 source copy using the documented payload exclusions and compare file contents and modes. New-file diff headers must use `a/src/` and `b/src/` on both sides. Do not remove unified-diff context prefixes to silence patch-file whitespace diagnostics.

## Bounded resident output and request preparation

`tools/exec/output-buffer.ts` owns the existing UTF-16 retention window: ordinary
output stays in memory; larger buffers use a private, capacity-bounded disk ring.
Delivery reads only the requested tail and keeps the original unread character
count. Exit-observing calls retain their requested output before disposal; replay
remains separately capped. Cancellation, shutdown and waiter failure release the
appropriate resources without treating unread or cancelled work as completed.
Unavailable spool writes retain the previous in-memory budget; unrecoverable
reads fail explicitly. Cleanup attempts all sessions even if one removal fails.
The session manager alone owns result delivery, disposal and replay publication;
result formatters no longer delete sessions through callbacks.

`providers/openai-codex/session-continuity.ts` separates validation from owned
replay cloning. Request and reconstructed views use one graph snapshot, preserving
shared immutable input without copying it twice; responses remain independently
owned. `transport-recovery.ts` prepares the compressed SSE body only
after selecting SSE, including WebSocket fallback; successful WebSocket requests
do not allocate that unused copy. The actual SSE body is reused across retries.

Current results and unverified runtime boundaries live only in the root [VALIDATION.md](../../VALIDATION.md). This work retains the 3.0.34 baseline; review and replay every applicable patch when syncing.
