# Validation record — 0.6.0

## Scope

Version 0.6.0 adds serial exploration grouping, the tool→assistant-text
separator and full-body output dimming. All checks below were executed in the
development checkout (`/home/xu/project/tools/pi-codex-appearance`, Node
v24.15.0, Pi core/TUI 0.85.1) unless stated otherwise.

## Checks actually executed

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | **126 passed; 0 failed** | Unit + golden + parser + transcript suite (31 new 0.6.0 tests: serial grouping, boundaries, separator idempotence, DIM span semantics) |
| `npx tsc -p tsconfig.json` (`npm run check`) | **0 errors** | Real TypeScript compiler over `src/` + `index.ts` |
| `npm run test:host` | **PASS** | Real Pi `ToolExecutionComponent` two-slot assembly: one title per toolCallId, write five states, mouse expand/fold, third-party back-off, teardown restore |
| `npm run preview` | **Passed** | Production two-slot renderers incl. shell factories (same `styleToolOutputLine` DIM path as the host); 8-image serial group, one header, aggregated `8 images`, one separator line |
| `npm pack --dry-run --ignore-scripts` | **Passed** | 0.6.0 manifest, file list sane |

## What is verified vs not

Verified by tests: one group across 8 tool-call-only assistant messages;
serial reads (A ends before B starts) and 45 s gaps stay in one group; title
flips Exploring→Explored while the group stays open; visible-thinking / bash /
foreign-tool / failed-member boundaries split correctly; parallel completion
keeps creation order; duplicate events are idempotent; group Images counted
from real image blocks; separator arms only after tool activity, never after a
user boundary, never duplicated across 100 streaming deltas; DIM spans decoded
per cell (source colors survive, `0m`/`22m` re-acquire DIM, RGB components
`0/22/39` never misread, no SGR under no-color, no leak past rows).

Not verified here (needs a real terminal session): actual mouse hit-testing on
de-spaced group members in the live TUI, image protocol rendering, soft-wrap
copy behaviour, and the visual result in the user's specific terminal. The
preview is a formatter/component snapshot, not a screenshot of a running Pi.

## 0.4.0/0.5.0 delivery notes (historical)

Earlier delivery records described un-downloaded dev dependencies and
unverified host checks; since then the host smoke test and full dependency set
run locally, and 0.5.0 additionally removed the bare `diff` import that broke
git-clone installs (zero-dependency Myers diff in `write-tracker.ts`).
