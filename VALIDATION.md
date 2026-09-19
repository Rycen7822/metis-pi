# Validation record — 0.19.1 (no todo panel for work finished in an earlier session)

Report: after restarting pi the panel came back showing `Todos 6/6 done`, i.e. fully finished work popped up again.

Cause: the delayed completed-fold compared `completedAtTurn >= turn`, but `turn` is per SESSION (reset to 0 at
session_start, +1 per prompt) while the task store is per WORKSPACE. After a restart every completion from the
previous session (ordinals 3, 4, 5 …) satisfied `>= 0`, so the panel registered again.

Fix: the completion timestamp is the missing fact. `visibleRows` now requires `completedAtTurn >= turn` AND
`completedAt >= attachedAt`, where `attachedAt` is stamped at attach() (session_start). Callers that use the pure
seam before attach keep `attachedAt = 0`, i.e. the previous semantics. Verified discriminating: the new unit test
fails on the pre-fix code (temporarily reverted) and passes with it.

## Verified

- 392/392, check 0 errors. New unit test writes a "previous session" state file (old `completedAt`, old ordinals)
  straight to disk: `refresh()` registers nothing, `visibleRows(state, 0)` is false, and adding a new task brings
  the panel back — so the gate removes stale work without disabling the panel.
- pty rc=0. New final stage restarts the real TUI with a store whose tasks were all finished in the previous
  session: no `Todos N/N done` line on screen, no "task(s) pending from the previous session" notice, and
  `/todos` still prints `Todos: 5/5 done` without resurrecting the panel (positive control: the data is intact,
  only the panel stays folded). Run against the pre-fix build the same stage fails, so the regression is really
  covered.

# Validation record — 0.19.0 (click-to-toggle on the folded skill entry)

Request: a left click on the folded `[skill] …` entry expands it, another click collapses it. The entry is a host
component (SkillInvocationMessageComponent, a Box with `expanded`/`setExpanded`); no extension API reaches it, so
the click handler is installed on the class prototype at extension load.

Identity was the first thing verified, not assumed: pi's npm bin runs the BUNDLED CLI while jiti's alias resolves
extension imports through the loader (`getAliases()` / `virtualModules`). A live probe wrapping the imported
class's `updateDisplay` fired for every entry the host created (9 calls in one run), proving the imported class IS
the one the session instantiates. An entry created by the host is therefore patchable directly.

Gesture details that the code depends on, all read from pi-tui's alt-screen dispatcher:

- A `click` is only dispatched to the component that claimed the matching `press`, so a plain left press is
  claimed and the toggle happens on the click — a swallowed release can never toggle by accident.
- `press`/`click` default to `render: true`, so `setExpanded()` + `invalidate()` is enough to repaint.
- Modified clicks (Shift/Ctrl/Alt), right/middle press, wheel and move fall through to Box's own child
  forwarding, so text selection and every other behavior stay as they were.

In the compact transcript the click is routed by our own `HistoryWindow.handleMouse`, which maps a row back to the
component that rendered it (the same path the thinking-rail click uses); the plain host path works through the
same prototype patch.

## Verified

- 391/391; check 0 errors. Unit tests cover: left-press claim, click toggling expand→collapse, `invalidate()`
  per toggle, modified/right/wheel events reaching the original handler, idempotent install, and the real host
  class (patch applies, Box forwarding preserved for unclaimed events).
- pty rc=0 in a real session: after a multi-skill submit the frame shows one collapsed `[skill] …` entry with the
  bodies hidden; a click on the label expands it (both skill bodies become visible), a click on a body row
  collapses it again, and the mock still receives both skill blocks plus the trailing marker.
- Known trade-off (documented): the entry claims plain left presses over its whole area, so starting a text
  selection drag on that entry does not select; modified clicks still select.

# Validation record — 0.18.3 (multi-skill prompt folds into one collapsible entry)

User evidence (screenshot): with two skills in one input, the first rendered as a collapsed `[skill] …` entry
while the second stayed expanded as raw text. Cause is the host's user-message parser: parseSkillBlock matches a
single leading block with an anchored regex and hands everything after the first `</skill>` to a plain-text user
message component. Sibling blocks therefore land in that raw remainder.

Fix: nest every later expanded block inside the previous one's content (chain nesting, balanced tags). The model
input keeps every skill as a host-format `<skill name="…">` block with its body verbatim and in order, the host
parses exactly one block (so the transcript shows a single collapsed entry with the bodies hidden), and genuine
trailing user text still sits outside the block after a blank line, rendering as a normal user message. The
nesting also holds for three or more skills: with each block inside the previous one, the first `\n</skill>` a
non-greedy body could stop at is the outermost close.

## Verified

- 387/387; check 0 errors. Unit tests assert the nested shape (no `</skill>\n\n<skill` sibling boundary, both
  bodies present, trailing text after the outer close).
- test:host asserts the contract against the REAL host parser: our two-skill expansion parses as one block whose
  name is the first skill, whose content contains the second skill's tag, and whose userMessage is exactly the
  trailing text.
- pty rc=0: the transcript shows `[skill] pcx-pty-mux-a` and the skill bodies are NOT visible (folded), while the
  mock still receives both skill blocks plus the trailing marker with no raw tokens.

# Validation record — 0.18.2 (no extra row at the trailing space)

0.18.0 kept the editor's menu state alive by answering the trailing-space query with a one-row hint; 0.18.1 then
made the composer force that query itself, which left the row with no job. It is removed here at the user's
request: BRIDGE_ITEM, its sentinel accept branch in applyCompletion, and matchSkillBridge are gone, and the
wrapper answers nothing at the trailing space again (the editor cancels its menu there, as it always did).

The pop behavior is unchanged because the trigger no longer depends on that state: the composer's hook fires on
the bare "/" in both situations — state alive or state already dead. src/skill-tokens.ts stays: it is now the
shared token definition used by the composer hook and by the completion wrapper's context matcher.

## Verified

- 387/387; check 0 errors (the bridge tests were replaced by "no row at the trailing space" plus direct
  splitLeadingSkillHeads / isSkillPrefixOnly contract tests, and the gate test no longer expects the bridge).
- pty rc=0: the bare second "/" pops the menu and the frame is asserted to NOT contain `继续添加 skill`; the
  dead-state path (Escape first, then " " + "/") still pops; ￥ boundary trigger and full-token expansion unchanged.

# Validation record — 0.18.1 (the second "/" pops even when the editor state is dead)

0.18.0 kept the menu state alive at the trailing space, but the user found a remaining path: after the state is
ALREADY dead, the bare "/" still does nothing (first press silent, delete-and-retype pops it). That matches the
editor code exactly: any accept calls cancelAutocomplete() (hardcoded), and with a dead state the space and the
"/" keystrokes issue no provider query at all — the editor auto-triggers "/" only at line start and excludes it
from trigger characters. A provider-side fix cannot help, because the provider is never called.

Fix at the only place that can: the editor. This package's Codex composer is already a CustomEditor subclass
overriding handleInput, so after super.handleInput(data) it now checks data === "/" and, when the text before
the cursor is a complete-skill-token prefix (plus whitespace), runs the editor's own autocomplete trigger — the
same query the editor issues for a letter in a slash context. That makes the menu appear in BOTH states: the
live hint state from 0.18.0 and the dead state.

## Verified

- 387/387; check 0 errors. New unit test drives a real-shape fake editor through the hook: ordinary text,
  `src/` paths, mid-sentence slashes, and text before the prefix never trigger; `/skill:a ` + "/", `￥a ` + "/",
  and every later token do; a live menu is not re-queried; the hook is opt-in (absent without skillTrigger);
  hosts without the private trigger method stay silent instead of throwing.
- pty rc=0 with the dead-state path end-to-end: first token → Escape (state dead, menu gone) → " " → bare "/"
  pops the skill menu with no Tab and no letters → filter → accept → submit → the mock reports both skill
  blocks + trailing text, no raw token. The live-state path from 0.18.0 (hint row → bare "/") and the ￥
  boundary trigger both still pass.

# Validation record — 0.18.0 (the second "/" pops the menu by itself)

0.17.9 made Tab an immediate trigger, but the user's real flow (type `/skill:a `, then `/`) still showed no menu.
Root cause, from the editor source: a query that returns nothing calls cancelAutocomplete() and clears the menu
state; the built-in provider returns nothing for `/skill:a ` (skill commands have no argument completions), so
the state died at the trailing space. With the state dead, the bare second "/" never reaches ANY provider — the
editor auto-triggers "/" only at line start (isAtStartOfMessage), "/" is excluded from trigger characters, and
"/" is outside the letter regex. That is why only a letter, Tab, or the space+backspace dance re-armed it.

Fix: keep the state alive. At a position that is EXACTLY one or more complete, known skill tokens followed by
whitespace (matchSkillBridge), the wrapper returns a single no-op hint row (`继续添加 skill` / `输入 / 或 ￥`)
instead of null, so the editor keeps the menu and the very next "/" or ￥ keystroke goes through
updateAutocomplete() back into this wrapper with a real partial token — the real skill menu pops.

Safety properties verified by unit tests:
- The hint's value is a sentinel that never renders (SelectList renders label || value; the label is non-empty)
  and applyCompletion returns the text untouched for it, so Enter cannot mangle the message. The hint's prefix
  starts with "/", so the editor falls through to the normal submit path: Enter still sends the message
  (Tab merely closes the hint row).
- The hint appears only for complete, resolvable skill tokens plus whitespace: unknown names, half-typed
  tokens, plain text, empty input, and non-skill commands like `/todos ` never bridge.
- The built-in provider keeps its precedence everywhere it answers (base result wins over the hint).
- The gate change from 0.17.9 stays: forced (Tab) queries pass through at both the multi-skill context and the
  bridge position, so an Esc-killed state can still be recovered with Tab.

## Verified

- 386/386 (new bridge + matcher unit tests); check 0 errors.
- pty rc=0 exercising the user's exact repro end-to-end: `/skill:pcx-pty-mux-a ` → hint row →
  the BARE "/" pops the skill menu with no Tab and no extra letters → filter → accept → submit → the mock
  reports both skill blocks + trailing text, no raw tokens; plus an Esc dead-state + Tab fallback regression.

# Validation record — 0.17.9 (immediate menu triggers: Tab for "/", ￥ native)

Follow-up to 0.17.8. User evidence: after the second "/", no menu; typing a space and deleting it makes the
menu appear. Editor source (pi-tui editor.js) explains every step:

- Space cancels: while the menu state is set, a space goes to updateAutocomplete; the built-in returns null
  for `/skill:a␣` (no argument completions) → cancelAutocomplete clears the state.
- "/" never re-queries: the printable path auto-triggers "/" ONLY when isAtStartOfMessage(); trigger-char
  registration explicitly excludes "/"; "/" is outside the letter regex. A bare second "/" produces zero
  provider queries (verified: space+backspace works because the backspace handler re-triggers via
  isInSlashCommandContext).
- Extensions cannot intercept keystrokes (no editor hook), so the fix works the two levers that exist:
  1. shouldTriggerFileCompletion: the editor gates ALL forced (Tab) queries behind this hook. Our wrapper
     returns true in a multi-skill context (Tab after a bare "/" now reaches the provider); everywhere else
     delegates to the built-in unchanged.
  2. Force-mode precedence: in a multi-skill context, forced queries serve skill items BEFORE the built-in
     (which would file-complete a "/…" partial); a needle matching no skill falls back to the built-in.

