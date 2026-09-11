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
