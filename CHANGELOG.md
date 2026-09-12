# Changelog

## 0.9.5

青色高亮统一改为 Codex 蓝（两张截图逐像素取样：pi 青 = #94E2D5 / 主题 accent #8abeb7，
Codex 命令高亮蓝 = #89B4FA）：

- **换色清单**：探索行动词（Read/Search…）、bash `&&` 操作符（MOCHA.operator）、Working 动画
  （圆点脉冲 + shimmer 彗星 ramp）、思考 rail、composer 提示符/元信息/footer 的 accent、
  编辑器默认 accent：#94E2D5 → #89B4FA。
- **主题 accent** `#8abeb7`（灰青）→ `#89b4fa`：markdown 内联代码、列表符号、语法操作符、
  Working 圆点（theme.fg("accent")）随之变蓝。
- shimmer 高光档用 Mocha lavender `#b4befe`；渐变 ramp 8 档整体重造为蓝系，亮度曲线与原
  teal ramp 对齐（结构测试只断言头亮于尾 + 平滑插值，不锁具体 RGB）。

## 0.9.4

Fullscreen 左右留白（Codex 式侧沟），纯插件实现、不改宿主：

- **全 UI 对称内边距**：fullscreen 渲染器的 `setLayoutRoot` 被原型级幂等包装（owner symbol，
  与 selection-copy 同一先例），布局根外包一层 pi-tui 公开组件 `HStack[Spacer | 原root | Spacer]`。
  所有帧矩形由布局引擎统一偏移——鼠标命中（点击展开/折叠 Thought）、光标定位、滚动条、
  选择复制全部自动保持一致；点在留白区命中无交互的 Spacer，安全无操作。
- **配置**：`fullscreen.marginX`（0..8，默认 2，0 关闭）、`fullscreen.minWidth`（40..400，
  默认 72）——窄于阈值时留白自动消失、内容恢复全宽（Stack 条目的 `visible(viewport)` 回调，
  布局引擎每帧求值）。
- **regular 模式零影响**：只有 `mode === "fullscreen"` 的渲染器原型被包装；主屏模式刻意不碰
  （终端模拟器拥有鼠标，原生拖选复制保持不变）。
- **选择复制两处配套修正**（对 0.9.0 语义的一般性补强）：
  - 滚动选区的列坐标此前隐含假设内容区 x=0；留白后内容区整体右移。序列化器的内容空间锚点
    现在同时携带 x/y（此前只有 y），归属填充与 span 原点都做 x 换算。
  - 未被任何组件拥有的**空白**单元格（侧沟、覆盖层空隙）不再强行判定为原生内容并打断
    软折行连接；有实际文字的未拥有单元格行为不变（仍原生回退）。
- `/codex-ui` 新增 `fullscreen-margin` 状态行。
- 测试：真实 TuiAltScreen 上验证渲染内缩、MouseRegion 点击命中与留白无操作、窄屏回退、
  幂等/拆卸、以及两种结构（裸容器 / 滚动视口+滚动条）下的精确复制回归；PTY 真实 tmux
  全流程新增留白可见性断言（exact=2 mixed=0 native=0 保持）。

## 0.9.3

渲染性能专项（实测驱动，无新表面、无行为回归）：

- **流式镜像节流**：selection-copy 的 Markdown/Text 复制镜像此前在文本变化时**每帧**全量重建
  （实测 40KB 消息：宿主渲染 7.5ms/帧 → 加镜像 50ms/帧）。现在同一宽度下文本持续变化时
  每 200ms 最多重建一次；首次渲染、宽度变化、文本停止变化都立即重建——流式结束的稳定帧
  永远有复制产物。被跳过的帧无产物，该帧复制降级为原生提取（永不复制错内容）。
  实测 40KB 流式 300 帧：构建 300 次 → 24 次。
- **镜像常量因子**：`wrapWithProvenance` 对纯 ASCII 段跳过 `Intl.Segmenter` 逐 grapheme 拆分
  与逐字符宽度调用（可打印 ASCII 必为单格单 grapheme，与慢路完全等价）；逐行校验的快路用
  stripAnsi+切左边距替代列感知的 sliceByColumn+stripTerminalSequences（不合规行回退慢路）。
  单次构建 40KB 从 ~41ms 降到 ~13ms。
- **Container/Box 对齐不再重渲染子树**：各包装原型把刚返回的行数组发布到实例的
  `LAST_ROWS` 槽位，对齐 pass 按数组身份解析子产物——此前每个子组件每帧多渲染一次，
  嵌套容器按 2^深度 放大（实测 12 消息树叶子渲染 24 → 192 次/帧，7k 行 transcript
  +930%/帧）。修复后 150 消息 transcript 每帧开销 1.18ms → 0.12ms（≈裸渲染）。
  未包装类型（MouseRegion 等）的子组件仍按原路径回退渲染，行为不变。
- **小项**：thinking 装饰层的 Spacer 原型探针按会话缓存（此前每次 updateContent 分配一个）；
  持续降级的组件也计入节流（不再每帧重试全量镜像）；`/codex-ui` 镜像诊断新增 throttled 计数。
