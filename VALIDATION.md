# Validation record — 0.7.0

## Scope

Version 0.7.0 fixes the 0.6.0 separator persistence defect, adds the thinking
rail and the write args live preview, and fixes duplicate group image totals.
All checks below were executed in the development checkout
(`/home/xu/project/tools/pi-codex-appearance`, Node v24.15.0, Pi core/TUI
0.85.1) unless stated otherwise.

## Checks actually executed

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | **113 passed; 0 failed** | Unit + golden + parser + transcript suite (0.7.0 suite drives the real `installTranscriptDecorations` coordination layer over a host-faithful `updateContent` mirror) |
| `npx tsc -p tsconfig.json` (`npm run check`) | **0 errors** | Real TypeScript compiler over `src/` + `index.ts` |
| `npm run test:host` | **PASS** | Real Pi `ToolExecutionComponent` two-slot assembly: one title per toolCallId, write five states (incl. live preview → verified diff switch), mouse expand/fold, third-party back-off, teardown restore |
| `npm run preview` | **Passed** | Production two-slot renderers; 8-image group with ONE `8 images` total; two separator boundaries; three write live-arg frames (receiving ×2, content ready) |
| `npm pack --dry-run --ignore-scripts` | **Passed** | 0.7.0 manifest, 30 files |
| `pi --no-session -p` (twice, after clone sync) | **OK** | Real Pi CLI loads the extension through the production path with no extension errors |

## Key defect reproductions and fixes

- **Separator vanished after rebuild (0.6.0 defect)**: the old `takeTextPlan`
  consumed global pending state once, and the host's `updateContent()` clears
  the container, so the line disappeared on the second rebuild. Replaced with
  stable message/run identities (`generation:seq` keys, open→sealed aliasing,
  object-anchored `WeakMap` identity plus plan adoption for unanchored
  components) and a coordination layer that re-coordinates the rebuilt subtree
  after EVERY `updateContent`. Test: the SAME logical message goes through 100
  cumulative updates — exactly one separator on every rebuild; message_end,
  invalidate and re-render cycles keep it.
- **Fingerprint check removed (3.3)**: `updateContent`'s source prefix equality
  is replaced by a structural contract (own writable/configurable descriptor on
  the verified v0.85.1 prototype). Benign wrappers (zentui) no longer block
  installation; diagnostics are per-feature (separator / thinking-rail /
  group-spacing).
- **thinking vs text (3.5)**: state machine and rail distinguish `text`,
  `thinking`, `toolCall` block types; the separator sits immediately before the
  TEXT run when thinking precedes it; plain English (including the word
  "Thinking" or "Writing…") never gets a rail.
- **Duplicate image totals (D)**: with 8 serial reads, only the CURRENT last
  member renders the aggregate total, resolved from the shared plan and
  refreshed on append via dirty-view invalidation; stale members no longer keep
  old counts; per-member payloads and expandability unchanged.

## Host verification (real v0.85.1 dist, line-level)

- `AssistantMessageComponent.updateContent()` clears and rebuilds
  `contentContainer`; thinking nodes are `MouseRegion(child, onMouse)` with a
  `child` field (verified in `mouse-region.js`) — the rail swaps the inner
  child in place, so clicks keep working and mouse x is compensated by the
  rail width.
- `ToolExecutionComponent.updateArgs() → updateDisplay() → renderCall(args,
  theme, getRenderContext())` is the args-streaming path; `getRenderContext()`
  exposes `argsComplete` / `executionStarted` / `isPartial` / `expanded`
  (NOT `hasResult` — a final result is signaled by `isPartial === false`,
  set by `updateResult`). The write call slot uses these; no invented
  protocol, no second toolCallId.
- pi-zentui compatibility: its thinking feature needs its own config
  (user has `thinkingSteps.enabled: true`, mode `rail`); when its prototype
  patch registry (`Symbol.for("pi-zentui.prototype-patch-registry")`) is
  present on the assistant prototype, our rail reports the external owner and
  stays passive. Never disables or rewrites zentui config.

## Not verified here (needs a real terminal / real provider stream)

- Actual mouse hit-testing on railed thinking and live-preview rows in the
  user's terminal (the coordinate compensation is unit-tested, not
  screen-tested).
- Real provider partial-args JSON shapes: the preview renders whatever
  cumulative `args.content` the host delivers (tested with scripted frames);
  provider-specific delta edge cases (revisions, out-of-order chunks) are
  handled by "latest cumulative snapshot wins" but were not observed live.
- Image protocol rendering, soft-wrap copy behaviour, DIM contrast on light
  terminal themes, and the visual result in the user's specific terminal.
- The `docs/preview.html` snapshot is a formatter/component render, NOT a
  screenshot of a running Pi session.

## Historical

- 0.6.0: serial grouping + separator + dimming (separator persistence defect
  documented above, fixed in 0.7.0).
- 0.4.0/0.5.0: earlier delivery records described un-downloaded dev
  dependencies and unverified host checks; the host smoke test and full
  dependency set run locally since then, and 0.5.0 removed the bare `diff`
  import that broke git-clone installs.