Result: `￥` pops the menu on keydown (registered trigger char, charBefore=space qualifies); `/` pops on the
next letter (editor's slash-context letter branch) or immediately on Tab. A bare "/" keydown away from line
start never auto-pops — hardcoded pi-tui behavior, documented in README.

## Verified

- 384/384 (new gate/precedence/delegation unit tests); check 0 errors.
- pty rc=0 with E2E on both new paths: bare second "/" + Tab → menu → letters filter → Tab accept → submit
  → mock reports both blocks + tail, no raw token; and ￥ alone pops the menu at a token boundary.

# Validation record — 0.17.8 (completion menu for 2nd+ skill tokens)

User screenshots showed: first `/skill:` gets a completion menu; after the second `/` the menu never
appears, and `￥` gives nothing. Root cause (pi-tui CombinedAutocompleteProvider.getSuggestions read
verbatim): once the first SPACE exists, the provider only consults the found command's
`getArgumentCompletions` — skill pseudo-commands register none → null → menu gone. `￥` is outside
host semantics entirely.

## Fix

`ctx.ui.addAutocompleteProvider` (official API; same pattern as the host example
examples/extensions/github-issue-autocomplete.ts) wraps the built-in provider from `session_start`:

- Built-in answers always win (zero regression on first-token slash menus, file paths, args).
- When the built-in returns null and the cursor sits in a multi-skill context (≥1 complete
  `/skill:` or `￥` token, then a fresh `/…` or `￥…` partial), offer the same skill items the first
  token gets: label `skill:<name>`, value normalized to the trigger form (`/skill:<name> ` or
  `￥<name> `, trailing space included). A `/`-triggered FIRST token is never intercepted.
- applyCompletion delegates to the built-in's generic prefix replacement.

Debug note: a file-logging probe proved the wrapper WAS called and correctly returned null for the
first pty attempt — the fixture skill names (pcx-pty-mux-*) simply do not contain the test needle
"ta". Test input bug, not a wrapper bug.

## Verified

- 383/383 (matchSkillContext table cases + wrapper delegation/precedence/apply tests).
- check 0 errors; pty rc=0 with the E2E now driving the REAL menu: type partial `/mux-b` → wait for
  the menu (asserted via the item description "pty probe", which cannot appear in the typed text) →
  Tab accepts → submit → mock model reports both blocks, tail, no raw token. Both `/` and `￥`
  triggers exercised.

# Validation record — 0.17.7 (￥ quick skill trigger)

Extends skill-mux (0.17.6) with a `￥name` trigger alongside `/skill:name`. Verified against host
sources that `￥` is inert in the host (prompt templates are `/`-prefixed; extension commands are
`/`-prefixed; nothing consumes a leading ￥), so the syntax is entirely ours:

- One `￥` token expands HERE (the host would send it as literal text) — unlike one `/skill:` token,
  which still falls through to the host's native expansion.
- ≥2 tokens expand regardless of trigger mix; zero parses or all-unresolved input passes through
  untouched (we never re-shape literal user text with injected blank lines).
- Unresolved tokens keep their ORIGINAL form (￥nope stays ￥nope, never rewritten to /skill:nope).
- Fast path: first-char check (0x2F+startsWith or 0xFFE5), no regex on non-trigger input.

## Verified

- 381/381 (3 new ￥ tests: lone-token expansion, multi/mixed triggers, original-form preservation;
  plus `$`-is-not-a-trigger and glued-￥ pass-through cases).
- check 0 errors; pty rc=0 with the E2E now covering BOTH syntaxes
  (`/skill:a /skill:b tail` and `￥a ￥b tail` → mock reports both blocks, tail, no raw token;
  the RAW check matches both `/skill:` and `￥` leftover forms).

# Validation record — 0.17.6 (multi-skill input: /skill:a /skill:b rest)

Feature: expand MULTIPLE leading `/skill:name` tokens in one user input. The host's native
`_expandSkillCommand` only expands the first token; a second `/skill:` is swallowed as args.

## Mechanism (verified against pi 0.85.1 sources)

- `AgentSession.prompt()` emits the `input` extension event BEFORE command/skill/template
  routing; handlers may return `{action:"transform", text}` and the transformed text then
  flows through the normal pipeline. `pi.on("input", …)` is a typed overload
  (dist/core/extensions/types.d.ts). Transforms chain; "handled" short-circuits.
- Unknown `/skill:x` as a first token falls through `_tryExecuteExtensionCommand`
  (returns false when no command matches) — so multi-skill input reaches the hook intact.
- Expansion output is byte-identical to the host: `<skill name location>\nReferences are
  relative to ${baseDir}.\n\n${body}\n</skill>` with `stripFrontmatter` — the same
  `loadSkills`/`stripFrontmatter` functions the host uses are imported from
  "@earendil-works/pi-coding-agent" (the loader aliases that specifier to the host's own
  dist, so semantics cannot drift).
- Steer/followUp paths call `_expandSkillCommand` directly and do NOT emit the input
  event — mid-stream multi-skill only expands the first token (documented limitation).

## Verified

- 378/378 (9 new hermetic skill-mux tests: tmpdir fixtures for settings-declared,
  default-dir, project-dir, and manifest-declared skills; pass-through cases; negative
  cache and single-build reuse stats; unknown-name literal fallback; glued-token
  host-consistency).
- check/check:core 0 errors; host-smoke PASS.
- pty rc=0 with a new E2E stage: two fixture skills under the harness's fake-HOME
  agentDir, real composer input `/skill:pcx-pty-mux-a /skill:pcx-pty-mux-b MUX_TAIL_MARKER`,
  mock model reports `MUX_REPLY A=true B=true TAIL=true RAW=false` — both blocks arrived,
  trailing text intact, no leftover raw `/skill:` token.

# Validation record — 0.17.5 (todos overlay removed)

The user asked to delete the inline interactive overlay that popped up in the middle of the screen on
`/todos` (screenshot: `── todos (6 tasks) ─` block with an Esc-to-close help line). Rationale: the
persistent panel plus the todo tool cover its use cases.

## What changed

- Deleted `src/todo/overlay.ts` and `test/todo-overlay.test.mts` outright.
- `/todos` now always: (1) restores the panel via `showPanel` when the user hid it with a right click,
  (2) prints the task list as a text notify via `renderListText` (the previous empty-state branch is
  unchanged). The commands dep `openOverlay` became `showPanel`.
- pty stage 3e: after the right-press hide, `/todos` must bring the panel straight back and the frame must
  NOT contain the `── todos (` overlay title (the old Esc-close loop is gone).

## Verified

369/369 tests (372 minus the 3 overlay tests), `npm run check` and `check:core` 0 errors, host-smoke PASS,
pty rc=0 with the rewritten stage.

# Validation record — 0.17.4 (right-press hide for terminals that eat the right release)

User report: right-clicking the todos panel did not hide it in Warp, even though 0.17.2 shipped a right-press
claim. Three probe rounds established the facts:

1. Warp has mouse reporting ON, but forwards mouse events only in the ALTERNATE screen (probes on the main
   screen received nothing; pi runs in the alt screen, which is why left-click expand worked).
2. In the alt screen with pi's exact mode set (?1000h ?1002h ?1004h ?1006h): LEFT press+release arrive,
   RIGHT press arrives (4x in the log) but its RELEASE is consumed by Warp's context menu, MIDDLE and
   CTRL+LEFT never arrive.
3. pi-tui's real dispatch (bundle chunk read verbatim): a component-claimed press makes the host remember a
   press target and synthesize a click only when the release lands. With no right release from Warp, the
   0.17.2 claim-without-hiding never produced a click — panel stayed. tmux sends releases, which is why the
   pty suite was green.

## Fix

`handleMouse` now hides ON the right press and deliberately returns `undefined` (no claim). An unclaimed
right press costs nothing: no other component claims right presses, and the selection path ignores
non-left buttons. A claimed press would leave a stale press target (release never comes) swallowing every
later mouse event into the unregistered widget — the no-claim choice keeps the host gesture state clean.
The right-click branch was unreachable after this change (no claim → no synthesized click) and is removed.

## Verified

- 372/372; `npm run check` 0 errors.
- pty rc=0 with the hide stage rewritten to the Warp-real path: a bare right PRESS (no release) hides the
  panel; a separately-sent release changes nothing; `/todos` restores it; and left clicks afterwards still
  expand/collapse the panel — the regression guard against a stale host press target.

# Validation record — 0.17.3 (keyboard shortcut removed)

User request: drop the `ctrl+shift+t` toggle entirely, code included. The widget is now mouse-only:
left click expands/collapses, right click hides, `/todos` restores.

Removed: the `pi.registerShortcut` block in `extensions/todo.ts`, the keyboard mention in the widget
header comment and README. Assertions flipped to prove the absence: host-smoke asserts the extension
registers zero shortcuts; the pty `/hotkeys` stage positively asserts no codex-todo entry (the vendored
codex-conversion shortcut assertion stays).

Verified: 372/372, `npm run check` 0 errors, host-smoke PASS, pty rc=0.

# Validation record — 0.17.2 (manually hiding the todo panel)

User request: the panel can be manually hidden. Chosen interaction: RIGHT CLICK anywhere on the panel hides
it; opening /todos restores it. The hide persists (`widgetHidden` setting).

## Host contract discovered by reading pi-tui (not assumed)

In `handleMouseEvent` (pi-tui `tui-alt-screen.js`), a `click` event is ONLY synthesized when the original
`press` was claimed by a component (`mousePressTarget` branch). Left presses are claimed upstream by the
chat viewport (selection anchor), so a left click is forwarded back down to the widget by coordinates. A
RIGHT press is claimed by nobody — selection handling only accepts button 0, right-click-paste is
Windows-only — so no click is ever synthesized and a right-click-only handler would be dead code. Fix: the
component claims the right press (`{handled: true}`); the release then synthesizes a click that
`dispatchMouseToTarget` sends straight back to this component.

## Verified

- `test/todo-widget.test.mts` (11 tests, +2): a right click hides (press claimed + click handled), the hide
  persists to settings, refresh() unregisters instead of rendering, store changes while hidden cause no
  re-registration, `show()` restores and persists, and a fresh widget over the same store stays hidden
  (restart semantics).
- 372/372 project tests, `npm run check` + `check:core` 0 errors.
- `npm run test:pty` rc=0 with a new stage: real SGR right clicks make the panel disappear, `/todos` opens
  the overlay (lists all five tasks), Esc closes it, and the panel is back above the editor.
- Harness hardening: the overlay renders inline (the panel below stays visible either way), so closure is
  asserted on the overlay title, not the panel; Esc can race the overlay's input registration, so the
  closure loop may resend Esc (on the closed editor it is a no-op).

# Validation record — 0.17.1 (clickable codex-todo panel)

Interaction change requested from a screenshot: the persistent todo list grows by one row (three task rows
instead of two) and the keyboard fold is replaced by the mouse — a left click on the panel expands the full
list, a second click returns to the three-row view. `ctrl+shift+t` stays registered but is no longer
advertised in the header.

## How the mouse path works (checked against the host, not assumed)

- pi-tui's fullscreen TUI hit-tests its layout per event (`dispatchMouseToLayout` → `getLayoutBoxesAt`) and
  calls `handleMouse` on the component under the cursor; `Container`/`Box` forward to children by row.
- `setExtensionWidget` with a factory stores the component instance it returns and re-adds it to the widget
  container each render, so a component-level `handleMouse` keeps working across frames.
- The widget therefore gains `handleMouse` with no pi-tui import: left `click` toggles, anything else
  (wheel, right click, press) returns `undefined` so the transcript keeps it.

## Verified

- `test/todo-widget.test.mts` (9 tests, +2): three task rows then the summary at index 4 when truncated;
  expanded shows all six tasks with no summary and persists `widgetExpanded`; a click component toggles
  collapsed (6 lines) → expanded (7 lines) → collapsed, claiming `{handled: true}` while ignoring
  wheel/right-click/press; the height latch pads instead of shrinking under live updates (still exactly
  `first.length` lines after completions) but follows an explicit expand/collapse.
- 370/370 project tests, `npm run check` 0 errors.
- `npm run test:pty` rc=0 with a new stage: the mock adds four more tasks, the frame shows
  `Todos 0/5 done ▾ · click to expand` with exactly three `○ pty task` rows plus
  `+2 more (0 completed, 2 pending)`; **real SGR left clicks** at the panel then produce
  `Todos 0/5 done ▴ · click to collapse` with all five rows and no summary row; a second click restores
  the three-row view. Panel assertions read the widget's own row range, because the transcript above also
  prints the task titles.
- Two harness assertions that the taller panel exposed were fixed rather than loosened: the diagnostics
  block is now read from both ends (wheel up for the header segments such as the speed scope, then wheel
  back to the live tail, since the TUI keeps a manual scroll position), and the `/hotkeys` assertion follows
  the new shortcut description.

# Validation record — 0.17.0 (vendored codex-conversion)

`@howaboua/pi-codex-conversion` 3.0.34 is now part of this repository instead of an installed npm
package: patchable sources under `vendor/pi-codex-conversion/src`, a committed build at
`vendor/pi-codex-conversion/dist` that pi loads directly, and vendor tooling
(`scripts/vendor-codex-conversion.mjs`: build / check / patch / sync). Provenance, payload scope and
the upgrade procedure: `vendor/pi-codex-conversion/UPSTREAM.md`; the patch list: `PATCHES.md`.

## Facts established before the design was fixed (measured, not assumed)

- Build reproducibility: `tsc -p tsconfig.build.json` with TypeScript 5.9.3 produces 642 files; against
  the published npm `dist` the only differences are 11 `.d.ts` files whose union members are ordered
  differently (declaration-emit cosmetics) and the `.js` file we patch.
- Source-only loading is impossible: `src/**` contains 110 `from "./x.js"` specifiers (NodeNext style)
  that Node's type stripping does not rewrite — hence a build step, and `dist` is committed so pi needs
  no build at install time.
- pi installs npm dependencies for git-sourced extension packages (`installGit` → npm install, plus
  auto-repair), so the vendored runtime's 8 dependencies are declared in the root `package.json`.
- Runtime assets resolve relative to the package root (four levels up from
  `dist/tools/native/binary.js`), so `dist/`, `vendor/`, `code-mode/`, `src/tools/<tool>/bin/<platform>-<arch>/`,
  `CHANGELOG.md` and `package.json` must keep their positions.
- Nothing else imports this package's subpath exports — replacing the npm install is self-contained.

## Verified (Node 24.15.0, Pi 0.85.1)

- `npm run vendor:build` → `dist/` regenerated; the emitted `notebook-tool.js` is byte-identical to the
  npm patch that unblocked subagents (comments aside); the built module's schema serializes to
  `{"type":"object","required":["action"],...}` with no `anyOf` (checked against the real `typebox`).
- `npm run vendor:patch` → exactly one patched file; round-trip verified in both directions: reverting
  the patch reproduces upstream byte-for-byte, re-applying it reproduces the vendored tree byte-for-byte.
- `npm run vendor:check` → 0 type errors on the vendored sources.
- `npm run vendor:smoke` → the vendored entry activates against a recording fake pi: 12 tools, 2 commands,
  8 shortcuts, 27 event subscriptions, and **every** tool's parameters serialize to a JSON Schema object
  (no second top-level union besides the one we fixed).
- Manifest integration: `pi install <repo>` into an isolated `$HOME` followed by pi's own package
  resolver lists four entries ON — `extensions/*.ts` ×3 plus
  `vendor/pi-codex-conversion/dist/index.js`.
- `npm test` 368/368; `npm run check` and `check:core` 0 errors; `npm run test:host` PASS;
  `npm pack --dry-run` ships `vendor/` (13.2 MB unpacked, 4.5 MB tarball).
- `npm run test:pty` rc=0 with two new assertions: the startup frame must not contain
  `[Extension issues]` or the missing-CHANGELOG warning (both of which the vendored copy produced before
  this change was finished), and `/hotkeys` must list the vendored codex-conversion shortcuts and the
  codex-todo shortcut — positive proof that both extensions' registrations reach a live session.

## Defects the new gates surfaced (fixed here)

- `npm run check` never typechecked `extensions/**`: the include list still named the pre-0.16.0
  `index.ts`/`goal.ts`. Fixing it immediately caught five stale inline type imports
  (`import("./src/…")` left behind by the 0.16.0 move; type safety had silently degraded) and the todo
  tool's result missing the host-required `details` field.
- The pty harness needed the plugin's shortcut override (`alt+u`, as the dev machine configures) and the
  changelog `suppress` flag: with upstream defaults the plugin collides with pi's `alt+q` built-in and
  renders its what's-new block, both of which shift rows and break coordinate-based stages.

# Validation record — 0.16.0 (agent-stuff layout + codex-todo sub-plugin)

Two deliverables, one structural: the package manifest now exports `./extensions/*.ts`
(glob, mitsupi-style). `index.ts` → `extensions/appearance.ts` and `goal.ts` →
`extensions/goal.ts`; `src/` paths untouched (the 323-test display suite needed no
changes) and the pty harness needed none (it installs the repo dir; pi resolves the
manifest). On top of that layout ships the third entry, `extensions/todo.ts` —
codex-todo, distilled from three upstreams (full analysis in
`docs/0.16.0-todo-plugin-plan.md`):

- rpiv-todo: register-once setWidget with a getter-closure factory; stable-height
  latch; pure line budget (completed dropped first, then pending tail, one row for
  `+N more`); delayed completed-fold (completedAtTurn < turn); zero polling; the
  no-change result convention (`No change: ...` instead of an error, so the model
  does not retry identical calls); blockedBy with incremental add/remove; VALID_TRANSITIONS
  with named-state errors; text sanitizing before the TUI.
- pi-goal-x: completion blocked by default (unfinished subtasks listed; evidence
  required, recorded as an UNTRUSTED claim; optional evidenceFiles must exist on
  disk); skip cascade with per-task reasons; derived parent display status (never
  stored); restart recovery reminder with concrete open-task numbers; doctor command
  stays read-only unless the user asks for gc.
- pi-agent-extensions todos: per-mutation cross-process lock (wx, 30min TTL, expired
  locks archived as `stale-lock-*` for the doctor); claim/release as long-lived task
  records distinct from locks, with `force`; gcDays GC that reparents survivors;
  host named keybindings in the overlay.

Deliberate deviations from the plan, recorded: (1) merge-by-id was dropped — the
action-based tool API never has the model resend whole documents, so the failure
mode it solves cannot occur; (2) 4-state machine instead of pi-goal-x's
3-state+currentTaskId, because parallel subagents mean several tasks are live at
once and one focus pointer cannot express that; (3) a child blockedBy its parent is
legal (waiting-on-parent is signal, not deadlock) — only waits-for edges cycle-check.

Verified (Node 24.15.0, Pi 0.85.1):

- `env -u NO_COLOR npm test`: 368/368 — 45 new todo tests (model purity, store
  persistence/locking/GC, tool policy incl. throw-vs-no-change and evidence files,
  widget rows/register-once/fold persistence/overflow/latch, overlay interactions).
- `npm run check` / `npm run check:core`: 0 errors.
- `scripts/host-smoke.mjs`: new block activates `extensions/todo.ts` against a
  recording fake pi — asserts tool `todo`, commands `todos`/`todos-doctor`,
  shortcut `ctrl+shift+t`, session_start store creation, an end-to-end tool
  add/list round trip, and the aboveEditor widget registration.
- `scripts/pty-verify.mjs`: new stage 3c — the mock provider calls the `todo` tool
  (`add "pty task"`); the real TUI frame shows the `Todos 0/1 done` panel with the
  task row, and `workspace/.pi/codex-todos/tasks.json` exists on disk.

# Validation record — 0.15.4 (footer change counts clear on commit)

Reverses the 0.13.0 pinned-revision decision at the user's explicit request ("commit 之后工作树应该是干净了，要清空数据"). Reproduced first against the real tracker: edit `+4` → `git commit` → the stat froze at `+4` (the diff was pinned to the session-start commit, so the committed work stayed inside the comparison forever; no `onUpdate` ever fired again).

New semantics: every read re-resolves HEAD; when HEAD moved (commit / amend / rebase / pull), the committed delta (`git diff oldRev newRev --numstat -z`; `diff-tree --root` for an unborn baseline) is folded OUT of the per-path baseline (`foldCommittedDelta`: committed paths subtract their committed counts and drop out at zero; committed untracked-baseline entries are purged so a later edit starts a fresh count). A commit therefore CLEARS the footer; work that is still uncommitted keeps counting from its baseline; work made after the commit counts fresh against the new HEAD (never absorbed into the re-baseline, never frozen against the old rev). A failed fold falls back to re-baselining against the current work tree — transient under-report, never stale numbers.

Verified by a real-git repro script (temp repo, real `git`): baseline `+0` → dirty `+4` → commit → `+0 −0` with the update fired → post-commit edit → `+3`. Unit layer: `test/git-changes.test.mts` (14 cases) — the fake-exec tracker case now simulates HEAD moving `rev1 → rev2` (fold call answered separately from the work-tree diff) asserting clear-on-commit and fresh counting after it; the real-git case asserts `+7 −1` → commit → `0/0` → post-commit edits `+3 −0/2 files`. End-to-end: `scripts/pty-verify.mjs` now asserts the footer shows `+8 −2` before the commit, NO counts within 4s after it, and `+3 −0` after appending three lines. `npm run check`/`check:core` 0 errors.

# Validation record — 0.15.0 (footer R/W counters removed)

Removed at the user's request: the footer's session-cumulative cache read/write counters (`R112M W0`) and the `footer.showCacheReadWrite` switch that gated them. The measured case for removal, taken from this session's own JSONL: 656 confirmed requests summed to 112,334,848 cache-read tokens (median 159,744 per request — each turn re-reads the whole long context from the provider cache), while the write counter is structurally 0 because the OpenAI/DeepSeek-style endpoint this session runs on reports cache hits only (no Anthropic-style `cache_creation_input_tokens`). Two numbers that occupy the wide-screen right block without informing a decision; `cache NN%` — the hit rate of the latest confirmed request — stays and carries the actionable signal.

Scope removed: the footer segment, `FooterShow.showCacheReadWrite`, the config key (type, default, parser), the footer P2 width-trigger tier (the ladder is now  shorter dir → wrap to two rows), the `rw=` field on the `/codex-ui` config line, and the cacheRead/cacheWrite numbers in the `session Σ` and `interaction usage` diagnostic lines. Deliberately kept: `UsageLedger`/`UiMetrics` still parse and accumulate cache fields (`cache(last)` consumes the ratio; the interaction-summary persistence schema carries the amounts), and every raw usage shape in the test/harness fixtures is unchanged.

Verification (Node 24.15.0, Pi 0.85.1):

- `env -u NO_COLOR npm test`: 323/323. The wide-screen footer case now asserts `assert.doesNotMatch(frame, /R\d|W\d/)` — the old `R10k` assertion is gone and its absence is itself covered; `↑`/`↓`, `cache 20%`, quota and speed assertions are untouched.
- `npm run check` / `npm run check:core`: clean; no `showCacheReadWrite` reference remains anywhere in `src/`, `test/` or `scripts/`.
- host-smoke and pty unchanged (neither asserted R/W); `npm run verify` rc=0 at 0.15.0.
- A user config still carrying `footer.showCacheReadWrite` is ignored silently: the key is simply no longer read, and no other footer key is affected (parser untouched elsewhere).

# Validation record — 0.14.0 (glyph text-presentation)

The transcript could show `grep -n "✖\|# fail"` as `✖|# fail`: the user's screenshot (pixel-measured here) showed the ✖ glyph's ink at 24×24 px against a 15 px cell pitch — emoji-presentation marks are advanced one cell by the terminal (pi-tui's WIDTHS table agrees: U+2714/U+2716 are 1-wide) but drawn from a color-emoji font ~1.6 cells wide, composited over the text layer, so they cover the next character. The session log confirmed the backslash was in the content all along; the grid itself never moved.

The fix is a last-mile, display-only rewrite: the frame string a TUI hands its terminal is scanned, and every occurrence of a curated mark (✔ ✖ ✓ ✗ ⚠ by default, extensible via `glyphs.include`) gains a U+FE0E text-presentation selector unless the content already carries an explicit selector. Properties that make it safe:

- **Content untouched**: component renders, the session record and the selection-copy serializers never see the selector; only the terminal's byte stream changes. The pre-existing 161-char exact-copy pty case still passes byte-for-byte.
- **Width-neutral**: pi-tui's width table has [65024,65039,0] (VS15 = zero width) and the insertion happens after layout, so rails, backgrounds, mouse geometry and column mapping do not move — asserted against the host's real `visibleWidth` in host-smoke.
- **Escape-aware**: SGR and OSC sequences are copied verbatim (an OSC 8 hyperlink whose URL contains ✔ keeps it byte-identical; an OSC 52 clipboard payload is ASCII-safe), an explicit U+FE0F emoji request is respected, and a truncated final escape terminates at end-of-frame without crashing.
- **Install**: the write method of the captured TUI's terminal is patched (prototype when the class owns it, the instance when a host shadows it), idempotent via an owner symbol, retried by the existing captureTui path for new terminal instances.

Verification on Node 24.15.0, Pi 0.85.1:

- `env -u NO_COLOR npm test`: 323/323, including 8 new cases for `src/glyph-presentation.ts` (CSI/OSC-BEL/OSC-ST/DCS boundaries, selector never doubled, explicit presentation respected, escape sequences verbatim, prototype-level idempotent install shared across terminal instances, instance-level writer, non-string writes passed through and not counted).
- `npm run check`, `npm run check:core`: pass; host-smoke additionally asserts `visibleWidth("✖\uFE0E") === visibleWidth("✖")` and that a real pi-tui frame (SGR + `hyperlink()` OSC 8 + plain marks) gains selectors only in its visible text.
- `env -u NO_COLOR npm run test:pty`: real TUI pass. A mock tool runs `printf '✔ done\n✖ fail\n'`; the captured screen shows `✔\uFE0E done` / `✖\uFE0E fail` in every place pi renders them (command rows and output rows — tmux preserves zero-width selectors in capture-pane, verified in isolation), zero bare marks remain, and `/codex-ui` reports `glyphs: applied(terminal prototype write) marks=5 [✔ ✖ ✓ ✗ ⚠] frames=N changed=M` with N,M > 0.
- Every earlier stage still passes in the same run (peek window, footer session counts, Working rhythm, tool run, provider error, exact selection copy, fullscreen margins).

Not verified: the selector's effect inside the user's actual Windows Terminal font stack (it is honored there in general, and harmless where ignored); glyphs with no text form (✅ ❌ 🔴) are deliberately out of scope.

# Validation record — 0.13.0 (session change counts)

The footer's `+A −D` segment used to be "work tree vs HEAD". That made a session's own commits erase its progress, left only the residual diff on screen, and made that residual look like a net change (A `+11 −9` and B `+6 −5` reading as `+3 −0`). It also capped "latency" at "until something else moves", because the number was describing a moving baseline. The segment now reports the SESSION's work:

- the session's first read is the baseline, per path, so uncommitted work that predates the session is not credited to it (a fresh session in a dirty tree starts at `+0 −0`);
- later reads diff against the revision the session STARTED from (HEAD resolved once at the first read; the index when HEAD is unborn), so a mid-session commit changes nothing: git keeps reporting the same rows because the comparison point is pinned;
- untracked files contribute the lines they gained after the baseline, counted by streaming (no whole-file read), cached by size+mtime; a file the session commits keeps its baseline lines subtracted, so only its growth counts;
- per dimension, per path: `max(0, current − baseline)`, so the pair is always ABSOLUTE additions and deletions — never a net line delta, never negative;
- every writer counts: the numbers come from git and the work tree, never from a tool ledger, so `sed`/`python`/another terminal are indistinguishable from the agent's own tools.

Also fixed here: the display used the footer's compact token formatter, so a large session read `+1.1k −81`; change counts now format exactly (`+1108 −81`, `formatExactCount`), and the segment keeps its diff green/red.

Latency, measured on this machine (Node 24.15.0, Pi 0.85.1, real tmux TUI, isolated HOME, mock provider, 4-line worktree):

- idle, untracked file created from outside the agent: **1.8 s** after the write (the 2 s poll, plus one frame);
- idle, tracked file rewritten: **2.0 s**;
- during a live run: **303 ms** (the activity-driven debounce; the tracker log shows reads of 5–18 ms, scheduled 250 ms after each tick with no queueing);
- after a mid-session `git commit`: the footer still reads `+7 −2` while `git diff --numstat HEAD` is empty — the case the user reported as `+3 −0`.

Hardening that came out of the same review: untracked counting streams in 64 KiB chunks instead of `readFileSync` (a 200×250 KiB untracked set used to be read synchronously on every poll); every git call now has a 5 s timeout with SIGKILL, plus `--no-ext-diff --no-textconv` (a user's GUI diff driver or textconv filter could previously hang the poll) and keeps `--no-optional-locks`; and a failed or timed-out read keeps the previous numbers instead of flashing 0. `npm run check`/`check:core` pass.

Tests: `npm test` 315/315 — `test/git-changes.test.mts` rewritten to 14 cases pinning `git diff --numstat -z` parsing (binary rows, rename rows keyed by the new path, tab-bearing paths), streaming line counts (multi-chunk, no trailing newline, binary, over-cap, missing), the size+mtime cache, the pure baseline math including the untracked→tracked transition, the tracker (baseline publish, interval, activity debounce, coalescing, dispose, keep-last-good on error), and real-git integration (script-made edits, mid-session commit, ignored/binary exclusion, `+17 −14` never collapsing to `+3 −0`). `test/chrome.test.mjs` asserts the exact integers and that no `k` compaction can appear; `scripts/pty-verify.mjs` asserts the whole story in a real TUI: pre-existing work shows nothing, a script-written file reads `+3 −0`, a tracked rewrite with deletions reads `+8 −2` (absolute, not net), a mid-session commit keeps `+8 −2`, and later edits read `+11 −2`.

Not verified: a repo large enough for git's own diff to become the bottleneck (this machine reads a 20k-file repo in ~40 ms either way), and window-filesystem behaviour (`/mnt/c`) where stat/read costs dominate — the design bounds them (one process per read, hard timeout, cached streaming counts) but no measurement was taken there.

# Validation record — 0.12.0 (thinking peek window)

The thinking block no longer streams wide open. `thinking.streaming` gained `"peek"` (now the default): while a run is active it renders as a window of the newest `thinking.peekLines` (default 6) rendered rows with one dim hint row (`… N above of M lines (scroll · double-click for all)`); the wheel scrolls inside that window and the event falls through to the transcript at either end, so the page still scrolls when there is nothing left to reveal. On completion the run folds once per the `completed` policy (default collapsed, unchanged from 0.11.0).

Click semantics are one rule set for streaming and finished runs: a single click toggles folded ↔ 6-row window, a double click toggles 6-row window ↔ fully expanded (a double click from folded opens it fully). The single action is DELAYED by 300ms: the host identifies a double click by component identity, and every rebuild (streaming, scroll, update) creates a new wrapper — landing the single immediately would both reset that identity and shrink the block before the second click arrives. A click made after the run finished is remembered; the completion fold (`foldOnEnd`) clears a shape the user opened WHILE streaming, exactly once, so later rebuilds cannot re-fold a finished run behind the user's back.

Only a click is stored per run; the rest of the view is derived per render from `ended` plus the configured policy. That was forced by a real-TUI defect found during verification: storing the policy default left a stale "collapsed" record behind when the host re-showed a run (fresh component, Ctrl+T), and the shown-but-recorded-collapsed path then unfolded the whole body. `src/thinking-view.ts` is the state machine, `src/transcript-adapter.ts` the composition (click layer outside the rail, peek window inside it), `index.ts` the two host components (window + click layer).

Verification on Node 24.15.0 and Pi 0.85.1:

- `env -u NO_COLOR npm test`: 310/310 pass. `test/thinking-view.test.mts` (13 cases) pins the window math (tail-following, absolute-top pinning so streamed rows do not move what is being read, clamping at both ends), the click table, the delayed single click, double-click pairing by time AND position, cancellation, and the fold-once behaviour. `test/transcript.test.mts` adds two adapter cases: the active run composes click-layer → rail → window (sized by the policy) → host body, a scroll requests the rebuild; and a double click during streaming records "full", the completion fold hides the run, a post-completion click survives three further rebuilds.
- `npm run check`, `npm run check:core`: pass (the new modules are in the strict project).
- `env -u NO_COLOR npm run test:host`: pass — the real `AssistantMessageComponent` + real mouse dispatch. The click case now asserts the 300ms delay, the visible reasoning window, the click-layer marker on the region's child (via the public `Symbol.for` key) and the host override it writes.
- `env -u NO_COLOR npm run test:pty`: real tmux/PTY pass. New stages: the live reasoning shows 6 rows + a hint row and clips the head of the stream; a wheel over the settled window scrolls it in place (`… N above, M below`) and wheel-down returns it to the tail; a single click folds ↔ 6-row window; a double click expands fully (no hint) and returns to the window. Every earlier stage still passes (footer `+3 -0`, measured tok/s, Working rhythm, tool run, provider failure, 161-char selection copy, fullscreen gutters).
- Two test-harness defects were fixed along the way and are part of the record: the thinking stages now match only rows ON SCREEN (the capture keeps 200 rows of scrollback, so a hint left in history used to satisfy the pattern), and they click the middle of the block instead of its first row (the pane's region hit rows sit a row or two off the captured rows).

Not verified: a real-model reasoning stream (the pty mock streams `reasoning_content` in chunks, which is the same host path but not a provider's own pacing); the 300ms single-click latency is a deliberate trade-off, not measured against user perception.

# Validation record — 0.11.0 (footer working-tree change counts)

The footer's bottom-right cost readout ($0.00) is gone, and the branch in the bottom-left now carries the working-tree change counts: `~/proj (main) +99 -20` painted in the diff renderer's own green/red. Counts are relative to HEAD (staged + unstaged through `git diff --numstat HEAD`) plus untracked, non-ignored files (`git ls-files --others --exclude-standard`, line-counted from disk). `footer.showCost` is removed from the config schema — a leftover key in an existing `codex-appearance.json` is simply ignored, since the loader never validates unknown keys (verified in `src/config.ts`: only known keys are read, `problems` reports only malformed values) — and `footer.showChanges` (default true) gates the new segment.

Costs of the read path are bounded, not incidental: a cwd without git metadata (`findGitDir`) never spawns git at all; the tracker polls every 2 s, coalesces concurrent reads, drops a read that lands after `dispose()`, and asks for a repaint only when the numbers changed; untracked counting skips binaries (NUL in the first 8 KiB) and files above 256 KiB and caps at 200 files, so a pathological tree cannot stall a render. Any failure degrades to "segment omitted", never to a wrong `+0 -0` and never to an agent-visible error.

Verification on Node 24.15.0 and Pi 0.85.1:

- `env -u NO_COLOR npm test`: 295/295 pass.
  - `test/git-changes.test.mts` (9 cases): numstat parsing (including binary `-\t-` rows and renames), NUL-separated untracked paths, line counting (trailing newline / none / empty), the binary and size guards on the real reader, untracked additions merged with tracked ones, half-readable and non-repo degradation, interval polling with change-only notifications, in-flight coalescing, and a late read after `dispose()`. The last case runs **real git** in a temp repo: one tracked edit (−1/+2) plus one untracked 2-line file plus one ignored file → `{ additions: 4, deletions: 1, files: 2 }`.
  - `test/chrome.test.mjs`: layout keeps `(main) +99 -20` on the branch row with tones `add`/`del`, prints nothing for a clean or unknown stat, honours `footer.showChanges: false`, uses the compact `+12.4k -1.1k` form, and renders no `$`/cost value at any width; the added activation case builds a real dirty repo, waits for the 2 s poll, and asserts the painted frame contains exactly `\x1b[32m +4\x1b[39m` and `\x1b[31m -1\x1b[39m` — i.e. the tone painter shares `diffSignFg` with the diff renderer.
- `npm run check`, `npm run check:core`, `env -u NO_COLOR npm run test:host`: pass (`git-changes.ts` is covered by the strict `tsc` project).
- `env -u NO_COLOR npm run test:pty`: real Pi tmux pass with a real git work tree in the workspace; stage 1 now asserts `(main) +3 -0` in captured frames for one untracked 3-line file. Every earlier stage still passes: metadata + footer split, measured `tok/s` left of `↑input`, Working rhythm, thinking timers, tool run, provider failure, 161-char selection copy (exact=2 mixed=0 native=0), fullscreen gutters.

Not verified: colour on a real terminal was checked at the SGR level (truecolor capability in the frame test) rather than visually; the pty frames strip SGR, so they prove text placement only. Untracked counting reads files from disk, so a file changing underneath the poll is reported at its next read (≤2 s).

# Validation record — 0.10.0 (vendored goal extension)

The package gained a second entry point, `goal.ts`: the long-running objective mode from mitsuhiko/agent-stuff (`extensions/goal.ts` @ `122e299`, Apache-2.0), vendored under this project's maintenance. `/goal <objective>`, the `create_goal` / `get_goal` / `update_goal` tools, the `goal` CustomEntry state log and the footer status line behave as upstream. The one behavioral change is marked in the file header: while a goal is active, a 1-second timer re-pushes the footer status (`syncStatusTimer`, `unref()`, stopped on pause / block / completion / clear). Upstream only recomputes that string at goal lifecycle events, and Pi's `ctx.ui.setStatus` holds a static string, so a goal finished inside one long agent run stayed frozen at `Pursuing goal (0s)` from creation until the next state change. The timer only reads the snapshot; elapsed time is still accounted only in `agent_end`, so the reported total is unchanged.

Verification on Node 24.15.0 and Pi 0.85.1:

- `env -u NO_COLOR npm test`: 284/284 pass. The five new `test/goal.test.mts` cases drive the real extension against a stub Pi host under `node:test` mock timers: command and tool surface, exactly one refresh per second while active (`0s → 1s → 2s → 3s`), no refresh while paused or after `update_goal` completion, no refresh after `/goal clear`, and `agent_end` accounting 3 s for a 3 s run (the per-second refresh does not double-count).
- `npm run check`, `npm run check:core`, `env -u NO_COLOR npm run test:host`: pass. `goal.ts` is in `tsconfig.json`, so the vendored file passes the project's strict `tsc` (`noUnusedLocals`/`noUnusedParameters`) without changes.
- `env -u NO_COLOR npm run test:pty`: real Pi tmux pass with **both** entries loaded from the package (the isolated harness installs this repository as a local path package). Every 0.9.11 stage still passes: measured `tok/s` left of `↑input`, Working rhythm, thinking timers, tool run, provider failure, exact 161-character selection copy (exact=2 mixed=0 native=0), fullscreen gutters.
- Package-loading probe: with an isolated `HOME` whose settings list only this repository as a local path package, real Pi 0.85.1 printed the temporary import marker of the packaged `goal.ts` (`[probe-package-goal] loaded`), confirming the manifest's second entry loads; the marker was removed afterwards. In the real settings the agent-stuff copy remains excluded by its unchanged `"-extensions/goal.ts"` filter, so `/goal` is registered once — verified by importing both files with temporary markers (only the vendored copy printed), with both files restored afterwards.
- Package-content check (`test/package.test.mjs`): the manifest is asserted as `["./index.ts", "./goal.ts"]`; `goal.ts`, `LICENSE-APACHE-2.0` and the `files` entries must exist; `NOTICE` must name the upstream. The display-only invariant (no `registerTool`/`sendMessage` registration, no `context`/`before_agent_start`/`tool_call`/`tool_result` hooks, `appendEntry` only in `turn-summary.ts`) is now explicitly scoped to the codex-appearance runtime (`index.ts` + `src/**`); `goal.ts` is the deliberate exception covered by `goal.test.mts`.

Not verified: a live interactive `/goal` run driven with a real provider (no TUI session was driven against a model); the ticking footer is covered by mock timers against the real extension, and the real-TUI pty run covers the same file loading with both entries. Re-syncing future upstream changes is manual by design.

# Validation record — 0.9.11 (footer output speed)

The footer shows one measured rate, at the requested slot in the right block, immediately left of `↑input`: the confirmed `usage.output` of an assistant response divided by the real observed output window (first→last streamed delta, TTFT excluded; `message_start`→`message_end` when no delta span exists). Nothing is estimated from reply length, no provider-reported rate is trusted, and an unmeasurable response adds no segment at all (window < 300 ms, no confirmed output tokens, or a rate outside 0.1..5000 tok/s) — `0.0 tok/s` is unreachable because a value that rounds to zero is dropped. When a provider publishes cumulative output tokens mid-stream (Anthropic-style `message_delta`) the same formula updates live and is then replaced by the confirmed value at `message_end`; OpenAI-compatible providers report usage only in the final chunk, so there the number appears once and persists. A response ending without usage records nothing and leaves the previous measured rate in place; session shutdown clears it.

Verification on Node 24.15.0 and Pi 0.85.1:

- `env -u NO_COLOR npm test`: 279/279 pass, including 11 new output-speed cases (delta span, request-window fallback, sub-minimum burst fallback, no-confirmed-tokens, persistence across a usage-less response, live-then-final replacement and monotonic preview, window/token gates, reset, rails, formatting) and 2 chrome cases (segment position/config gate/no-overflow at 40/60/80/120; the real handler chain `message_start → text_delta → message_end` producing a rate in the rendered footer, plus the live path from cumulative streamed usage).
- `npm run check` and `npm run check:core`: pass.
- `env -u NO_COLOR npm run test:host`: pass.
- `env -u NO_COLOR npm run test:pty`: real Pi tmux pass. The isolated mock provider streams 2 characters per 250 ms and confirms `completion_tokens: 80`, so the PTY assertion covers a real ~500 ms delta window: the footer row carries `N tok/s` left of `↑input`, and `/codex-ui` prints `output speed: N tok/s (output=80 tokens, …)`. The same run still passes every pre-existing stage (Working rhythm, thinking timers, collapse/expand clicks, tool run, provider failure, gutters, history window, exact 161-character copy).
- Layout check at 120/100/80 columns: `…/tools/pi-codex-appearance (main)   38.5 tok/s · ↑38.5k ↓2.0k · cache 97.3% · R112k W0 · $0.00`; single row at ≥100 columns, and at 80 columns the speed leads the wrapped right-side row rather than being dropped.
- `node --check scripts/pty-verify.mjs` and `git diff --check`: pass.

# Validation record — 0.9.10 (fullscreen scrollbar background leak)

Reproduced against Pi 0.85.1: with an automatic scrollbar hidden, both two-column gutters have the default background; a mouse wheel event reveals the scrollbar and colors the right gutter with the diff background. Hiding the scrollbar restores the gutter. The layout width stays correct. The host's `replaceScrollbarCell()` uses `sliceByColumn()` for the trailing segment, which can re-emit pending background ANSI after the reset at that segment's first column.

The margin wrapper previously stretched each `Spacer(1)` rect to the viewport height but only painted its first row. It now updates each Spacer's rendered row count from the current viewport height. Painting the right gutter after the scroll subtree isolates its cells from the leaked style. Copy serialization treats blank unmapped runs like blank unowned runs, so these painted gutters do not interrupt mapped soft line joins; unknown text still falls back to native extraction.

Verification:

- The new regression fails before the fix: the two rightmost cells have the diff's green background. It passes after the fix for both wheel directions, red/green rows, width/height changes, and scrollbar hiding, with the 5,000-row history window installed.
- `env -u NO_COLOR npm test`: 266/266 pass. The 33 margin, history-window and selection-copy tests also pass as a focused group, including exact CJK logical copy.
- `npm run check`, `npm run check:core`, and `git diff --check`: pass.
- `env -u NO_COLOR npm run test:pty`: real Pi tmux pass; selection copy remains exact (161 characters; exact=2, mixed=0, native=0).
- An independent 60-column, 12-row tmux probe checked captured ANSI cell backgrounds for initial, wheel-up, wheel-down, and hidden-scrollbar frames. Every frame retained 12 colored history rows with default backgrounds in both gutters. Local artifacts: `/tmp/pi-gutter-terminal-{initial,u,d,h}.ansi`.

# Validation record — 0.9.9 (bounded history and code simplification)

The fullscreen transcript retains at most 5,000 display rows, including page notices. Scrolling beyond a window edge loads the adjacent history and releases component render caches and copy mirrors at the opposite edge. Raw session records remain owned by Pi. Native start/end navigation crosses windows; incoming output preserves the old-history reading position, and an active selection pins the committed window until cleared.

Recovery and width changes assemble rows only until the window budget is filled. The host exposes whole-component `render()`, so a single oversized boundary component may still render in full once before its rows are sliced and its full cache is released. The retained-row bound is not a per-component CPU, byte, or time limit. Native transcript search covers the loaded window.

The cleanup shares tool row-cache construction, narrows renderer dependencies, removes unused state and APIs, merges identical event handlers, and caches usage totals until ledger changes. Test fixtures and overlapping cases were simplified while preserving behavioral assertions; the package source scan now checks subdirectories, and core TypeScript checks reject unused declarations.

Verification on Node 24.15.0 and Pi 0.85.1:

- `env -u NO_COLOR npm test`: 265/265 pass, including nine real-host history-window regressions.
- `npm run check` and `npm run check:core`: pass.
- `env -u NO_COLOR npm run test:host`: pass.
- `env -u NO_COLOR npm run test:pty`: real tmux pass for Working, thinking timers, expansion/collapse, bash output and failures, fullscreen gutters, history-window installation, and selection copy (161 characters; exact=2, mixed=0, native=0).
- `node --check scripts/preview.mjs` and `git diff --check`: pass.
- Release metadata check: package tests 4/4 pass; `npm pack --dry-run --ignore-scripts --json` includes `src/chrome/history-window.ts` and excludes the local `CODEX_STATE.md` index.

A local ledger microbenchmark with 20,000 confirmed requests and 1,000 warm totals reads measured 72.81 ms before caching and 0.10 ms after, with the same 200,000 input-token total. This measures only repeated ledger reads, not terminal frame time. Workspace verification logs are under `/tmp/pi-simplify2-{tests,focused,adapter,check,core,host,pty}.log`; regression tests do not require private sessions or model requests.

# Validation record — 0.9.8 (shell scroll performance)

The reported session `01a097ea-941e-75fc-9cc2-5230a858e5fe` contains 56 tool calls, including 42 bash calls with 237125 output characters; 14 results contain 12000 characters each. Replaying its recorded messages into real Pi 0.85.1 components exposed repeated rendering of completed, collapsed shell output on every scroll frame.

`CodexShellCallComponent` and `CodexShellResultComponent` now cache their row arrays by width, keeping the matching CopyProduct on the same array identity. The host creates fresh components on args/result/expanded updates and theme invalidation; explicit component invalidation also clears the cache. Cold renders still wrap the complete output before applying the visual row budget, preserving truncation counts and layout semantics.

The adapter publishes the actual self-shell rows and a MouseRegion wrapper publishes the exact forwarded child array. Container copy alignment now consumes those arrays without rendering these nodes again. Unknown component types retain the existing conservative fallback. Missing ownership markers on the older Markdown/Text/Box/Container wrappers were also restored so repeated setup cannot stack wrappers; non-extensible prototypes are skipped before mutation.

Measured on Node 24.15.0, 120 columns × 40 rows, 30 warmed SGR wheel frames (up/down), truecolor enabled and NO_COLOR unset:

| Condition | Mean ms/frame | p95 ms/frame | Calls per shell leaf per frame |
|---|---:|---:|---:|
| Baseline bbeaff8, isolated snapshot | 92.41 | 98.25 | 4 |
| Fixed workspace | 0.51 | 0.73 | 1 |

Both runs produced identical complete transcript rows, SHA256 `c1a1c6a487d496fb1d5c52ff8414ce1b8da96fb6b18f9bb69649424115c95995`. This is a CPU rendering replay with terminal writes stubbed, not a claim about end-to-end terminal FPS or Codex performance. It does not execute the saved commands or make model requests. Initial no-color measurements independently showed the same mechanism (about 85 ms to 0.31 ms per frame).

Verification:

- `npm test`: 258/258, including 14 chrome tests and four new real-host regressions in `test/shell-scroll.test.mjs` (wheel render counts/cache identity; width/invalidate/args/stream/expansion/theme/old frames; logical CJK copy through MouseRegion; repeated wrapper installation).
- `npm run check` and `npm run check:core`: pass.
- `env -u NO_COLOR npm run test:host`: pass. The first host run inherited `NO_COLOR=1` and failed its required truecolor diff-background assertion; running with its intended color environment passed without changing assertions.
- New shell-scroll tests also pass with `NO_COLOR` unset and `FORCE_COLOR=3`.
- `npm run test:pty`: real tmux PASS for live Working, thinking timers, mouse expand/collapse, tool result, failure summary, fullscreen gutters and selection copy (`exact=2 mixed=0 native=0`, 161 characters), using an isolated mock-provider installation.

The local replay probe and raw measurements are under `/tmp/pi-scroll-probe.mjs` and `/tmp/pi-scroll-{baseline,fixed}-truecolor.json`; committed regression tests use synthetic data and require no private session file. The 0.9.8 review also consolidated each shell cache into one width/rows state and removed the result component's duplicated input type and separate bullet field. Installation is verified separately after the reviewed commit is pushed.

# Validation record — 0.9.0 (logical selection copy)

## Scope

Fullscreen TUI 选区复制：Ctrl+C 复制已选显示内容的逻辑文本；软折行合并、真实换行保留、
decoration 排除、semantic 前缀按列包含；无选区原生行为不变。基线：插件 0.8.8 @ 4185395，
Pi 0.85.1（dev-dep 与运行宿主一致），pi-copy-soft-wrap 0.1.2 仍在用户环境加载。

## Root causes confirmed against host dist (0.85.1)

- `tui-alt-screen.js getActiveSelectionText`：逐行 `stripTerminalSequences(sliceByColumn(...)).trimEnd()`
  + `join("\n")` —— 软折行变真换行、行尾空白丢失（P01 属实）。
- `hasActiveSelection()` 复用同一序列化（P03 属实）；剪贴板通道为实例注入 `copySelection`。
- 软换行来源：Text/Markdown 外层 wrap + renderList（itemWidth）+ blockquote（width-2）三层；
  表格按 cell wrap（回退依据，P08-P11 属实）。
- `this.ui` 是 `createInteractiveTuiReference` Proxy —— 实例级属性赋值不可见，原型（经
  getPrototypeOf trap）是唯一接缝。
- TuiMainScreen（regular 模式）无选区 API —— 特性仅在 fullscreen 生效（保守正确）。

## Architecture (as implemented)

- `src/selection-copy/wrap.ts`：宿主 wrapTextWithAnsi 复刻（token 化/长词断行/ANSI tracker/
  OSC8 跨行携带），逐字形带 plain 偏移与 span kind；soft 断点记录被消费空白为 bridge。
- `src/selection-copy/markdown.ts`：Text/Markdown 原型包装。Markdown 镜像 = marked@18.0.5
  lexer（复刻 StrictStrikethrough + latex 扩展，parser.ts 带来源说明）+ renderToken 结构镜像
  （inline 层调宿主实例方法；表格/未知 token 调实例 renderToken 产精确行但标 unknown）；
  生成后与宿主真实行位置 diff，不一致即整块降级。Text/Box/Container 对齐链同理由
  mouseLayout 高度校验兜底。
- `src/selection-copy/serialize.ts`：布局遍历（compositor 语义，后画者胜），内容空间行经
  content-box anchor 换算子树行；span 交插提取 + native 混合回退 + soft/hard/gap 连接规则。
- `src/selection-copy/controller.ts`：原型安装（owner symbol 幂等）+ 编辑器 Ctrl+C 分流
  （选区存在即消费；有内容复制、纯装饰只消费；无选区原生；有界 in-flight）。
- 自有 renderer：shell.ts/diff.ts/write-preview.ts 以 `copyOut` 出参在行构建点同步产
  CopyRow；rail/容器 product 以子链（colShift）组合。

## Checks actually executed

- `npm test`：217/217（含 selection-copy 8 项：differential 语料×4 宽度 0 降级、Text 镜像、
  Box>Markdown 用户消息路径、真实 TuiAltScreen 真实 SGR 按下/拖动/释放 → 精确 CJK 逻辑行、
  Ctrl+C 消费+复制+草稿保持+无选区原生对照、纯装饰选区空串+遥测 empty-decoration、外部
  原型 wrapper 检测与绕过、种子 property round-trip 24 语料×3 宽度）。
- `npm run check` / `check:core`：tsc 干净。`test:host`、`test:chrome`：PASS（无回归）。
- `npm run test:pty`（真实 pi fullscreen + mock provider，零真实额度）：真实 SGR 鼠标序列经
  tmux 注入 → Ctrl+C → 屏幕出现 `Copied!` flash；`/codex-ui` 遥测
  `calls=2 exact=2 native=0`，`chars=164` 与 mock 回复长度精确相等；应用存活、草稿未被清空。
- `npm pack --dry-run --ignore-scripts`：包内容 0.9.0 正常。

## Performance (scripts/copy-perf.mjs, WSL2, node 24)

- 热（缓存命中）帧：1k 行 0.16ms / 10k 行 0.78ms —— 远低于 32ms 动画帧预算；对齐 pass 只在
  容器渲染时运行，叶子组件命中宿主内部缓存。
- 复制：屏幕级（20–40 行）0.1–1.7ms；10k 行全选 63ms（17µs/行，随选区规模线性；仅复制时
  付出，渲染路径零分摊）。

## Coverage table (component × mode)

| 组件 | 模式 |
|---|---|
| assistant Markdown 段落/标题/列表/引用/代码围栏（highlight 行数一致）| exact |
| inline（bold/em/codespan/link/del/br）| exact（只复制显示文本，无隐藏 URL）|
| user message（Box > Markdown）| exact |
| thinking 展开正文（经 CodexThinkingRail，rail=decoration 链）| exact |
| 宿主 Text（隐藏 thinking 标签/状态行/提示）| exact |
| 自有 shell call（bullet/title=decoration，命令=content，`  │ ` gutter=decoration）| exact |
| 自有 shell result（`  └ `/`    ` 前缀=decoration，输出=content，省略行=semantic+gap）| exact/gap |
| 自有 diff（行号/gutter=decoration，+/−/context=semantic，正文=content，分隔=semantic+gap）| exact/gap |
| 自有 write preview（行号/stage=decoration，正文=content，elision=semantic+gap）| exact/gap |
| Markdown 表格 / 未知 block token / 图片行 | native-fallback（unknown 行，硬边界隔离）|
| highlight 行数漂移的代码块 | native-fallback |
| Spacer / 结构空行 | native（空行，作为换行边界）|
| regular（非 fullscreen）模式 | 特性关闭（无 TUI 选区）|

## Deviations & limits

- 表格未做单元格级映射（§4.5 允许的 v1 回退）；"宽度不同结果相同"性质不适用于表格。
- 跨 resize 的选区按当前帧坐标解析；无法安全重投影的行按原生提取（未实现选区重投影/清空提示）。
- 差异化 wrapped-code 断点空格：diff/write 的软断点 bridge 未记录（被 trimEnd 消费的源空格
  在跨行 join 时可能丢失一个空格）；Markdown/wrap 模块路径已精确处理。已记录为后续项。
- 未实现：macOS/SSH 平台手动剪贴板实测（本机 WSL2 手动 Ctrl+C→粘贴由用户确认）；PTY 断言以
  /codex-ui 遥测与 flash 为准，不读用户剪贴板。

# Validation record — 0.8.8 (leisurely sweep, smooth intensity)

User feedback on 0.8.7: "animation too fast — I want high frame rate, not a
fast sweep." The comet head now travels 0.25 cells per frame (128ms/cell,
matching the 0.8.6 pace) while the gradient intensity interpolates every
frame across an 8-level ramp — per-frame trace shows the head holding ~4
frames per cell with the trail shades flowing through intermediate colors
(◒ ◔ ◕) between the base levels.

`npm test` 209/209 · `check` clean.

---

# Validation record — 0.8.7 (gradient comet, 32ms shimmer)

- Pure trace (component with tagged shades): head ▲ leads, trail ◆●○· fades
  behind, full sweep 12 frames + 6-frame pause, clean re-entry — no overlap.
- Real TUI (truecolor tmux, mock provider): 40 samples at ~35ms → 7 distinct
  Working-line states; `/codex-ui` reports `animation=on @32ms`.
- Frame cost unchanged (~0.003 ms) — 32ms budget has ~1000× headroom.

`npm test` 208/208 · `check` clean.

---

# Validation record — 0.8.6 (Working shimmer overlap)

Real-use video (WARP terminal, truecolor): the shimmer's second wave started
while the first was still mid-word. Root cause: `frame % 12` highlight
position inside a `frame % 16` cycle — the outer wrap cut sweeps short and
restarted them mid-word.

Fix verified two ways:

1. **Timeline unit test**: walks two full cycles and asserts the lit window
   never moves backwards mid-wave and only re-enters at the cycle boundary;
   each position is held exactly 2 frames (render-coalescing smoothing).
2. **Real wiring trace** (extension activation + tagged theme tones, real
   timer): frames advance `W→o→r→k→i→n→g` monotonically, positions held,
   bullet cycling independently — no mid-word restarts.

`npm test` 208/208 · `check` clean.

---

# Validation record — 0.8.5 (composer surface, Working rhythm, metadata split, codex quota)

Method: unit suites + `host-smoke` (real Pi component assembly) +
`pty-verify` (real `pi` in a real tmux PTY against a local mock
OpenAI-compatible provider, screen-frame assertions) + a one-shot read-only
probe against the REAL logged-in `codex app-server` (codex-cli 0.154.0).
The protocol shape (`rateLimits.primary {usedPercent, windowDurationMins,
resetsAt}` camelCase) was verified against the real binary before
implementation; the reference repo (narumiruna/pi-extensions) was used for
the framing only.

Real-screen frames (tmux capture, HOME-isolated so the published copy cannot
shadow the code under test):

```text
===== IDLE =====
>  Ask anything...
pcx-mock-model · high · pcx-mock          ctx 0/1.0M · 0%
/tmp/pcx-vis-…/ws                                   ↑0

===== MID-THINKING =====
▏  嗯
• Working (0s · thinking 0s · esc to interrupt)
>  Ask anything...
pcx-mock-model · high · pcx-mock          ctx 4/1.0M · 0%
```

- The purple full-width border is gone (no `─` border rows remain around the
  composer); the surface bg paints every row including padding and right fill.
- The `> ` prefix borrows the two padding cells — the host re-applies its own
  `paddingX` (1) after install, which the subclass clamps to ≥2; cursor
  geometry is unchanged (verified by the real-component tests and the
  hardware cursor position in the PTY frames).
- Metadata/footer split verified in the real TUI: the footer carries
  cwd/session only — no model/context duplication.
- Working line: Codex grammar with dual timers; shimmer frames differ in ANSI
  while the stripped text stays identical (unit-tested with a fake scheduler;
  0.003 ms/frame measured against the 64 ms budget).
- Quota: real app-server read returned `planType=pro`, primary
  `used 96% → remaining 4%` (window 10080min → rendered "Codex week 4%"),
  credits `hasCredits=false`. No raw response, token or credential stored.

Performance (spec 20): animation frame 0.003 ms; 30k-char write-preview
frame 0.22 ms; 2000 animation frames leave no state growth; quota refresh is
event/interval-driven and never runs in render.

Not verified: real window mouse interaction on the surface editor beyond the
host's own hit tests (geometry unchanged by construction + unit tests),
per-provider reasoning-token display splits.

`npm test` 207/207 · `check`/`check:core` clean · `test:host` PASS ·
`test:pty` PASS (5 stages) · real codex app-server integration OK.

---

# Validation record — 0.8.4 (footer details, Working widget, runtime outcomes)

Method: unit suites on REAL host data shapes + `host-smoke` (real Pi
component assembly) + `pty-verify` (the real `pi` binary in a real tmux PTY,
driven by a local mock OpenAI-compatible provider — zero paid requests;
screen frames asserted with `tmux capture-pane`, not raw byte-stream
greping). The PTY run uses HOME isolation so the published 0.8.3 copy in the
user's `~/.pi/agent` cannot shadow the code under test.

| Stage | Frame evidence (real TUI) |
| --- | --- |
| Idle footer | `pcx-mock-model · high · pcx-mock    ctx 0/1.0M · 0%` + `…/workspace    Σ↑0 · R0 W0` — model/effort/provider/capacity all from real host fields (0.8.3 showed a bare directory here because it read nonexistent `label/percentUsed`) |
| Live Working | `✦ Working… · … · Ns · ↑…` above the editor mid-stream; elapsed + token preview grow; editor border carries no second Working; native loader row hidden only after widget install |
| Thinking | `thinking Ns` grows while the mock streams `reasoning_content`; after the run the summary shows `thought for Ns` (same interaction-scope ledger) |
| Tool run | mock tool call → real `bash` executed (`PCX_TOOL_MARK` in output) → summary still `Worked for …` (a mid-run tool error no longer brands the run Failed — covered separately by the outcome unit suite: error→retry→stop = Worked, error→settle = Failed, abort = Interrupted, length = Ended·output limit, no evidence = Ended) |
| Provider error | forced HTTP 500 → summary `Failed after …` (real terminal evidence) |
| Footer after runs | `ctx 1.3k/1.0M · 0.1%` + `Σ↑200 ↓80 · cache(last) 83.3% · R1.0k W0 · $0.00` — Pi normalizes usage (input = uncached prompt tokens, 1200−1000 cached = 200; cacheRead = 1000 → 1000/1200 = 83.3%) |

Not verified (environment limits): real window mouse clicks, IME input,
paid-provider-specific reasoning splits. Unknown values render `—`
(verified in unit tests for null/NaN/negative/missing usage).

`npm test` 193/193 · `check`/`check:core` clean · `test:host` PASS (needs
`COLORTERM=truecolor` on hosts whose palette resolves to 256-color for the
diff-surface assertions — an environment property, not a code regression;
it fails identically on the 0.8.3 tree) · `test:pty` PASS (5 stages).

---

# Validation record — 0.8.3 (write title fixes)

Two real-use screenshot findings, both reproduced in the real host
component before fixing:

| Finding | Root cause | Fix | Verified |
| --- | --- | --- | --- |
| Completed write showed a bare lowercase `write` with no bullet/path | `component()` reuse helper called `setText` on the 0.8.1 write-call composite (no such method) → TypeError → host catch → `createCallFallback()` | reuse only components implementing `setText` | final frame now `• Wrote <path>` + `└` result rows — identical shape to `• Ran` |
| Streaming write header showed `• Writing .` (path not yet streamed) | content-first provider: `path` arrives after `content`; old `path()` fallback was `"."` | explicit dim `(path pending…)` placeholder; header re-renders with the real path when the frame lands | frame sequence: `• Writing (path pending…)` → `• Writing …/raw_body_draft.md` → `• Wrote …/raw_body_draft.md` |

`npm test` 148/148 · `test:chrome` 7/7 · `check` clean · `test:host` PASS.

---

# Validation record — 0.8.2 (crash hotfix)

Real-use crash captured by the user's `pi-capture` wrapper: every session
that streamed write arguments died within ~3 minutes with
`TypeError: Cannot read properties of undefined (reading 'visibleWidth')`
at `write-preview.ts:129` via `CodexWriteCallComponent.render` — the host
process exited through `uncaughtException` while tearing down the
alt-screen, so the terminal showed nothing.

Root cause: the renderers' `lastComponent` reuse path builds a PARTIAL
input (it cannot know component-owned `layout`/`maxRows`);
`CodexWriteCallComponent.update()` replaced `#input` wholesale, dropping
`layout` for every frame after the first.

Fix + verification:

| Check | Result |
| --- | --- |
| `update()` merge semantics (partial input merged, component-owned fields kept) | applied |
| `renderWritePreview` defensive layout fallback (never kill the host) | applied |
| Regression test `write-stream-crash.test.mts` (real `ToolExecutionComponent.updateArgs` → `render` ×4) | pass; verified to reproduce the crash against the broken `update()` |
| `npm test` | 148/148 |
| `npm run test:chrome` | 7/7 |
| `npm run check` | clean |
| `npm run test:host` | PASS |

---

# Validation record — 0.8.1

## Scope

Version 0.8.1 is a fix round on the 0.8.0 standalone UI owner: structured
Writing header + streaming smoothness, document-edit diff surface, and real
thinking expansion. Display-only boundary unchanged (no tool/model/session
mutation; the UI-only CustomEntry summary exception stays as granted).
Executed in `/home/xu/project/tools/pi-codex-appearance`, Node v24.15.0,
Pi core/TUI 0.85.1.

Baseline: remote main `c3486a0815f0af6b4df2872ca5bb7fd5a555fab7` (0.8.0),
verified equal to local HEAD and to the live clone
`~/.pi/agent/git/github.com/Rycen7822/pi-codex-appearance` before any change.
No uncommitted user changes existed; nothing was reset or overwritten.

## Root causes confirmed against the baseline blob

1. **Writing title bypassed** — `src/renderers.ts` write branch early-returned
   `makeWritePreview(...)` whenever a non-empty `contentPrefix` existed; the
   preview component rendered stage + body but never the `• Writing <path>`
   title. Present unchanged since 0.7.0.
2. **Preview tail freeze** — `src/write-preview.ts` budgeted by LOGICAL lines
   and `slice(0, MAX)`d the wrapped result last: an early long logical line
   consumed the whole budget and every later frame dropped the newest content.
   Additionally the per-frame work was O(prefix) with no reuse.
3. **Phase from accumulated content** — `src/extension.ts` `message_update`
   derived the phase via `content.some(thinking)` on the WHOLE message: stale
   thinking blocks kept "Thinking" lit while write arguments streamed.
   `metrics.writeStreaming()` only fired at `tool_execution_start`.
4. **Expanded Markdown overwritten with a label** — the adapter's
   `isCollapsedLabel = typeof text === "string" && !markdown` is always true
   for the host's Markdown instances (they have `text`, no `markdown` field),
   so the 0.8.0 "collapsed enrichment" `setText("Thought for …")` hit EXPANDED
   thinking bodies. With the host's `hideThinkingBlock` default (`false`),
   thinking was ALREADY expanded — our injection actively broke it.
5. **Document edits routed to the native self-shell** — the builtin edit tool
   sets `renderShell: "self"`; the adapter backed off on ANY self-shell, so
   `.md` edits rendered the native pre-execution preview without the
   full-row add/remove backgrounds. The structured diff renderer and its
   `details.diff` parser already existed for write/edit results.
6. **semanticRuns continuity** — `if (!kind) continue` meant toolCall (and,
   before this round, empty text) blocks did not break a thinking run, unlike
   the host rebuild loop (break on first non-thinking block).

## Checks actually executed

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | 147/147 pass | +2 thinking-body persistence, +1 barrier run, +1 diff surface, +1 stale-thinking phase, updated self-shell routing test |
| `npm run test:chrome` | 7/7 pass | chrome modules incl. import rule, factory contract |
| `npm run check` (tsc) | clean | strict, whole project |
| `npm run test:host` | PASS | real Pi assembly + `/codex-ui` (now asserts `0.8.1 diagnostics:` AND `config: thinking=full/full`) |
| self-shell routing | pass | exact-builtin self-shell taken over; third-party/unknown sourceInfo self-shell still backs off (regression tested) |
| diff surface | pass | context rows plain; add rows `#213A2B` line bg; remove rows `#4A221D` + dim overlay; BLANK added row keeps full-row bg incl. right padding; every styled row closed by `\x1b[49m` |
| thinking body persistence | pass | body Markdown present after `thinking_end` + `message_end`, survives re-coordination; no `Thought for` label anywhere |
| run splitting | pass | `thinking / empty text / thinking` → 2 rails; `thinking / toolCall / thinking` → 2 rails (barrier run) |
| stale-thinking phase | pass | `thinkingEnd` idempotent + `writeStreaming` → phase `writing`, thinkingMs not extended; later text → `working` |
| config wiring | pass | `thinking.streaming/completed/rail`, `writePreview.enabled/rows` consumed by the production component (`rows`=body budget, `enabled:false`/`rows:0` keeps header, drops body); `/codex-ui` shows effective values |

## Streaming performance + visibility (same machine, same fixture)

Fixture: 1800-char logical lines interleaved with short lines (the freeze
scenario), 20 streaming frames per size, wrap/width via the real TUI ops.

| Prefix size | OLD 0.8.0 ms/frame | OLD newest-tail visible | NEW 0.8.1 ms/frame | NEW newest-tail visible |
| --- | --- | --- | --- | --- |
| 16 KiB | 0.22 | yes | 0.03 | yes |
| 128 KiB | 0.16 | **no (frozen)** | 0.10 | yes |
| 1 MiB | 0.90 | **no (frozen)** | 0.73 | yes |

p50 over 3 rounds at 128 KiB / 1 MiB: OLD 0.05 / 0.34 ms, NEW 0.06 / 0.35 ms
— no wall-clock regression; the fix is VISIBILITY (the 0.8.0 build silently
dropped the newest content from every frame once a long line was in budget).
No absolute wall-clock assertions in CI; per-frame cost stays far below any
frame cadence.

## Real-process verification

- `npm run test:host` runs against the REAL installed
  `@earendil-works/pi-coding-agent` (0.85.1 dist) and real pi-tui through
  `index.ts`'s default export — component-level behavior above is not faked.
- PTY-driven real `pi` TUI (user's own extension stack), HEAD `ae09669`:
  fresh start frame shows the `Pi 0.85.1 · codex-appearance 0.8.1` header and
  native footer; `/codex-ui` reports `0.8.1 diagnostics:`, chrome applied,
  transcript applied, `decorations: group-spacing=applied, separator=applied,
  thinking-rail=applied`, clock idle (timers=0), and
  `config: thinking=full/full rail=on writePreview=8 rows` — no crashes,
  no appearance warnings.
- `pi -p` print-mode smoke: extension loads without errors (chrome/`/codex-ui`
  are TUI-only by design; pre-existing third-party `pi-context-view` command
  error is unrelated to this package).

## Deviations & limits

- The `collapsed` value of `thinking.streaming/completed` remains ACCEPTED
  config for compatibility, but this release implements no automatic
  collapse-to-label (that mechanism was the 0.8.0 defect). If you set
  `collapsed`, the host's own toggle (`Ctrl+T` / click) still applies; we do
  not auto-collapse on your behalf. Defaults and the documented behavior are
  `full/full`.
- Zentui registry probe REMOVED (package uninstalled by the user). Unknown
  third-party rail owners still back off through the adapter's
  ownsMethods/sourceInfo checks — nothing blanket-overridden.
- The native edit self-shell takeover is gated on the EXACT builtin source
  (`source === "builtin"` AND `path === "<builtin:edit>"`). A third-party
  tool overriding edit with a self-shell keeps its renderer.

## 0.9.1 — review round

Scope: post-0.9.0 code review + simplification. No new surfaces; every change
is a correctness fix, robustness fix, or dead-code/comment cleanup inside the
0.9.0 feature.

### Defects found and fixed

- **P1 shell-call copy leaked ANSI** (src/shell.ts): command content spans
  stored syntax-highlighted text; the serializer slices span text per
  grapheme and copies it verbatim, so colored terminals pasted escape bytes
  with broken offsets. All own-renderer span texts are now stripped at
  construction (diff/write/shell-result were verified clean already).
- **P2 serialize-failure fallback used wrong source** (controller.ts): the
  catch path re-derived rows from `previousScreen` (screen space) even for
  scrollView selections (content space). Now reuses the already-computed
  `sourceLines`; empty fallback maps to `undefined` like stock.
- **P2 empty extraction returned ""** (controller.ts): stock maps empty to
  `undefined`; "" flipped `hasActiveSelection()` for single-row
  decoration-only selections and diverged host Esc/clipboard routing.
  Ctrl+C consumption is unchanged (the editor hook keys off
  `getSelectionBounds`, not the text).
- **P2 streaming tail forced "hard" on every kept row** (shell.ts isPartial,
  write-preview collapsed): only the window's FIRST row lost its
  predecessor; the all-hard override re-introduced per-visual-row newlines.
  Also hardened the row newly exposed by the elision-hint splice.
- **P1.5 pre-existing `shorten` bug** (surfaced by the new tests): the cap
  guard compared RAW length (ANSI included) against a VISIBLE-char budget, so
  fully-rendered colored commands grew a spurious " …". Guard now uses
  `stripAnsi(line).length`.
- **P3 batch**: mirror cache hit registers the product for the fresh array
  (identity-keyed resolution); thinking-rail pass-through rows (already
  carrying `▏`/`| `) shift by 0, not railCells; queued Ctrl+C drains the
  CURRENT selection, not the first snapshot; `/codex-ui` copy-stats gained
  `cache=hits/misses` (spec item); `wrapPrototypes` returns the real
  all-wrapped result.

### Cleanup (simplifier)

Dead exports removed (`rowsFromProvenance`, `buildCellTable`,
`resetCacheStats`, `ResolvedRow`, `unknownRows`, `visibleOfStyled`,
write-only `wide` field, unused `clipboardExecutor`); identity
`stripOwnPrefix` deleted; duplicated `stripAnsiShell` merged into the
existing `stripAnsi`; Box/Container and Markdown/Text prototype wrappers
consolidated into parameterized helpers; history-narrative comments dropped,
host-semantics/constraint comments kept. Net -111 lines vs 0.9.0.

### Checks executed

- `npm test` 222/222 (adds test/copy-provenance.test.mjs: 5 regressions —
  shell span ANSI-free under truecolor highlighting incl. a wrapping long
  command, header-only strip, streaming-tail and collapsed-window join
  semantics).
- `npm run check` (tsc, both configs) clean; `test:host` PASS;
  `test:chrome` 14/14; `npm pack --dry-run` OK.
- `test:pty` real-tmux run: SGR mouse drag + single Ctrl+C → telemetry
  `exact=2 mixed=0 native=0`, 161 chars matching the mock reply; app alive,
  draft preserved.

## 0.9.2 — user-message surface + auto-collapse thinking with duration

### Root causes addressed

1. User messages were plain because `userMessageBg` was "" in the theme. The
   native `UserMessageComponent` already paints its Markdown inside a
   `theme.bg("userMessageBg", …)` Box — the fix is theme-only
   (`userMessageSurface: #292929` var wired to `userMessageBg`);
   `UserMessageComponent` is NOT patched, user text is never touched.
2. Auto-collapse was absent by the deliberate 0.8.1 policy. 0.9.2 restores it
   through the HOST's own `thinkingVisibilityOverrides` — never by mutating an
   expanded Markdown body.
3. The old 0.8.0 auto-label implementation was unsafe because it could call
   `setText` on an expanded Markdown. There is still NO path that writes into
   a Markdown body; the collapsed side only swaps the host's OWN label Text
   inside its native MouseRegion (tagged, and step 1 of every coordination
   pass restores the original so a later pass re-decides from the native node).

### Implementation

- `themes/codex-appearance.json`: `userMessageSurface` var + `userMessageBg`
  wiring (theme-only Part A).
- `src/transcript-state.ts`: per-run `ThinkingRunPlan` clocks (host-parity
  `renderedThinkingRuns`: consecutive thinking blocks = one run, any
  non-thinking block breaks it, all-empty runs consume no runIndex); start
  recorded once at first non-empty text, end at the first boundary or
  message_end; `thinkingRunPlan(s)` query API; `TranscriptState` takes an
  injectable clock for deterministic tests; `TextRunPlan` is separator-only
  now (single timing source); sealed plans are fingerprint-indexed
  (normalized content + stopReason) so the host's message-CLONE re-render of
  finalized transcripts reuses the real clocks.
- `src/transcript-adapter.ts`: the assistant decoration layer now applies the
  thinking visibility policy around `updateContent` — host rebuild first, then
  AT MOST ONE extra captured-`original` rebuild only when the override map
  actually changed; streaming policy fires once per run when it first renders
  ACTIVE; completion policy fires once on active→ended; `completed=full` only
  forces a run open when an override entry already exists (never fights
  Ctrl+T's map-clearing global hide); collapsed labels of ENDED runs swap to
  duration summaries inside the native MouseRegion; `thinkingAutoApplied()`
  count + `thinking-policy` feature surfaced for diagnostics.
- `src/thinking-summary.ts` + `index.ts`: `Thought for Xs` / `Thought` label
  (same formatDuration convention as the Working line), painted italic +
  active-theme `thinkingText` via `getResolvedThemeColors` (deep theme imports
  are exports-blocked), built as a real `Tui.Text` so the 0.9.1 selection-copy
  mirror covers it; `isCollapsedLabel` guard is `instanceof Tui.Text`.
- `src/config.ts`: `thinking.completed` default `collapsed`.
- `/codex-ui`: `thinking: policy=…/… autoVisibility=N` line.

### Key host facts verified (pi 0.85.1 dist)

- `_handleAgentEvent` emits extension events BEFORE session subscribers, but
  the host's FIRST `updateContent` for a message can still precede our apply
  of that update (observed for message_start with content already present) —
  hence resolution anchors by the message OBJECT first (anchored at
  message_start), heuristics second, and the finalized-clone re-render is
  covered by the sealed-plan fingerprint.
- The host re-renders a finalized message through a CLONED message object
  (~1.7 s after message_end in the PTY run) — the clone has no object anchor;
  fingerprint reuse keeps the duration honest.
- Click toggling in the fullscreen transcript goes through the selection
  gesture's same-point release → synthesized click → layout dispatch →
  MouseRegion (verified live in the PTY).

### Tests (238 unit / 14 chrome / host smoke / PTY)

- `test/transcript.test.mts`: the fake assistant component now mirrors the
  FULL host rebuild semantics (override map, hideThinkingBlock, host run
  grouping, click rebuild); policy matrix: A live full→auto-collapse ONCE
  (+1 rebuild exactly on the transition, duration 7s), manual collapse during
  streaming kept + completion only adds the duration, E Ctrl+T show/hide never
  fought (incl. `full/full` never forces open under global hide), F two runs
  independent clocks/durations/visibility, streaming=collapsed once, history
  rebuild → `Thought` (never fabricated 0s) with click restoring the verbatim
  body, aborted messages keep the duration, plain text never becomes a
  summary; per-run plan clocks (start once, boundary close, message_end tail,
  no timing without evidence); `renderedThinkingRuns` host-parity table.
- `test/host-surface.test.mjs` (new, production path): REAL
  `UserMessageComponent` paints the #292929 surface on every wrapped row with
  per-row bg reset (theme activated through the host's own loader via
  `PI_CODING_AGENT_DIR` custom themes); REAL `AssistantMessageComponent`
  prototype: auto-collapse once through the HOST override map, duration label
  inside the native MouseRegion, native click expand/collapse with the
  sentinel body verbatim, Ctrl+T respected, history clone → `Thought`.
- `test/selection-copy.test.mjs`: user-message card copies IDENTICALLY at
  60/80/120 columns with the #292929 background rendered and ZERO ANSI in the
  copied text; collapsed label copies exactly `Thought for 13s` (hidden
  reasoning is not rendered anywhere, so it cannot leak).
- `test/package.test.mjs`: theme contract for the surface slot.
- `scripts/host-smoke.mjs`: section 11 drives the REAL prototype through the
  extension's own event handlers — expand→collapse→click→Ctrl+T ordering plus
  the user-surface assertion; diagnostics now assert
  `thinking=full/collapsed` and the autoVisibility counter.
- `scripts/pty-verify.mjs`: stage 2b now verifies on a REAL tmux TUI: the
  transcript shows `Thought for Ns` (per-run duration), the reasoning body is
  hidden while collapsed, a REAL SGR mouse click re-expands it, another click
  re-collapses (click attempts re-locate the row from a fresh capture and
  sweep ±1 rows because the region hit rows sit off the capture rows; misses
  are no-ops so sweeping never double-toggles).

### Checks executed

- `npm test` 238/238; `test:chrome` 14/14; `check` + `check:core` clean;
  `test:host` PASS; `preview` OK; `npm pack --dry-run` OK.
- `test:pty` real-tmux PASS: idle footer, dual timers, `Thought for Ns`
  auto-collapse + click expand/collapse, tool run, provider error, and the
  0.9.1 selection-copy regression (`exact=2 mixed=0 native=0`, 161 chars).

### Limitations

- Restored-history thinking shows `Thought` (no duration): UI-only timing is
  not persisted, and fabricating one is forbidden. Live-session durations are
  exact.
- If the host's message_start ever stops carrying content (or its clone
  re-render changes shape), resolution degrades to the timing-less sealed
  plan: collapse still works, labels fall back to `Thought` — never crashes.
- With `streaming=full`, a NEW thinking run becomes visible while streaming
  even if the user's global Ctrl+T hide is active (spec 4.3/4.6: new runs get
  the current automatic defaults); it auto-collapses on completion.

## 0.9.3 — render-performance round (evidence-driven)

### Findings (measured with real host components, pi-tui 0.85.1, node 24, WSL2)

1. **Selection-copy mirror rebuilt on every streaming frame.** Markdown/Text
   prototype wrappers re-ran the full mirror pipeline (lexer → token mirror →
   provenance wrap → positional verify) on every cache miss; streaming text
   changes every frame. Measured at 40KB markdown: host render 7.5ms → wrapped
   50ms per frame (+566%); 30KB Text: 0.22ms → 8.5ms. Sub-cost profile: host
   lexer re-run 1.4ms, token mirror ~5ms, provenance wrap ~16ms, per-row verify
   ~19ms.
2. **Container/Box alignment re-rendered every child per frame.** The
   alignment pass called `child.render()` again per child to obtain row arrays;
   nested containers compounded this to 2^depth leaf renders per frame
   (measured 24 → 192 leaf renders on a 12-message tree, depth 3). A 150-message
   transcript (7050 rows): 0.115ms → 1.18ms per frame (+930%), plus a
   transcript-length placements allocation per container per frame.
3. Negligible and deliberately unchanged: the assistant decoration layer
   (0.002ms per updateContent; 400-delta stream = 2.9ms total) and the
   adapter's per-render `getAllTools()` (~0.03µs per call).

### Fixes

- **Streaming throttle** (`markdown.ts` `wrapRenderPrototype`): while a
  component's text keeps changing at an unchanged width, the mirror rebuilds at
  most once per 200ms (`MIRROR_REBUILD_INTERVAL_MS`). First render, width
  changes and any render where the text has STOPPED changing all build
  immediately, so a stream's settled frame always gets a product on its next
  render. Skipped frames publish no product → a copy taken from exactly that
  frame uses native extraction (degrade, never corrupt). Failed builds count as
  attempts, so a permanently-degrading component stops retrying per frame too.
  Clock is injectable (`WrapDeps.now`) for deterministic tests.
- **Constant factor** (`wrap.ts`): pure-ASCII runs skip `Intl.Segmenter` and
  per-grapheme `visibleWidth` (printable ASCII is provably one cell, one
  grapheme, never a CJK breakpoint — token output identical to the slow path).
  Verify fast path (`markdown.ts` `hostRowInner`): stripAnsi + char-cut of the
  known left margin replaces column-aware `sliceByColumn` +
  `stripTerminalSequences`; non-conforming rows fall back to the slow slice.
  Single 40KB mirror build: ~41ms → ~13ms.
- **Container/Box alignment without re-rendering** (`model.ts` `LAST_ROWS` +
  `structure.ts`): every wrapped render prototype publishes the row array it
  just returned to an instance slot; alignment resolves child products by that
  array identity — the slot always holds the CURRENT pass's array, so a stale
  product can never attach to new rows. Only children of unwrapped component
  types (e.g. MouseRegion) are still re-rendered, purely to verify height.
  The placements table is allocated only when at least one child product
  resolves (an all-undefined table is the same native outcome with no
  allocation).
- **Minor**: spacer-prototype probe in the assistant decoration layer is cached
  per session instead of one allocation per updateContent; `/codex-ui` mirror
  diagnostics gained a `throttled` counter.

### Measured results (same harness, after)

- Mirror build: 40KB markdown 50.4ms → 20.3ms wrapped (host alone 7.5ms);
  10KB 13.9ms → 6.2ms.
- Streaming simulation (40KB over 300 frames at 16ms spacing): 300 builds →
  24 builds (276 throttled) — mirror CPU during streaming cut ~12×.
- Full 150-message transcript per frame: 1.18ms → 0.119ms (bare host:
  0.112ms) — the per-frame container overhead is effectively eliminated.

### Checks executed

- `npm test` 242/242 (adds: throttle lifecycle — build/throttle/stable-
  rebuild/interval-expiry/width-change; container alignment performs no child
  re-renders and still resolves placements; unwrapped-child fallback alignment;
  all pre-existing differential/parity suites unchanged and green).
- `npm run check` + `check:core` clean; `test:chrome` 14/14; `test:host` PASS.
- `test:pty` real-tmux PASS — including the selection-copy regression:
  SGR drag + Ctrl+C → `exact=2 mixed=0 native=0`, 161 chars, so the throttle
  and LAST_ROWS resolution did not change copy outcomes on settled frames.

### Trade-offs (accepted)

- A copy taken from a frame whose component was mid-throttle (text actively
  changing within the last 200ms) uses native extraction: correct text, but
  soft-wrap joins and decoration exclusion are the host's native semantics for
  that copy. The settled frame that follows always carries a full product.

## 0.9.4 — fullscreen side gutters (Codex-style margins), plugin-only

### Requirement

Fullscreen mode should inset the whole UI with symmetric blank side columns
(like Codex / like Pi's own regular mode), instead of running content flush
against both screen edges — without giving up any fullscreen interaction
(mouse click-to-expand, wheel scroll, scrollbar, selection copy). No host
changes allowed.

### Host facts verified (pi 0.85.1 dist, pi-tui)

- Fullscreen layout: `createChatViewport` builds `VStack[ScrollView(document),
  dock(editor/widgets/footer)]` and hands it to `TuiAltScreen.setLayoutRoot`;
  `renderLayoutFrame` (layout.js) computes every component's rect `{x,y,w,h}`
  recursively — horizontal offsets propagate to all descendants.
- Mouse dispatch (`dispatchMouseToLayout`) hit-tests screen coordinates
  against frame rects (`getLayoutBoxesAt`) and translates to per-box local
  coordinates, so correctly-offset rects keep clicks correct automatically.
- The extension's captured `tui` is the `createInteractiveTuiReference` Proxy:
  get/set/getPrototypeOf all forward to the live renderer; the renderer may be
  the main screen (`mode === "regular"`) at first capture, and is swapped on
  mode changes → install must retry and must be prototype-level (the same seam
  the selection-copy mirrors already use).
- `HStack`/`VStack`/`Spacer` are public pi-tui exports; stack entries support
  `{basis, grow, shrink, minSize, visible(viewport)}`, and `visible` is
  re-evaluated by the layout engine every frame (used for the narrow-terminal
  fallback).
- The host's own padding settings do not cover this: `outputPad` is 0/1
  left-only transcript padding, `editorPaddingX` caps at 3 and is editor-only.

### Implementation

- `src/chrome/fullscreen-margin.ts`: wraps the fullscreen renderer PROTOTYPE's
  `setLayoutRoot` (owner-symbol idempotent, foreign wrappers compose), and
  wraps every root in `HStack[Spacer(basis=m, grow=0) | root(grow=1) |
  Spacer(basis=m)]`. A root mounted before install is re-dispatched through
  the wrapped setter (retroactive wrap); dispose restores the prototype method
  and unwraps a live root. Only renderers with `mode === "fullscreen"` are
  touched; regular mode is deliberately untouched (the terminal emulator owns
  the mouse there — native drag-select copy must keep working).
- Config: `fullscreen.marginX` (0..8, default 2; 0 disables),
  `fullscreen.minWidth` (40..400, default 72) — below the threshold the gutter
  spacers' `visible` callback hides them and content keeps full width.
- `/codex-ui` gained a `fullscreen-margin` status line.

### Selection-copy serializer fixes (0.9.0-semantics strengthenings uncovered by the gutter frame)

1. **Content-space x anchor.** Scroll-view selections use content-space rows
   AND columns, and the serializer already translated rows by the content
   box's `rect.y` but implicitly assumed content `x = 0` (true before the
   gutters). The anchor now carries both axes: ownership fill translates the
   clip range by `anchor.x`, and span origins subtract it. Pre-gutter behavior
   (`x = 0`) is numerically unchanged. Symptom before the fix: every copied
   row was shifted — duplicated first cell, lost wrap-boundary cells, mixed
   mode (reproduced with margin + ScrollView, no scrollbar needed).
2. **Blank unowned cells are neutral.** Columns no component paints (the
   gutters, overlay gaps) previously forced native extraction and broke the
   soft-wrap join even when the cells were pure whitespace. Now: an unowned
   run whose native slice trims to empty contributes nothing and does not
   touch the join decision; unowned runs with real text keep the old native
   fallback.

### Checks executed

- `npm test` 253/253 — new `test/fullscreen-margin.test.mjs` against the REAL
  TuiAltScreen: render inset, retroactive wrap, MouseRegion click through the
  shifted frame + gutter no-op, narrow-terminal fallback, idempotent
  re-install, dispose, `margin 0` no-op, regular-renderer skip, exact
  selection copy through the offset frame (plain container AND
  scroll-view-with-scrollbar structure); config validation cases added.
- `npm run check` + `check:core` clean; `test:chrome` 14/14; `test:host` PASS.
- `test:pty` real-tmux PASS with the feature ACTIVE (margin=2): all prior
  stages green (idle footer, live Working, thinking timers, auto-collapse +
  real mouse click expand/collapse through the shifted frame, tool run,
  provider error), selection copy stays `exact=2 mixed=0 native=0` at 161
  chars, plus new assertions: transcript rows inset past margin+outputPad
  columns and `/codex-ui` reports `fullscreen-margin: applied (margin=2)`.

### Trade-offs / limits (accepted)

- `setLayoutRoot` is a non-public seam (instance/prototype wrap, owner-symbol
  guarded) — same risk class as the existing selection-copy mirrors; worst
  case on host refactors is the gutters silently not applying, never a crash.
- Fullscreen overlays (autocomplete, dialogs, search) do not go through the
  layout root and stay full-width — consistent with how Codex overlays behave.
- Native (non-extension) fullscreen selection over a gutter row can include
  the blank gutter cells visually; the Ctrl+C logical copy path is unaffected.

## 0.9.5 — cyan highlights → Codex blue

### Requirement

User screenshots: pi still shows cyan accents where Codex shows blue. Change
every cyan highlight to the Codex blue.

### Evidence (pixel sampling of both screenshots)

- pi cyan = `#94E2D5` (and its antialiasing ramp), plus the theme accent
  `#8abeb7` (muted teal). Sources: surface accent painter, thinking rail,
  editor fallback accent, Working bullet-pulse/shimmer shades, exploration
  verbs, `MOCHA.operator` (bash `&&`), theme `accent` var.
- Codex blues: command tokens (`conda run -n test python -c`, `rg -n -m 1`)
  = `#89B4FA` (Mocha blue); markdown inline code = `#3A96DD`. Chose the
  `#89B4FA` family for all accent replacements (same Mocha palette the plugin
  already uses).

### Changes

- `#94E2D5` → `#89B4FA` (`137;180;250`): exploration verbs (`explore.ts`),
  bash operator token (`palette.ts` MOCHA.operator), thinking rail and the
  surface accent painter (`index.ts`), editor fallback accent (`editor.ts`),
  Working bullet-pulse shades (`working.ts`).
- Working shimmer comet: 8-level teal `SHIMMER_RAMP` rebuilt around the blue
  anchor with the same lightness curve (head `205,228,255` → tail
  `50,74,142`); highlight step uses Mocha lavender `#b4befe`.
- Theme package `accent` `#8abeb7` → `#89b4fa` (`themes/codex-appearance.json`):
  markdown inline code, list bullets, syntax operators, Working bullet
  (`theme.fg("accent")`) and any accent borders turn blue with the same change.

### Checks executed

- `npm test` 253/253 (adapter exploration-verb SGR assertion updated to the
  blue; working tests assert ramp structure only, no RGB lock; working test
  fake accent updated to stay truthful).
- `npm run check` + `check:core` clean; `test:chrome` 14/14.
- Grep confirms no `#94e2d5` / `148;226;213` / `#8abeb7` remains in src/,
  index.ts, or themes/.

### Trade-offs / limits (accepted)

- Codex's inline-code blue is a different shade (`#3A96DD`); our inline code
  follows the theme accent (`#89b4fa`). One accent hue everywhere was chosen
  over per-element shade matching.
- `MOCHA.operator` now equals `MOCHA.function` (`#89b4fa`) — `&&` reads as
  part of the command, matching how Codex renders command tokens.

## 0.9.6 — tool-cell bullets → Codex state colors

### Requirement

User: the small dots left of "Ran"/"Explored" are too desaturated to read the
run state; match Codex's vivid dots.

### Evidence (pixel sampling)

- Codex done bullets ("• Ran" ×5 rows) = `#13A10E` (vivid green, Campbell ANSI
  green); codex delete text = `#C50F1F` (same ANSI family), running status dot
  = pale gold `#F0DCB2`.
- pi before: "Ran" bullet = theme success `#86C995` (muted pastel);
  "Explored" header bullet = plain dim gray `#6c7086` (no state tone at all);
  "Edited" done cells = dim gray (no success branch in the write/edit paths).

### Changes

- Theme `success` `#86c995` → `#13a10e` (`themes/codex-appearance.json`): all
  done-state bullets (Ran/Wrote/Added/Edited/Explored) and the Writing
  "Written" stage label turn vivid green. `toolDiffAdded` keeps the `green`
  var — diff text color unchanged.
- Exploration header bullet is now state-aware (error → error tone, running →
  dim, done → success); write/edit cell paths gained the missing
  `done → success` branch (previously always dim when done).
- Running stays dim, error stays error — three states clearly distinguishable.
- Side fix: `formatCall` painted its marker bullet before the exploration/
  shell early returns, double-painting "•" per call (harmless with a real
  theme, visible as duplicate paints in tests). Marker now lives after the
  early returns.

### Checks executed

- `npm test` 254/254 (new: bullet tone dispatch test — dim while running,
  success once done, for shell and exploration paths; adapter Explored
  expectation updated to the state-tone bullet).
- `npm run check` + `check:core` clean; `test:chrome` 14/14; `test:host` PASS.

## 0.9.7 — deep alignment with openai/codex color sources

### Requirement

User: read the Codex official source, find every remaining element where Codex
uses high-saturation colors, and align this project's colors with them.

### Codex source evidence (fetched from openai/codex main)

- `tui/src/style.rs`: status tones are ANSI palette colors —
  `Success = Color::Green`, `Failure = Color::Red`, `Attention = Color::Yellow`
  (all bold); `accent_style()` = `Color::Cyan.bold()` on dark backgrounds.
- `tui/src/exec_cell/render.rs`: exec bullets `"•".green().bold()` /
  `"•".red().bold()`; exploration header bullet `"•".dim()` when done;
  member verbs `title.cyan()`.
- `tui/src/markdown_render.rs` (`MarkdownStyles::default`): `code: cyan`,
  `link: cyan().underlined()`, `ordered_list_marker: light_blue`,
  `blockquote: green`, headings/emphasis = modifiers only (no color).
- `tui/src/diff_render.rs`: dark truecolor backgrounds
  `DARK_TC_ADD_LINE_BG_RGB #213A2B` / `DARK_TC_DEL_LINE_BG_RGB #4A221D`
  (ours already matched); content fg ANSI Green/Red.
- `tui/src/render/highlight.rs` + `adaptive_default_theme_selection`: dark
  terminals default to syntect **Catppuccin Mocha**.
- `tui/src/shimmer.rs`: the working indicator is hueless (bg→fg white blend).

The user's terminal ANSI palette was verified to be Campbell by four exact
pixel matches (#13A10E green, #C50F1F red, #3A96DD cyan, #881798 magenta), so
the ANSI references are materialized as those hex values.

### Changes

- Theme: `accent`/`link` → `#3a96dd`; `red` → `#c50f1f`; `green` → `#13a10e`;
  `yellow` → `#c19c00`; `mdLinkUrl: link`; `mdQuote: green`; syntax keys →
  Catppuccin Mocha (keyword #cba6f7, function #89b4fa, variable #cdd6f4,
  string #a6e3a1, number #fab387, type #f9e2af, comment #6c7086,
  punctuation #9399b2).
- Source: exploration verbs → `#3a96dd` (codex `title.cyan()`); thinking rail,
  surface accent painter, editor fallback accent → `58;150;221`.
- Kept: working-widget Mocha blue (codex's is hueless; deliberate accent),
  heading gold, diff backgrounds, MOCHA bash lexer palette.

### Checks executed

- `npm test` 254/254; `npm run check` + `check:core` clean; `test:chrome`
  14/14; `test:host` PASS; adapter verb SGR expectation updated to
  `58;150;221`.