- 复制正确性不变：全部差分测试（CJK/列表/代码块/引用/灰底卡片/折叠标签）与 PTY 实测
  （exact=2 mixed=0 native=0）通过。

## 0.9.2

用户消息灰底卡片 + thinking 完成后自动折叠（带时长）：

- **用户消息灰底**：主题新增 `userMessageSurface: #292929`，经原生
  `userMessageBg` 槽位生效——宿主 `UserMessageComponent` 本来就用背景 Box 渲染，
  不打补丁、不改消息文本。
- **每轮 thinking 计时**：`ThinkingRunPlan` 按宿主语义分轮（连续 thinking 块为一轮、
  任何非 thinking 块断轮、全空轮不占 runIndex）；起点 = 首个非空 thinking 文本且
  只记一次，终点 = 轮后首个非 thinking 块或 `message_end`，重复更新不重置也不延长。
- **自动折叠一次**：完全复用宿主的 `thinkingVisibilityOverrides`（可点击、可 Ctrl+T），
  每个生命周期转换只写一次——手动切换与全局开关永不被对抗；`completed=full` 只在
  存在覆盖项时强制展开，不与全局隐藏打架。
- **折叠标签带时长**：`Thought for 13s` / `1m 04s` / `1h 02m 03s`（与 Working 行同一
  格式约定）；只在已结束的轮上替换宿主自身折叠 Text（原生 MouseRegion 点击保留），
  活跃轮保持宿主 `Thinking...`；无计时证据显示 `Thought`，绝不伪造 0s。
- **克隆重渲染兼容**：宿主用 message 克隆对象重渲染已结束的 transcript，sealed 计划
  按"规范化内容+stopReason"指纹复用，真实计时不丢失。
- **默认值**：`thinking.completed` 默认改为 `collapsed`（`streaming` 仍 `full`）；
  `/codex-ui` 显示策略与已应用的可见性转换数。
- **复制不回归**：折叠标签是真 Tui.Text，经 0.9.1 镜像只复制 `Thought for 13s`，
  隐藏的思考正文不可能被复制；灰底卡片在 60/80/120 列下复制文本逐字一致、无背景 ANSI。

## 0.9.1

0.9.0 评审轮修复与清理（同一功能，无新表面）：

- **shell 命令复制净化**：命令 content span 的文本不再携带语法高亮 ANSI。序列化器
  逐 grapheme 切 span 文本并原样复制，彩色终端下此前会把转义字节写进剪贴板并错位。
- **序列化失败回退修正**：catch 回退改用同一 `sourceLines`——scrollView 选区是内容
  坐标，此前误用屏幕坐标的 `previousScreen` 会复制错行。
- **空结果原生对齐**：纯装饰选区返回 `undefined`（stock 语义），`hasActiveSelection()`
  与宿主 Esc/剪贴板路由完全一致；Ctrl+C 消费语义不变（编辑器钩子按选区几何判断）。
- **流式尾窗拼接**：isPartial shell result 与折叠 write preview 仅对窗口首行强制
  hard，窗内软拼接保留（含 elision 提示挤掉首行后暴露的新首行）。
- **shorten 既有 bug**：行长度上限改按可见字符计——彩色命令此前会被完整渲染却多挂
  一个假" …"（原始长度含 ANSI 触发了守卫）。
- **健壮性**：mirror 缓存命中也为新数组注册 product；thinking rail 对已带 `▏`/`| `
  前缀的 pass-through 行按 0 偏移；排队 Ctrl+C 复制当前选区而非旧快照；
  `/codex-ui` copy-stats 增加产品缓存统计（`cache=hits/misses`）。
- **清理（-88 行）**：删除恒等 `stripOwnPrefix`、别名 `visibleOfStyled`、未使用的
  `rowsFromProvenance`/`buildCellTable`/`wide`/`ResolvedRow` 等；Box/Container 与
  Markdown/Text 原型包装器各自合并为参数化实现；新增 copy-provenance 回归测试
  （5 例：ANSI 净化、header-only strip、流式/折叠尾窗拼接）。

验证：222/222 单元 + tsc 双配置 + chrome 14/14 + host smoke + PTY 真机（SGR 鼠标
拖选 + Ctrl+C → exact=2、161 字符与回复等长）。

## 0.9.0

逻辑选区复制（fullscreen）：去掉终端宽度造成的视觉折行，保留真实换行与缩进；有选区时
Ctrl+C 复制，无选区保持原生行为。

- **序列化点替换**：宿主 `getActiveSelectionText` 的逐行 `trimEnd()+join` 是根因；精确
  serializer 安装在 TuiAltScreen 原型层（经扩展可见的 Proxy 门面拿真实原型），全部内部调用
  （copy-on-select / Ctrl+X / Ctrl+C / hasActiveSelection）走同一入口。选区几何
  （getSelectionBounds/getSelectionColumns）保持宿主原生。
- **渲染时 provenance**：Text/Markdown/Box/Container 原型包装 + 自有 shell/diff/write/rail
  组件内生成，product 以渲染数组身份为键（WeakMap）——天然绑定已提交帧，放弃帧/重绘安全。
  Markdown 镜像复刻结构管线（lexer + 各层 wrap），inline 层直接调用宿主实例方法保证样式逐
  字节一致；每次生成与宿主真实行做位置 diff，漂移只降级 native，绝不猜。
