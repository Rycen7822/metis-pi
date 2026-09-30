# Local patches: pi-codex-conversion 3.0.34

Edit retained `src/execution/**` and `src/code-mode/**`; run `npm run check:execution`. Public composition is `extensions/execution.ts`. Pi 0.99.1 owns providers/auth/catalog/native codemode and ordinary compaction. Special context/provider/prewarm/Reserve code and tokenizer payload have retired. Historical change notes below describe provenance, not current product features.

## 1. Pi 0.86/0.87 transcript, tool placement and compaction/replay

`providers/transcript.ts` reuses public Pi 0.87+ transcript helpers. Thin wrappers preserve continuing-slice heads, unbranded internal transcripts and old addedToolNames records. Provider boundaries still accept legacy Context, needed by direct registry callers and old sessions.

`providers/openai-responses/shared.ts` owns preparation once: normalize Context, resolve model system-message capability, place tools, convert wire items. Request bodies, compaction serializers and native replay consume this same preparation. The tool placement object is authoritative:

- Additive history keeps initial tools at the top and anchors additions at their message, using additional_tools or paired tool_search items.
- Removal or same-name redefinition declares the complete current tool table once and disables both new and legacy in-place declarations. Removed tools must not reappear; redeclarations use the latest definition.
- Legacy addedToolNames remains supported. Its cumulative additional_tools behavior differs from incremental tool_search and is preserved.
- Full transcripts and slices distinguish their head explicitly. A slice-leading system update is not a global prompt. Replay slices inherit the full-history placement decision; kept-window system entries follow the host's checkpoint folding.
- tool_search IDs derive from anchor content rather than slice position. Existing tool-search sessions can incur one cache-prefix change; full and sliced conversion then agree.
- Reconstructed compacted input and top-level tools are updated together. A canonical request retains its own verified baseline. Final tool call/result pairing stays at the dedicated history-normalization boundary.
- `context/replay/context-edits.ts` owns one `inspectCheckpointWindow` result: the checkpoint boundary together with the effective `context_edit` projection. Edits the checkpoint already absorbed stay reusable, a later edit that rewrites kept content is not replayed stale, and live-tail targets keep the host projection. Replay, repeated compaction, the portable summary and the Pi-fallback window consume that one judgment, and a pending window is re-resolved at the injection boundary. An unresolvable `firstKeptEntryId` is reported as such: ordinary replay fails explicitly, and native compaction cancels with that reason before any summary request, so neither the native attempt nor the optional portable summary falls back to an empty kept window or sends the previous opaque window. A genuinely stale window rebuilds from the edited context without carrying the old encrypted history forward. Sessions without edits keep the previous request prefix.
- A retain-none checkpoint (`appendCompaction(summary, null, ...)`: 0.87 stores the checkpoint's own id, 0.86 stored null; both hosts project either shape as an empty kept window) replays an empty kept window plus the live tail. Only those two markers are accepted: a missing field, an explicit `undefined`, an unknown id, an id after the checkpoint or a wrong-branch id keep failing the existing checks.

Related files: `providers/openai-codex/request-body.ts`, `context/compaction/{serializer,compaction,remote-v2-client}.ts`, `context/replay/{context-edits,native-replay-segments,payload-rewrite}.ts`. Built-provider cases in `test/vendor-codex-{transcript,compaction-replay,compaction-request}.test.mjs` plus the 0.87 `test/vendor-codex-context-edits.test.mjs` protect normal, replay and final rewritten requests.

## 2. Grammar and namespace tools

`providers/host-api.ts` delegates sampling, Responses tool conversion, partial JSON parsing and streamed tool/usage processing to the running host's public APIs. Pi aliases the root package to compat, so one bridge resolves the package's declared exports using SDK `getPackageDir` and Node `findPackageJSON`; it does not guess private paths or install another pi-ai. The minimum host is Pi 0.87.0. Tool search uses Pi's `toolSearchResult` option. Native JSON repair replaces the local parser and direct `partial-json` dependency.

`providers/openai-responses/stream.ts` retains indexed text/refusal/reasoning assembly, raw item callbacks, image/search items and incomplete-call cleanup. Raw callbacks run before completion notifications and receive missing custom-tool input from the pending stream. Function calls retain accumulated-argument precedence; completion-only calls expose final arguments from their start notification. Pi handles streamed arguments, grammar JSON deltas, usage and normal terminal mapping. The adapter preserves pending/EOF and error semantics so Codex transport recovery still owns retry classification. It uses no private parser state; the public boundary bridges the two OpenAI SDK versions' event and service-tier types.

`providers/openai-codex-custom-provider.ts`, `providers/openai-responses/stream.ts`, `providers/openai-codex/transport-recovery.ts`, `providers/code-mode-proxy-provider.ts` and `context/namespace-tools.ts` resolve tools from the transcript. Grammar mapping and namespace routing retain their distinct responsibilities; blindly replacing every `context.tools` read is insufficient.

`context/tool-contract.ts` owns the nine history/notes operation schemas,
required fields and encryption/empty-text policy. Flat action tools, runtime field
validation and namespace declarations derive from it. Keep per-action required
fields distinct from optional flat-router fields, nonnullable `read_item.window_id`,
empty note writes, and Remote's omitted bounds/additionalProperties. Namespace
requests clone their schemas rather than mutating the shared contract.

## 3. Direct provider calls

`extension/runtime.ts` and `context/compaction/portable-summary.ts` normalize legacy Context at direct-call boundaries. Preserve prewarm/keepalive and summary semantics; do not add a second system/tool injection to an already normalized transcript.

`adapter/provider-request.ts` shares common live/prewarm preparation while leaving
native-window injection, replay and prompt capture at the final-request boundary.
Ordinary prewarm cannot consume pending compaction state. The compaction callback
retains its transport predicate; it is not the API predicate used for live context
tool rewriting. Offline contracts and failure boundaries are covered in
`test/vendor-context-contracts.test.mjs` and `test/vendor-provider-preparation.test.mjs`.

## 4. Pi 0.86 JSON types

Provider and model-related patches use the tightened JSON object contract and omit undefined diagnostic properties. Preserve runtime values and error classification.

## 5. Pi-owned Codex model catalog and authentication

`openai-codex-custom-provider.ts` initially registers only its request stream, leaving Pi's current `openai-codex` models intact. At session start, its native provider delegates model lookup and refresh to that Pi-backed provider and adds only the hidden Luna Reserve model. Do not restore a vendored snapshot of ordinary Codex models: it masks models added by newer Pi releases.

Authentication also delegates to that provider: Pi owns browser/device-code login and credential refresh. The local OAuth implementation and extra connector scopes are retired. Skills discovery remains Pi-owned; the unused `getCodexSkillPaths` export is retired, while Code Mode's prompt bridge still exposes skills when only exec/wait are active.

## Selective upstream fixes through 3.0.39

`6accb42`: the existing capability gate recognizes GPT-6 Astra/Sol/Luna for Responses Lite and reasoning updates, including configured proxies; settings describe GPT-6 consistently. The Pi-owned catalog remains authoritative: only Sol/Luna's unsupported `off` thinking map is corrected in copied model objects, without changing host prices, context limits or other metadata (`550b6b5`).

`e74d6cf`: Fast Mode still requests priority service tier; SSE, WebSocket and prewarm use the configured harness identity without automatically injecting a routing hint. Explicit additional headers remain intact; retry and continuation owners are unchanged.

`550b6b5`: `context/saved-notes.ts` derives reusable notes from Pi's current branch projection, replacing the window manager's process-local write ledger. Failed/incomplete writes, later input/tool work and edited-away receipts cannot grant reuse. Local/Tree/Remote keep the existing persistence, compaction thresholds and kickoff path. `context/history-insertion.ts` preserves a leading system message at index zero when inserting reconstructed messages.

## 6. Configuration and settings ownership

`config/config-normalize.ts` normalizes common boolean fields from their defaults, then applies dependent switches once. Enum readers, optional fields, invalid-root defaults and input immutability retain their existing behavior. Old flat and beta configuration migration and the `toolRendering` alias were removed; the public config facade remains unchanged.

`ui/settings/config-items-shared.ts` owns simple boolean controls used by display/tools/OpenAI tabs: read the displayed config, update the latest draft without mutating it. Custom controls, action markers and coupled compaction updates remain explicit. `test/core/vendor-config.test.mjs` covers alias/dependency/optional-field semantics and the current controls.

## 7. metis-pi-owned update lifecycle

`extension/events.ts` no longer checks the upstream npm version at session startup.
`adapter/local-version-warning.ts` is deleted, including its registry request, version
comparison and checkout-path detection. metis-pi owns releases and updates; the root
manifest supplies the product identity; this directory retains upstream provenance. Do not restore this check during manual sync.

## 8. Shared apply_patch diff display

`execution/apply-patch/render-state.ts` owns a single structured pre-execution file
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

## 9. Shared command layout and syntax colors

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

## 10. Background shell mouse toggle

`ui/background-bash-widget.ts` installs its above-editor content as a component
factory wrapped in Pi's native `MouseRegion`, just like tool cards. Only a left
click toggles it; pointer motion, dragging, wheels and other buttons pass through.
Mouse and keyboard use the same toggle function and existing `state.folded`.
Session selection, output refresh, termination and empty-widget removal remain
unchanged; no global mouse hook or secondary expansion state is introduced.
`test/vendor-background-bash-widget.test.mjs` exercises both inputs, rendering at
narrow widths, headless contexts, cleanup and real host widget hit routing.

## Maintenance verification

Run project/vendor no-emit checks and real host/provider tests. Verify local, Git-update and npm-package loading without a compiler or lifecycle scripts; verify the new entry/filter path, shared TS module identity and runtime resource paths. Old conversion entry and public facade paths have been removed. Full `npm run verify` and strict PTY checks own behavioral evidence.

## Bounded resident output and request preparation

`execution/exec/output-buffer.ts` owns the existing UTF-16 retention window: ordinary
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

Current results and unverified runtime boundaries live only in the root [VALIDATION.md](../../../VALIDATION.md). This work retains the 3.0.34 baseline; review and replay every applicable patch when syncing.


## Condense output preservation and shared projection

`execution/exec/output-archive.ts` captures decoded command output before terminal normalization and display-ring eviction into session-owned append-only blobs. Results carry the durable path, snapshot byte count and completeness. Untruncated small outputs remain inline; actual delivery or retention loss forces pending originals to disk even below the launch threshold, and completed replay retains any late-created archive. Pending originals survive process exit until delivery/disposal. Archive failure is explicit and does not fail the command. Normal disposal closes these files without deleting them. This preserves the stream received by the bridge, not data already discarded inside an invoked command such as RTK.

`extension/runtime.ts` emits the synchronous `metis:condense-project` hook when reconstructing history for compaction prewarm/keepalive. Condense applies its live projection; readiness travels with the projection result rather than a shared runtime flag, and pending final-reply flushes suppress speculative prewarm. No additional model or warmup request is introduced.

## Action Fusion

`execution/action-fusion.ts` validates optional `then_run`, coordinates canonical mutation paths and retains separate mutation/command status. `action-fusion-command.ts` reuses native bash operations or the existing exec manager. Compound-only interruption drains and preserves captured output; ordinary exec cancellation remains unchanged. `apply-patch/tool.ts` adds the parameter while preserving argument aliases and partial-patch semantics; `extension/tools.ts` supplies its existing executor.

`adapter/code-mode.ts` exposes function-form `apply_patch_then_run` alongside the original freeform `apply_patch`. Delegate capture persists complete fusion receipts in private session JSONL journals before UI trace limits apply. Outer results carry incremental, fixed byte ranges independently of display output truncation. No Codex host/kernel sources are modified, no RTK routing or new top-level execution lifecycle is added.

## Action Fusion availability

`extensions/action-fusion.ts` owns fusion availability through the session event bus. Without that entry, ordinary apply_patch omits then_run and rejects stale fusion arguments before mutation; Code Mode omits apply_patch_then_run. Registration synchronizes at session_start so extension load order does not change availability; reload removes the old entry listener. Ordinary patching, command tools, and historical evidence remain available.

## Dynamic global instructions

`extension/events.ts` resolves the main-run policy through `metis:dynamic-agents` after Reserve chooses the final model, before rendering the prompt. `extension/runtime.ts` shares the source-aware history projection with live/idle requests and gates every prewarm on a resolved run snapshot. No dynamic extension listener preserves upstream behavior. The feature owner is `extensions/dynamic-agents.ts`; provider matching/configuration and request-only projection live in `src/dynamic-agents.ts`. Offline lifecycle and final-payload coverage: `test/contract/dynamic-agents.test.mjs`.

## Shared history insertion and directory lease

`context/history-insertion.ts` performs stable insertion for reasoning bookkeeping and tree checkpoints; their message identities and eligibility rules remain with each caller. `execution/code-mode/directory-lock.ts` owns the cross-process lease for Code Mode installation. Code Mode keeps its download and checksum flow, but releases only the acquired owner instead of recursively removing the lock directory.

## Code Mode host client ownership

`execution/code-mode/host-client.ts` owns the framed host connection, the session protocol (`session/open`, `session/execute`, `session/wait`, `session/terminate`, `session/shutdown` with its shutdown deadline), request/pending bookkeeping and the delegate/cell reply mapping; `host-connection.ts`, `host-process.ts` and `host-protocol.ts` keep framing, process and wire-schema responsibilities. The former single-purpose forwarding modules (`host-session.ts`, `host-delegation.ts`, `host-cell-operations.ts`) are gone, so do not restore a second layer that only re-exports those calls. This ownership consolidation preserves protocol fields, resource paths and the `exec`/`wait` tool names. `test/resource/vendor-code-mode-host.test.mjs` drives a real client against a stand-in host process over the shipped frame protocol; it proves the adapter protocol, not a real V8 host cell.

Startup has a shared 30-second hello/session-open deadline with per-caller cancellation. Cell execution context is captured before startup; wait only changes the observer and update routing. Explicit steering input can yield an observation on capable hosts without cancelling its cell or nested tools. Optional capability negotiation preserves older hosts; see `native/code-mode-host/UPSTREAM_SYNC.md` for the source versus published-asset boundary and actual-host CI coverage.

The unused Rust process-owning remote client and its exports are removed from the maintained workspace. The TS client still owns host startup and framed requests; the Rust host retains its in-process session, delegation and protocol implementation.

## Code Mode Linux x64 host asset

`execution/code-mode/host-assets.ts` selects the metis-pi GNU host release on Linux x64 when the runtime reports glibc 2.34 or newer. The cache uses that release tag so later replacements cannot reuse an earlier executable. The pinned upstream asset remains the fallback for older glibc, musl and other platforms. The release build and provenance are documented in `native/code-mode-host/UPSTREAM_SYNC.md`; the archive checksum is checked before installation. The installer uses the same Undici implementation for both its fetch and proxy dispatcher so `HTTPS_PROXY` works during first install.

The self-maintained Rust source selectively backports undefined input handling, cancellable timers, shorter tool-result handle scopes and Arc-backed cell storage. Its V8 150.4.0 inputs require sandbox support and sort optimization guards; the release builder authenticates a pinned manifest before accepting the matching archive/binding. Backport commits, storage semantics and staged immutable publication are recorded in `native/code-mode-host/UPSTREAM_SYNC.md`.
