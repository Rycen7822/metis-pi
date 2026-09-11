# Validation record — 0.8.0

## Scope

Version 0.8.0 makes pi-codex-appearance the standalone owner of the Pi main
interface chrome (composer frame, footer, header, working state, end-of-work
summary) after the user uninstalled pi-zentui. It folds in the remaining
0.7.x defect fixes. All checks below were executed in the development
checkout (`/home/xu/project/tools/pi-codex-appearance`, Node v24.15.0, Pi
core/TUI 0.85.1) unless stated otherwise.

Codex visual reference: openai/codex@1b83e5cdf99889e72fbf3f92d9848fdf31de652e
(source snapshot unpacked to /tmp/codex-ref for exact grammar checks:
`Worked for`, `1m 05s` compound durations, `NN% context left` / `Nk used`
footer indicators, `·` dim separators).

## Checks actually executed

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | 142/142 pass | unit + real-component layout/golden suites |
| `npm run test:chrome` (new) | 7/7 pass | chrome modules: src/ import rule, editor factory contract, event surface, kill switch, footer/header render |
| `npm run check` (tsc) | clean | strict, whole project incl. index.ts |
| `npm run test:host` | PASS | REAL installed Pi assembly: one title per toolCallId, write five states, mouse expand/fold, third-party back-off, teardown restored, `/codex-ui` diagnostics, interaction clock lifecycle |
| `npm pack --dry-run` | 36 files, no devDeps needed at runtime | package content |
| interaction clock semantics | pass | `agent_start` opens once; `agent_end` (retry/compaction gaps) does NOT reset elapsed; `agent_settled` finalizes; thinking measured as streamed-interval UNION (pauses excluded); usage deduped by responseId |
| phase machine | pass | phases only from real content kinds (thinking/text/toolCall blocks, write-args streaming); `ui_prompt_start` → waiting-for-input; tools cannot steal that phase |
| separator persistence | pass | survives 100 streaming updates, invalidate, message_end re-renders (regression suite) |
| tool-call-only updates | pass | growing toolCall-only message_update does not close exploration group (0.7.x fix regression) |
| thinking rail unwrap | pass | dispose/rebuild restores the host's original node verbatim |
| summary persistence | pass | exactly one `pi-codex-appearance:interaction-summary:v1` entry per settled interaction; renderer registered once; `persist:false` appends nothing |
| config loader | pass | safe defaults; per-field fallback with warning; kill switch `enabled:false` |
| chrome restore | pass | `session_shutdown` clears editor slot only when the CURRENT factory is still ours (identity compare); footer/header/working cleared |

## Real-process verification

- `npm run test:host` runs against the REAL installed
  `@earendil-works/pi-coding-agent` (0.85.1 dist) and the real pi-tui — not
  fakes — through `index.ts`'s default export.
- Fresh PTY-driven `pi` TUI process (user's own 17-package extension stack,
  synced clone at the release commit): startup header `Pi 0.85.1 ·
  codex-appearance 0.8.0` + model/dir line, footer `glm-5.3-flash • high ·
  <dir>`, working ticker `● Working · 0s…8s` (monotonic), `● Thinking · 4s`
  phase, end summary `Worked for 1s · ↓8 · ↑36`, `/codex-ui` diagnostics
  showing `chrome: applied · transcript: applied · decorations:
  group-spacing=applied, separator=applied, thinking-rail=applied`, zero
  uncaughtExceptions, zero appearance warnings. Model reply rendered
  normally.
- Runtime discovery (fixed during verification): Pi's TS loader emits the
  stock `updateDisplay` with `let` (not `const`) and unparenthesized arrow
  params — the structural prefix check now accepts both stock shapes. The
  chrome header/footer/summary renderers resolve the theme painter lazily
  because the host passes an unbound theme proxy during early/restore
  rendering. `registerCommand` uses the `(name, options)` signature. All
  three were caught by the PTY run and fixed (commits 0c4377d, ea9bc63,
  6835357, 4e9c802).

## Known deviations from the Codex reference (deliberate)

- No per-line `›` composer prefix: the host `Editor` render pipeline has no
  safe per-line hook; faking one risks cursor/autocomplete/mouse drift. The
  composer keeps Pi's full native input behavior; only border accent and
  padding differ visually.
- Context indicator shows remaining `NN% context left` (Codex grammar) from
  the host's `getContextUsage()`; exact token K/M formatting falls back to
  percent-only when the host provides no token count.
- Header shows the REAL identity (`Pi 0.85.1 · codex-appearance 0.8.0`),
  never the OpenAI name.

## Interface inventory (what touches the host)

- Public APIs only: `pi.on()` (agent_start/agent_settled/tool_execution_*/
  message_*/session_*), `pi.getAllTools()`, `pi.registerCommand()`,
  `pi.appendEntry()`, `pi.registerEntryRenderer()`,
  `ctx.ui.setEditorComponent()/getEditorComponent()/setFooter()/setHeader()/
  setWorkingMessage()/setWorkingIndicator()/getContextUsage()/requestRender()/
  notify()`.
- Prototype adaptation (unchanged from 0.7.0): scoped decoration of
  `ToolExecutionComponent.getCallRenderer` and
  `AssistantMessageComponent.updateContent`, restored byte-identical on
  shutdown; structural contract check, no source fingerprints.
- No: registerTool, execute replacement, context/message mutation, session
  JSONL writes (CustomEntry above is the single granted exception), global
  Container/Markdown/stdout patches.
