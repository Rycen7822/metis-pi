# Validation

Current working tree after `4b1319a`, checked on 2026-09-22 with Node 24.15.0 and Pi 0.86.1. This page records current evidence and limits; implementation history belongs in Git. Commands are documented in [development.md](docs/development.md).

## Checks

| Check | Result |
| --- | --- |
| `env -u NO_COLOR npm run verify` | Exit 0: 303/303 tests, project/vendor type checks, vendor activation, real Pi host smoke and package dry-run. |
| `npm run check:core` | Exit 0. Pure rendering/state code retains the host-effect boundary. |
| `npm run preview` | Exit 0. Message separators resolve through object identity; plaintext matches the committed preview. ANSI/HTML were regenerated. |
| `env -u NO_COLOR npm run test:pty` | Fails at `wheelUntil`; the full PTY suite is not green. |
| Isolated PTY copy omitting only wheel/refollow assertions | Exit 0: tool folding, todo persistence/restart, skills, failure summary, 161-character exact copy and fullscreen margins. This does not validate scrolling. |
| Vendor patch replay | All 31 patch files apply to pristine 3.0.34; 423 retained files match bytes and modes after documented native-payload exclusions. |
| Repeated `vendor:build` / `vendor:patch` | Identical dist digest and byte-identical patch. |

## Behavior protected

| Area | Evidence |
| --- | --- |
| Responses preparation and replay | Built-provider tests cover legacy Context and transcript input, system sections, full transcripts versus slices, additive tools versus deletion/redeclaration, namespace/grammar mapping, tool-search pairing, model folding, prewarm and compaction replay. One preparation path owns tool placement. |
| Transcript and rendering | Lifecycle tests preserve stable identity across streaming/finalization, duplicate-end suppression, separate thinking-run clocks, exploration boundaries, selection provenance and teardown. Preview fixtures no longer encode private message-key strings. |
| Goal state | Seven host-entry tests cover replacement during a turn, cached-token accounting, elapsed time, pause/edit/resume, branch restore, completed-goal accounting and continuation filtering. The same seven tests pass against the entrypoint saved before extraction. |
| ANSI rendering | Extended RGB/indexed/colon colors consume their parameters before ordered DIM/background decisions. Two regression tests fail against the previous implementation and pass now; non-SGR control sequences remain unchanged. |
| Root configuration / todo | Existing config precedence, command/tool outcomes and schema tests remain green. |
| Vendor configuration / settings | 1,782 differential configuration fixtures and 385 setting updates match the baseline, including labels, choices, action markers and immutable updates to the latest draft. Maintained tests cover aliases, defaults, optional values, dependent flags and all 15 simple toggles. |
| Notebook state | Generated capture code tests cover values/functions/metadata, partial writes, close/commit, caps and scope-specific skips/errors. Hashed payloads and checkpoint layout mismatches are tested. |
| Shell truncation | 270 comparisons against the saved implementation match across empty/long input, narrow/wide output and row budgets. |

The real-host smoke assembles Pi's actual components and validates tool title ownership, write states, mouse folding, skills and chrome. It is separate from terminal input injection and from a real provider request. Temporary differential probes and logs are local `.work/refactor3/` artifacts; maintained regressions live under `test/`.

## Limits

- Full PTY scrolling remains unverified here. Historical baseline runs on Pi 0.85.1 and 0.86.1 also failed at `wheelUntil`; that evidence does not establish that every current wheel behavior is correct.
- Codex provider tests use offline payload capture. No real paid Codex request or server-produced encrypted compaction checkpoint was used; compaction fixtures are offline substitutes.
- Notebook capture tests exercise generated code in Node, not the native Deno runtime. Native payload binaries were not rebuilt or changed.
- No real OS clipboard or image-terminal validation. Mouse selection/copy tests compare bytes through the isolated fixture clipboard.
- No user configuration, Pi version or other installed plugins were changed by this refactor. Running Pi processes need a restart to load rebuilt vendor code.

Vendor baseline, retained payload exclusions and patch maintenance are documented in [UPSTREAM.md](vendor/pi-codex-conversion/UPSTREAM.md) and [PATCHES.md](vendor/pi-codex-conversion/PATCHES.md).