- **边界语义**：soft 断点记录被包装器消费的空白（bridge，仅两侧都选中时补）；decoration
  （gutter/行号/rail/padding）永不复制；semantic 前缀（列表 marker/引用首行边框/diff 符号/
  围栏）选中才复制；gap/unknown 保守硬断开。表格/图片/未知 token 回退原生。
- **Ctrl+C 分流**：编辑器 handleInput 覆盖 —— 选区存在即消费按键（有内容复制、纯装饰只消费
  不写剪贴板、失败保留选区与草稿），无选区完全走原生（清空/双击退出不变）；焦点在模态时天然
  让位。有界 in-flight 合并。
- **共存**：`pi-copy-soft-wrap` 检测进 `/codex-ui`（`other-wrapper=`）；精确路径优先，启发式
  不再作用于本插件实例。marked 以与 pi-tui 相同的 18.0.5 pin 加入（package 测试含版本漂移守卫）。
- **性能实测**（scripts/copy-perf.mjs）：带 provenance 的热帧 0.16ms（1k 行）/0.78ms（10k 行）
  终端帧；复制 20 行 0.1–1.7ms，10k 行全选 63ms（17µs/行，随选区规模线性）。
- **验证**：单元 fixture + 种子 property（镜像行与宿主逐行相等 + 全选 round-trip）、真实
  TuiAltScreen 真实 SGR 鼠标按下/拖动/释放 + Ctrl+C 草稿保持、外部 wrapper 绕过、PTY 真实
  pi fullscreen + 真实鼠标序列 + /codex-ui 遥测（exact=2，字符数与源文相等）。217/217。

## 0.8.8

Shimmer feel correction (user feedback: the 0.8.7 comet swept too fast —
"high frame rate" should mean smoother motion, not a faster sweep):

- **Continuous comet head**: the head now advances a fraction of a cell per
  frame (0.25 cells/frame at the 32ms default → 128ms per cell, the leisurely
  0.8.6 pace) while the high frame rate drives smooth sub-cell intensity
  flow — the 8-level teal gradient interpolates per frame, so the trail
  visibly melts instead of stepping.
- Frame rate, cycle discipline (enter → sweep → exit → pause, no overlap)
  and the bullet's own cadence are unchanged; frame cost stays ~0.003ms.

`npm test` 209/209.

## 0.8.7

Working shimmer polish (user feedback: make the sweep feel smoother):

- **Gradient comet**: the flat 3-cell highlight is now a 5-cell comet — a
  bright leading edge with a trail fading through four teal shades back into
  the theme dim (truecolor; other levels stay static as before). The head
  leads in the direction of motion; each character lights up and decays as
  the wave passes.
- **Higher frame rate**: the animation interval default drops 64ms → 32ms
  (config clamp unchanged at 32..1000, `working.animationIntervalMs`). One
  comet position per frame; the bullet pulse keeps its own 2-frame cadence
  so it stays readable at the higher rate.
- Verified frame-by-frame in the real TUI (truecolor, mock provider): 40
  samples at ~35ms produced 7 distinct line states — the comet advances
  smoothly; the pure-math trace confirms head-first gradient orientation
  (bright at the front, trail behind) and the 0.8.6 overlap-free cycle.

`npm test` 208/208.

## 0.8.6

Working shimmer fix (real-use video: the second wave started while the first
was still mid-word):

- **Root cause**: two mismatched cycle lengths — the highlight position used
  `frame % 12` inside a `frame % 16` loop, so the sweep restarted at position
  0 after 12 frames while the outer cycle cut it off again at 16. A wave
  entering the word therefore chopped the previous one mid-sweep.
- **Fix** (`src/chrome/working.ts`): one consistent cycle — ENTER (window
  slides in from the left edge) → SWEEP → EXIT (fully off the right edge) →
  PAUSE — parameterized by the actual message length, so a wave always
  completes before the next begins. The highlight now holds each position for
  2 frames (~128ms at the default 64ms tick): the host coalesces renders, and
  one-position-per-frame read as stutter. The bullet pulse keeps its own
  4-step cycle. A unit test now walks the full timeline and asserts the
  highlight never moves backwards mid-wave and re-entry happens only at the
  cycle boundary; the real-TUI wiring was verified frame-by-frame (tagged
  tones: `W→o→r→k→i→n→g` advancing with held positions).

`npm test` 208/208.

## 0.8.5

Composer surface, Codex Working rhythm, OpenCode-style metadata, and a real
Codex quota source (visual convergence round; all data read-only):

- **Gray composer surface** (`src/chrome/editor.ts` + `src/surface.ts`): the
  full-width accent borders are gone. `CodexSurfaceEditor` (still the host
  `CustomEditor` — input buffer, wrapping, autocomplete, paste, history, undo
  and mouse are untouched) replaces the top/bottom border with surface-
  painted padding rows, keeps the `↑ N more`/`↓ N more` scroll indicators,
  borrows the first row's two padding cells for a `> ` prompt prefix (same
  cell count — cursor geometry, mouse hit tests and autocomplete anchors are
  unchanged; `getText()` never contains the glyph), and shows a dim
  `Ask anything...` placeholder on the empty editor. The host re-applies its
  own `paddingX` after install, so the subclass clamps it to ≥2 — the prefix
  needs the two cells. The background is painted per physical row with bg
  re-assertion after inner resets (the cursor cell `\x1b[7m \x1b[0m` would
  otherwise punch a hole); truecolor → `#1f1f1f`, ansi256 → nearest gray
  (234), ansi16/NO_COLOR → no background, layout preserved.
