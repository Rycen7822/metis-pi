# Local patches: pi-codex-conversion 3.0.34

Edit `src/**`, run `npm run vendor:build`, then `npm run vendor:patch`. `patches/local.patch` is generated against the pristine source named in [UPSTREAM.md](UPSTREAM.md); apply with `git apply -p1` from the vendor directory. Never edit `dist/` directly. Build config and payload trimming are maintained separately in UPSTREAM.

## 1. Notebook parameters are a top-level object

`tools/code-mode/notebook-tool.ts`: replace the top-level union with an object containing all action variants and optional fields. Strict providers reject a union with no top-level `type`. Keep `additionalProperties: false` and runtime normalization; all previously valid inputs remain accepted.

## 2. Pi 0.86 transcript, tool placement and compaction/replay

`providers/transcript.ts` implements the required 0.86.1 semantic subset without importing 0.86-only host helpers. Provider boundaries still accept legacy Context, needed by direct registry callers and old sessions.

`providers/openai-responses/shared.ts` owns preparation once: normalize Context, resolve model system-message capability, place tools, convert wire items. Request bodies, compaction serializers and native replay consume this same preparation. The tool placement object is authoritative:

- Additive history keeps initial tools at the top and anchors additions at their message, using additional_tools or paired tool_search items.
- Removal or same-name redefinition declares the complete current tool table once and disables both new and legacy in-place declarations. Removed tools must not reappear; redeclarations use the latest definition.
- Legacy addedToolNames remains supported. Its cumulative additional_tools behavior differs from incremental tool_search and is preserved.
- Full transcripts and slices distinguish their head explicitly. A slice-leading system update is not a global prompt. Replay slices inherit the full-history placement decision; kept-window system entries follow the host's checkpoint folding.
- tool_search IDs derive from anchor content rather than slice position. Existing tool-search sessions can incur one cache-prefix change; full and sliced conversion then agree.
- Reconstructed compacted input and top-level tools are updated together. A canonical request retains its own verified baseline. Final tool call/result pairing stays at the dedicated history-normalization boundary.

Related files: `providers/openai-codex/request-body.ts`, `adapter/compaction/{serializer,compaction,remote-v2-client}.ts`, `adapter/replay/{native-replay-segments,payload-rewrite}.ts`. Thirty built-provider cases in `test/vendor-codex-{transcript,compaction-replay,compaction-request}.test.mjs` protect normal, replay and final rewritten requests.

## 3. Grammar and namespace tools

`providers/openai-codex-custom-provider.ts`, `providers/openai-responses/stream.ts`, `providers/openai-codex/transport-recovery.ts`, `providers/code-mode-proxy-provider.ts` and `context-management/namespace-tools.ts` resolve tools from the transcript. Grammar mapping and namespace routing retain their distinct responsibilities; blindly replacing every `context.tools` read is insufficient.

## 4. Direct provider calls

`extension/runtime.ts`, `adapter/compaction/portable-summary.ts`, `voice/context.ts` and `voice/native-context.ts` normalize legacy Context at direct-call boundaries. Preserve prewarm/keepalive and summary semantics; do not add a second system/tool injection to an already normalized transcript.

## 5. Pi 0.86 JSON types

Provider and model-related patches use the tightened JSON object contract and omit undefined diagnostic properties. Preserve runtime values and error classification.

## 6. Supplemental model capabilities

`model-catalog.ts` declares mid-conversation system support where appropriate. Capability differences remain intentional: folding models such as Spark must not be forced onto the anchored-update path.

## 7. Notebook capture and payload validation

`tools/notebook-mode/{capture-bindings-source,checkpoint-runtime,checkpoint,project-state-runtime,project-state-format,project-state-metadata,profile-state-format}.ts` share lexical-binding capture, hashed project/profile payload reads and checkpoint/metadata layout validation.

Preserve partial writes, close/commit order, function metadata, byte limits, scope-specific error text and checkpoint-only invalid-name entries. Callers retain schemas, restores, locks and transactions. Layout checks intentionally do not hash content. Generated-code tests use Node V8 with a Deno file-API substitute, not a live kernel.

## 8. Configuration and settings ownership

`adapter/activation/config-normalize.ts` normalizes common boolean fields from their defaults, then applies dependent switches once. Enum readers, legacy `toolRendering`, optional fields, invalid-root defaults and input immutability retain their existing behavior. The public config facade remains unchanged.

`ui/settings/config-items-shared.ts` owns simple boolean controls used by display/tools/voice/OpenAI tabs: read the displayed config, update the latest draft without mutating it. Custom controls, action markers and coupled compaction updates remain explicit. `test/vendor-config.test.mjs` covers alias/dependency/optional-field semantics and all 15 converted controls.

## Maintenance verification

Run project/vendor checks and real built-provider tests. Rebuild twice to check deterministic output; regenerate the patch twice to check idempotence. Apply it to an isolated pristine 3.0.34 source copy using the documented payload exclusions and compare file contents and modes. New-file diff headers must use `a/src/` and `b/src/` on both sides. Do not remove unified-diff context prefixes to silence patch-file whitespace diagnostics.

Current results and unverified runtime boundaries live only in the root [VALIDATION.md](../../VALIDATION.md). Upstream 3.0.35 exists, but this work retains the 3.0.34 baseline; review and replay every applicable patch when syncing.