- **Composer metadata widget** (`src/chrome/composer-metadata.ts`): the
  OpenCode-style `model · thinking level · provider    ctx used/capacity ·
  percent` row installed through the public belowEditor widget slot, painted
  with the SAME surface ops so editor + metadata read as one surface.
  Model/effort switches update live (no restart). The footer no longer
  duplicates model/context.
- **Compact product footer** (`src/chrome/footer.ts`): one status line —
  `dir (branch)   ↑in ↓out · cache NN% · Codex 5h 82% · week 64%` with R/W
  and cost appearing at wide widths. Priority ladder under width pressure:
  cost → R/W → shorter dir → wrap to two rows; P0 (cwd/branch, session I/O)
  and P1 (cache, quota) always survive.
- **Codex Working rhythm** (`src/chrome/working.ts`): the line is now
  `• Working (3m 36s · thinking 24s · esc to interrupt) · read` — Codex
  status grammar (layout/timing reference only, no identity copying), with
  `Writing`/`Waiting for input` phases and `thought for Ns` after thinking
  closes. Tokens moved out of the Working line (they live in the metadata/
  footer; `working.tokens` defaults to false). A restrained shimmer: bullet
  brightness pulse + a 3-cell highlight sweeping the message word, on its own
  64ms timer (clamped 32..1000, config `working.animation*`), truecolor
  only, static under NO_COLOR/ansi16. The timer runs only while active;
  settle/dispose leave zero timers; a frame only bumps a bounded counter and
  requests a render (measured: 0.003 ms/frame — no session scan, no fs, no
  quota in the animation path).
- **Real Codex quota** (`src/quota/*`): read-only subscription rate limits
  from the locally logged-in Codex CLI — `codex app-server --listen stdio://`
  (argv array, no shell), JSON-RPC `initialize` → `initialized` →
  `account/rateLimits/read`, normalize, dispose. `remainingPercent` is always
  derived (`100 − usedPercent`, clamped) — never swapped. Boundaries: startup
  + per-RPC timeouts, bounded stderr with Bearer/access_token redaction,
  early-exit rejection, single in-flight refresh, last-good snapshot + stale
  marker, bounded error classes in diagnostics (`codex-missing`,
  `startup-timeout`, `rpc-timeout`, `rpc-error`, `early-exit`, `malformed`,
  `no-data`). No credentials are read, no private HTTP endpoint is contacted,
  the Codex TUI is never scraped. Refresh: session_start, agent_settled
  (when older than 30s), periodic ≤ `quota.refreshSeconds` (TUI only, unref'd
  timer), manual `/codex-ui refresh-quota`. A quota failure is UI-auxiliary —
  it never affects agent outcomes or the interaction verdict.
- **Config** (backwards compatible, defaults for missing fields):
  `composer.surface/promptPrefix/metadata`, `working.animation/
  animationIntervalMs/tokens:false`, `footer.showCacheReadWrite/
  showCodexQuota`, `quota.codex:auto|on|off/refreshSeconds/timeoutMs`.
- **Tests**: chrome suite rebuilt for the surface split (metadata owns model/
  context, footer owns cwd/session/quota), editor real-component tests
  (border removal, bg on every row, prefix, placeholder, scroll indicators,
  legacy fallback), Working format + animation lifecycle with a fake
  scheduler (one timer, frames differ visually, stripped text stable, no
  growth), quota suites (normalize math, protocol against a mock child,
  failure classes, redaction, store coalescing). `scripts/pty-verify.mjs`
  asserts the new real-TUI frames: composer placeholder + `> ` prefix,
  metadata line, compact footer without model duplication, and the Codex
  Working rhythm with dual timers.

`npm test` 207/207 · `test:host` PASS · `test:pty` PASS (real TUI frames) ·
real `codex app-server` integration verified read-only (plan pro, primary
remaining 4%, window 10080min → "Codex week 4%").

## 0.8.4

Footer details, standalone Working line, and runtime outcome verdicts
(spec-reviewed against the real Pi 0.85.1 API surface):

- **Real host data bridge** (`src/host-data.ts`): the 0.8.3 footer read
  `model.label/displayName/effort` and `ctx.ui.getContextUsage().percentUsed`
  — none of which exist on Pi 0.85.1 — so a standard model rendered as
  nothing and the footer degraded to a bare directory. All display data now
  flows through one validated bridge: `ctx.model.id/name/provider/
  contextWindow`, `ctx.thinkingLevel` (`off` shown explicitly), and
  `ctx.getContextUsage()` (`tokens/contextWindow/percent`). Reads go through
  the LIVE context — a model/effort switch shows up without a restart, and
  one revision covers model + usage together.
- **Two-line footer details** (`src/chrome/footer.ts`): line 1
  `model · effort · provider` left, `ctx used/capacity · percent` right;
  line 2 `dir (branch)` left, session `Σ↑input ↓output · cache(last) rate ·
  Rread Wwrite` (+ known cost) right. Layout is computed on plain segment
  text at cell width (CJK-aware) and painted afterwards — final ANSI strings
  are never `.slice()`d. Narrow widths wrap groups onto their own rows
  instead of deleting the right-side stats; 0/1/2 columns render nothing and
  recover when width returns.
- **Session usage ledger** (`src/usage-ledger.ts`): session-scope totals
  from the session file's standard entries (assistant messages +
  compaction/branch_summary usage; our own summary CustomEntry excluded),
  deduped by `${provider}:${responseId}` / entry identity so live events and
  rebuilds never double-count. `cache(last)` is the most recent confirmed
  request's `cacheRead/(input+cacheRead+cacheWrite)`; the session-weighted
  rate is in `/codex-ui`. Streaming usage replaces (never sums) per request;
  unknown values render `—`.
- **Standalone Working line** (`src/chrome/working.ts`): an above-editor
  widget via the public `setWidget(key, factory, {placement:"aboveEditor"})`
  in the Zentui segment order `Message · Tool · Elapsed · Thought · Tokens`
  (Zentui is a layout reference only — not a dependency, not installed).
  `embedWorkingStatus` is now `false` on our editor; the native loader row is
  hidden only after the widget installed successfully, and the old
  message-based fallback stays when `setWidget` is unavailable — never three
  Working copies. Active tools render by real toolCallId (`bash +2` for
  parallel runs) and clear on completion.
- **Runtime outcome verdicts** (`src/interaction-outcome.ts`): the sticky
  `lastRunFailed` flag is gone. A mid-run tool error only increments a
  diagnostic counter; the verdict comes from terminal evidence — the final
  assistant attempt's `stopReason` (stop → `Worked for …`, error →
  `Failed after …`, aborted → `Interrupted after …`, length →
  `Ended after … · output limit`, no reliable evidence → `Ended after …`).
  Retry/continuation semantics: the highest attempt with terminal evidence
  wins, so a stale late error cannot override a newer clean stop, and an
  unfinished newer attempt yields `unknown`, never guessed success. Summary
  entries are written as schemaVersion 2 (outcome + evidence + attempt +
  toolErrorsObserved); v1 entries stay readable, and v1 `failed` (written by
  the old sticky-flag bug) renders `Ended after … · legacy status unverified`
  — history is never rewritten in either direction.
  `summary.persist:false` now has a real transient path: the settled line
  lives in the footer status row until the next interaction (no third
  transcript patch).
- **Lifecycle hardening**: chrome modules preload once and install through a
  generation guard — a late preload resolution after shutdown/new session
  can no longer install stale UI; shutdown restores only our own factories
  (identity-compared editor) and re-shows the native loader only when we hid
  it. Chrome/metrics/summary side effects are gated on the real
  `ctx.mode === "tui"` (not `hasUI`), so print/json/rpc never get timers or
  ANSI. Diagnostics (`/codex-ui`) report real states (installed/applied/
  disabled/fallback), per-value sources and scopes, confirmed-vs-preview
  usage, terminal evidence, and the versions read at runtime from
  package.json / `Pi.VERSION` — no more hardcoded 0.8.1/0.85.1.
- **Tests**: chrome tests rebuilt on the REAL host data shapes (the old ones
  injected the plugin's own wrong assumptions); new unit suites for the
  bridge, ledger math (spec formula: session 5000/300/10000/0 → cache(last)
  20.0%, cache(session) 66.7%), outcome sequences (14 cases through the
  reducer), Working formatting and footer layouts at 40/60/80/120/160 plus
  0/1/2 columns. `scripts/pty-verify.mjs` drives the real `pi` binary in a
  real tmux PTY against a local mock OpenAI-compatible provider (zero paid
  requests) and asserts screen frames per stage: idle footer details, live
  `Working…` with growing elapsed/thinking timers, real bash tool output
  with a `Worked` summary, and a forced provider error ending in
  `Failed after`.

`npm test` 193/193 · `test:host` PASS · `test:pty` PASS (real TUI frames).

## 0.8.3

Write call/title fixes from real-use screenshots:

- **Bare `write` fallback after completion**: after a write finished, the
  call slot silently degraded to the host's bare tool-name fallback. The
  renderers' `component()` reuse helper called `setText` on ANY of our
  previous components — including the 0.8.1 write-call composite, which has
  no `setText` → TypeError → host catch → `createCallFallback()`. The helper
  now reuses only components that actually implement `setText`; completed
  writes show `• Wrote/Added/Edited <path> (+N -M)` aligned with `• Ran`.
- **`(path pending…)` placeholder**: content-first providers stream a
  write's `content` before its `path`, so the streaming header showed a
  misleading bare `.` (the old fallback). The header now shows
  `• Writing (path pending…)` and re-renders with the real path the moment
  the path frame arrives.

## 0.8.2

Crash hotfix for a 0.8.1 regression (found in real use, captured by the
user's `pi-capture` wrapper — thank you):

- `CodexWriteCallComponent.update()` REPLACED its whole input with the
  renderers' reuse-path input, which does not carry `layout`/`maxRows`
  (those are component-owned). From the second `updateArgs` frame on,
  `renderWritePreview` read `visibleWidth` off `undefined` and the
  uncaughtException took the whole pi process down — every session that
  streamed write arguments crashed within minutes, with no visible error
  (the stack printed while the alt-screen was being torn down).
- Fix: `update()` now MERGES the partial input over the existing one
  (component-owned fields survive), plus a defensive fallback in
  `renderWritePreview` that degrades to ASCII layout ops if `layout` is
  ever missing — a display renderer must never kill the host process.
- Regression test added (`write-stream-crash.test.mts`): the real host
  flow (`ToolExecutionComponent.updateArgs` → `render` × 4 frames) no
  longer crashes; verified to fail against the broken `update()`.

## 0.8.1

Fix round on the 0.8.0 UI owner: structured Writing header, physical-row
streaming preview, event-driven phase feed, real thinking expansion, and the
document-edit diff surface. Display-only boundary unchanged.

- Writing header restored: the write CALL slot always owns a structured
  `• Writing <path>` header with a stage line (`Receiving content · preview,
  not yet committed` → ready → writing file). The live preview is a body
  UNDER the header — the 0.8.0 early-return that replaced the title with a
  bare preview once the first content chunk arrived is gone. Final results
  collapse to `Added/Edited/Wrote` with the result slot owning the body.
- Physical-row tail budget: `renderWritePreview` now wraps FIRST (full
  gutter + line-number deduction) and keeps the newest TERMINAL rows, so an
  early 1800-char logical line can no longer freeze the tail — the newest
  received character is always visible (0.8.0 measured: tail invisible at
  ≥128 KiB prefixes; now visible at 16 KiB–1 MiB, same per-frame cost).
- Event-driven phases: the Working line now follows the real
  `assistantMessageEvent` stream (`thinking_start/delta/end`, `text_*`,
  `toolcall_start/delta/end` + tool name at `contentIndex`). A stale
  thinking block in the accumulated message no longer keeps "Thinking" lit
  while write arguments stream — the status shows `Writing`.
- Real thinking expansion: the automatic collapse-to-label behavior was
  REMOVED. The default policy is `thinking: full/full` (config
  `codex-appearance.json`); thinking bodies stay open after
  `thinking_end`/text/tool start; Ctrl+T / clicks keep working through the
  host. The 0.8.0 adapter bug that overwrote EXPANDED thinking Markdown with
  a `Thought for …` label (broken `isCollapsedLabel` shape test) is fixed —
  the display layer never rewrites a thinking body into a label.
- semanticRuns host parity: an EMPTY text block now breaks a thinking run
  (barrier run), like the host rebuild loop; toolCall blocks between
  thinking blocks also split runs.
- Document edits use the Codex diff surface: the EXACT builtin edit
  tool's `renderShell: "self"` is now taken over (same structured
  `• Editing/Edited <path>` + full-row add/remove backgrounds as code
  edits). Third-party self-shells and unknown sourceInfo still back off;
  the ownership checks were not relaxed for them.
- Config wiring: `thinking.streaming/completed/rail` and
  `writePreview.enabled/rows` are actually applied (`rows` = body budget,
  `enabled: false` keeps the header and drops the live body). `/codex-ui`
  surfaces the effective values. Zentui registry probe removed (uninstalled).

## 0.8.0

The standalone Codex-style Pi UI. This release makes pi-codex-appearance the
single owner of the main-interface chrome (composer frame, footer, header,
working state) after the user uninstalled pi-zentui — no co-ownership designs,
no zentui fallbacks. Same display-only boundary as before: tool data, args,
results, model context and session message content are never touched.

- Interaction clock: ONE monotonic clock per user-visible interaction, opened
  on the first `agent_start` of a chain and closed on `agent_settled`.
  Auto-retries, compaction gaps and queued continuations do NOT reset it
  (`agent_end` only closes the open thinking interval). Phases (Thinking /
  Writing / Working / Waiting for input) derive ONLY from real content kinds
  (thinking/text/toolCall blocks, real write-args streaming), never from text
  heuristics. A 1s ticker drives `Working · 38s` in the native working-status
  slot; the timer is unref'd and torn down on settle/shutdown.
- Worked-for summary: after `agent_settled`, a dim Codex-grammar summary line
  (`Worked for 1m 05s · thought for 19s · ↓1.2k ↑8k`, `Interrupted after …`,
  `Failed after …`) is shown and — via the single granted UI exception —
  persisted as a namespaced CustomEntry (`pi-codex-appearance:interaction-
  summary:v1`) with its own registered renderer, so it survives session
  restore. Deduped per interaction; `summary.persist: false` or `--no-session`
  degrade to volatile display only.
- Chrome slots through public host APIs only, each identity-tracked for a
  clean hand-back: editor factory (Codex-look composer: accent border,
  paddingX 2, working status stays embedded; stock input behavior, IME,
  autocomplete and keybindings untouched — the Codex '›' per-line prefix is a
  recorded deviation: the Editor pipeline has no safe per-line hook), footer
  (model · effort · cwd, context % right, external `setStatus` items kept),
  minimal real-identity header (Pi + codex-appearance + model/dir; never
  impersonates OpenAI).
- Config: `<agentDir>/codex-appearance.json` (safe defaults; kill switch
  `enabled: false`; feature toggles `thinking`, `writePreview`, `working`,
  `summary`; malformed values fall back per-field with a warning).
- `/codex-ui` diagnostics: per-feature status (chrome / transcript /
  decorations / interaction clock) with the real cause per feature; no
  single-reason masking of partial failures.
- Thinking automation: once a thinking run closes (first text/toolCall after
  thinking, or message_end), the collapsed label is enriched with the measured
  duration (`Thought for 19s (ctrl+t to expand)`). The host's own visibility
  override map stays the sole owner of collapse state — user clicks always
  beat the automatic default.
- 0.7.x defect fixes folded in: tool-call-only `message_update` growth no
  longer closes the exploration group or marks assistant text; every non-empty
  text block is its own semantic run (consecutive thinking merges only when
  truly adjacent); thinking rail unwrap restores the host's original node
  verbatim on dispose/rebuild.

## 0.7.0

Fixes and additions on top of 0.6.0, same display-only boundary: tool data,
args, results, model context and session files are never touched.

- Separator persistence fix (the 0.6.0 defect): the separator plan was consumed
  once (takeTextPlan) and the inserted line was dropped by the host's next
  `updateContent()` rebuild. Plans are now STABLE identities (`generation:seq`
  message keys + open→sealed aliasing) resolved by display-order events; the
  assistant coordination layer re-coordinates the rebuilt subtree after EVERY
  `updateContent`, re-attaching exactly one separator per text run. 100
  streaming updates → exactly one line throughout. The fragile host source
  fingerprint check was replaced by a structural contract (descriptor shape +
  verified host v0.85.1), so benign patches (e.g. zentui) no longer block
  installation and diagnostics are per-feature.
- Thinking rail: a narrow static `▏` rail (accent teal, `|` for no-color) on
  every semantically-typed `thinking` block. Implemented as a width-aware
  wrapper around the host's thinking component INSIDE the existing MouseRegion,
  so click-to-collapse, streaming and geometry keep working; rail offset is
  compensated for mouse coordinates. English text or "Writing…" strings are
  never classified as thinking. If pi-zentui's thinking display takes over
  (detected via its prototype patch registry), our rail stays passive.
- Write live preview: while the model is still streaming a write tool call's
  arguments, the call slot renders the received `args.content` prefix in
  real time (host `updateArgs` → `renderCall`), with a dim stage label
  (Receiving content / Content ready / Executing / Written / Failed-aborted ·
  "preview, not yet committed"). Bounded rolling tail (8 logical lines,
  ≤12 screen rows), CJK/ANSI-aware wrapping, incomplete-UTF-16-safe, expandable
  to the full received prefix. Collapses to the verified-diff result on
  completion. No disk writes, no extra tool executions; aborted runs keep the
  received draft with an honest state label.
- Duplicate image totals fix: with 0.6.0's grouping, stale per-member
  components kept their own accumulated count (`1 image` repeated per member).
  The aggregate notice now resolves through the shared plan (only the CURRENT
  last member shows the total, refreshed on every append via dirty-view
  invalidation); per-member payloads and expandability are unchanged.
- Host field completion: `argsComplete`/`executionStarted` are read from the
  real `ToolExecutionComponent.getRenderContext()` (verified v0.85.1).

## 0.6.0

Transcript presentation release: serial exploration grouping, the
tool→assistant-text separator, and full-body output dimming. Display copy only
— tool data, args, results, model context and session files are never touched.

- Serial exploration grouping: consecutive builtin read/grep/find/ls calls
  (serial or parallel, across any number of tool-call-only assistant messages)
  share one `• Explored/Exploring` header. The first member owns the header and
  `  └ ` gutter; later members draw a four-space row with no leading spacer.
  Membership survives completion (the group stays open until a semantic
  boundary), and the aggregated image notice (counted from real image blocks,
  never filenames) prints once per group. Ownership checks (`sourceInfo`) keep
  third-party renderers out; failures split the group and stay visible.
- Tool→assistant-text separator: a light width-aware `─` rule (dim, ASCII
  fallback for no-color) before the first non-empty assistant text that follows
  tool activity. One line per boundary; streaming deltas, final replacements,
  history replay and re-renders never duplicate it. Thinking is never moved or
  hidden; conservative split on visible thinking keeps the structure honest.
- Output body dimming: `renderShellResult` now dims the ENTIRE body (prefix +
  text) through a small SGR state machine (`styleToolOutputLine`) instead of a
  scoped prefix dim. Source colors (truecolor/256/16) survive; inner resets
  (`0m`, empty `m`, `22m`) re-acquire our DIM; SGR parameters like
  `38;2;0;22;39` are never misread as resets; no-color emits no SGR; DIM never
  leaks past the row.
- New modules: `transcript-state.ts` (pure display-order projection), 
  `transcript-adapter.ts` (scoped, ownership-checked prototype decorations with
  full restore), `output-style.ts` (SGR dim composition). `explore.ts` now
  exposes separate header/member builders. New event listeners are read-only
  (`message_start/update/end`): no context mutation, no new storage.

## 0.5.0

Runtime correctness release: the two-slot combination contract, physical-row
budgets, honest write states, a single diff renderer, and pipeline-wide color
handling. Display copy only — tool data, args, results and session files are
never modified.

- Two-slot combination: the call region renders the title/command once and the
  result region renders only output. Fixes the duplicated "Ran" header (the
  old `formatCall` + `renderShellRow` double path) and unifies the old and
  rich renderers behind one implementation per region.
- Physical-row budgets (`VisualRow`): wrap before truncation, every wrapped
  row costs one, ellipsis rows included in the budget. Fixes NaN/`+0 lines`
  from mismatched `lines`/`rowCounts`, restores streaming tails (partial
  output), and makes expanded mode wrap at terminal width instead of
  returning over-wide lines or truncating the command.
- Write five states: `Added (+N -0)` / `Edited (+A -D)` / unchanged /
  unavailable / failed — every state shows expandable content, the failed
  state marks attempt content as "not written", and no diff is fabricated
  when no reliable pre-image exists.
- Tracker honesty: exact builtin ownership via `sourceInfo`
  (`source=builtin`, `path=builtin:write`), expected-content verification
  after the tool finishes, bounded reads (stat/size/type first), the mature
  line-diff implementation with input budgets instead of unbounded 2D LCS,
  and a context window computed from change indices without backward drift.
- Single diff renderer: one-line-number parser (digits after the first
  number stay content, indentation preserved), padding before the background
  reset so surfaces fill the row, syntax colors kept on delete rows under a
  dim overlay, and a structured style pipeline instead of regex-assembled
  control codes.
- Pipeline `ColorContext` resolved once (NO_COLOR / FORCE_COLOR 0-3 /
  COLORTERM / terminal capabilities): truecolor, 256, 16 and none modes share
  one resolver; exploration rows no longer hardcode truecolor while shell
  rows read the environment.
- Bash highlighting fixes: command position re-established after control
  operators (`a; echo b` colors the second command), heredoc bodies carried
  across lines (`<<EOF`, `<<-EOF`, `<<'EOF'`), plain spans get the Mocha
  base foreground, and oversized lines are truncated ANSI-aware (no split
  escape sequences, no dropped source text).
- Real-entry tests: host smoke drives Pi's `ToolExecutionComponent` (one
  structural title per toolCallId, mouse expand/fold through the component,
  third-party `write` back-off with zero file reads, teardown restore) plus
  a layout golden matrix (12 commands × 9 widths, CJK/emoji/ANSI outputs,
  resize round-trips). Preview now runs through the production two-slot
  renderers instead of bypassing them.

## 0.4.0

- Catppuccin Mocha syntax palette constants (`palette.ts`) with truecolor →
  256 → 16 degradation and a safe SGR filter.
- Lexical-state-aware bash tokenizer (`bash-lexer.ts`) for command words,
  flags, strings, numbers, comments, heredoc starts and backslash
  continuations.
- Width-aware exec-cell shell layout (`shell.ts`): `  │ ` command
  continuation, `  └ ` output block, middle truncation with expand hints.
- Codex-layout diff renderer (`diff.ts`) with line numbers, signs, full-row
  surfaces and hanging indent; structured file-change rows (`file-change.ts`).
- Ephemeral write tracker (`write-tracker.ts`) with pre-image snapshots for
  builtin writes only.

## 0.3.0

- Rebuild edit diffs to match the supplied Codex CLI screenshot: line number first, then gutter sign and content.
- Use Codex dark truecolor diff surfaces exactly: add `#213A2B`, delete `#4A221D`.
- Fill changed-row backgrounds to the full tool-row width, including every physical wrapped continuation row.
- Wrap diff content independently and apply a hanging indent so wrapped text stays aligned under the content column.
- Keep context rows background-free and render Pi's already-compact edit context window in full instead of truncating it a second time.
- Dim deleted content while retaining red/green gutter signs and same-redraw `(+N -N)` counters.
- Keep the rich diff renderer presentation-only; no tool/result/context mutation is introduced.
- Expand formatter tests for Pi diff parsing, exact RGB SGR output, width fill, hanging indentation and rich-component delegation.

## 0.2.0

- Enable `index.ts` by default; remove the separate optional entry.
- Switch builtin-owned tool rows to compact self-shell layout instead of changing only card colours.
- Add Codex-like `Running/Ran`, `Exploring/Explored`, command gutters, folded successful exploration, streamed tail previews and completed head/tail previews.
- Add same-redraw edit statistics, coloured diff previews and truthful write-content previews.
- Add native PowerShell display support and optional host command syntax highlighting.
- Preserve the stock constructor child tree and restore it on unload; repaint pre-existing rows when activating.
- Extend tests for default activation, shell geometry, owner changes, history, image order, same-redraw state and failures.
- Include generated ANSI/HTML/PNG formatter previews and the one-step local GitHub publication script.
- Keep third-party renderers, context middleware, tool execution, working timers, editor/footer and thinking untouched.

## 0.1.0

Initial derivative with theme-only default and opt-in builtin formatting. Superseded by 0.2.0's default compact transcript.
