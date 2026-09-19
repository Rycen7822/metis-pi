# Changelog

## 0.16.0

架构 + 新子插件（docs/0.16.0-todo-plugin-plan.md 为权威计划）：

**agent-stuff 布局**：包 manifest 改为 `pi.extensions: ["./extensions/*.ts"]`（glob，
同 mitsupi）——`index.ts` → `extensions/appearance.ts`，vendored goal 入口移到
`extensions/goal.ts`；src/ 路径不动，323 个展示测试零改动；pty harness 零改动
（`pi install <repo>` 由 pi 解析 manifest）。后续子插件 = extensions/ 下一个新文件。

**codex-todo 子插件**（融合 rpiv-todo / pi-goal-x / pi-agent-extensions 三方分析）：
- 数据：4 态状态机 + 显式转移表 + no-change 结果（防模型重试循环）；扁平输入建树；
  父状态渲染期推导不落库；complete 默认门禁（未完成子任务 + 证据，可选证据文件存在性）；
  blockedBy 增量 API + waits-for 环检测（子等父合法）；claim/release + force；
  skip 级联留痕；磁盘单事实源 `.pi/codex-todos/tasks.json`（version 字段、原子写、
  损坏自动归档、跨进程锁 30min TTL、gcDays GC 重挂幸存者）。
- LLM 接口：单工具 action 分发（冻结 ABI），校验错误抛出并附纠正提示，schema
  description 兼任 guidance。
- 常驻面板：setWidget register-once + getter 闭包工厂；稳定高度 latch；行预算
  纯函数（先丢已完成再截断 + "+N more"）；已完成下 turn 延迟收起；折叠态写盘；
  ctrl+shift+t 折叠；零轮询。
- 全屏 overlay：命名键位导航；space/s/r/x 动作；错误闪现不崩；与 widget 共享 store。
- 命令：`/codex-todo`（列表/开 overlay）、`/codex-todo-doctor`（只读诊断 + gc）。
- 部署注意：与 pi-agent-extensions 的 todos 扩展工具同名，需禁用对方 todos；
  存储目录刻意不同名（`.pi/codex-todos` vs `.pi/todos`）。

验证：368/368（新增 45 个 todo 测试）、check 0 error、host-smoke 含 todo 入口冒烟、
pty 新增 stage 3c（mock 模型调 todo 工具 → 屏幕出现 "Todos 0/1 done" 面板 + store 落盘）。

## 0.15.5

**静默修复：subagent 启动时输入框被 selection-copy 的 "already-owned" 警告刷屏**（用户报告：每次 pi 启动 subagent，输入框就被两行 `pi-codex-appearance: selection-copy prototypes unavailable (markdown=already-owned …)` 占满）。

- 根因：selection-copy 包的是 pi-tui 的**类原型**（进程级单例），owner 标记用 `Symbol.for`（同为进程级）。父 session 激活时已完成 wrap；subagent session 在同进程内**第二次激活**本扩展时，wrapPrototypes 看到自家标记 → 全部 "already-owned" → `installed: false` → extension.ts 向 stderr 写警告。功能本身无损伤（复制能力来自父 session 的 wrap，全局生效），纯噪音。
- 修法：`wrapPrototypes` 现在区分三种状态并在 details 里标注 —— `on`（本次包上）/ `self`（自家兄弟激活已包好，视为成功）/ `blocked`（密封原型或外来 render 替换，才算失败）。`installed` = 全部 on-or-self；只有 blocked 才写 stderr。owner 符号提升为五个具名导出（MARKDOWN/TEXT/BOX/CONTAINER/MOUSE_REGION_COPY_OWNER）。
- 顺带根治 chrome footer 用例的残余 flaky：不再用固定 settle 赌异步基线读的完成时序，改为**两波编辑**——无论第一波被折进基线与否，第二波都同时带 +/- 两种符号，6 秒预算内帧上必现染色段落（精确计数由 git-changes 单测层钉死，此用例只证管线）。
- Gate：323/323 ×4 连跑、check/check:core 0 error、host-smoke PASS、pty rc=0、verify rc=0。

## 0.15.4

**行为变更：footer 增删统计在 commit 后清零**（用户明确要求："commit 之后工作树应该是干净了，要清空数据"）。

- 旧口径（0.13.0 起）：diff 基准钉死在 **session 开始时的那个 commit**，中途 commit 不会抹掉累计 —— 但代价是 commit 后数字永远冻住（工作区 vs 老 rev 仍包含已提交内容）。真实复现：改文件 `+4` → commit → 数字冻结在 `+4` 不再更新。
- 新口径：每次读取重新解析 HEAD；HEAD 一挪（commit / amend / rebase / pull），用 `git diff oldRev newRev --numstat` 把**已提交的部分从基线里折掉**（`foldCommittedDelta`：已提交路径扣除其提交量、完全提交的路径离开基线、被提交的 untracked 条目清除）。footer 只保留**仍未提交**的 session 改动 —— commit 即清零；commit 后的新编辑照常被计入（不会吸进基线、也不会对着老 rev 冻结）。unborn HEAD 的首次提交同样触发清零（`diff-tree --root` 全树折除）。
- 折除读取失败时退回以当前工作区重建基线（宁可瞬时不报，不留陈旧数字）。
- 测试：fake-exec tracker 用例与真 git 用例双双改写 —— commit → `0/0`、commit 后编辑 → 只计新改动（真 git 复现脚本 `/tmp/gc-repro.mjs` 四步全过：基线 0 → 脏 +4 → commit 清零 → 新编辑 +3）。
- 语义文档同步：模块头注释、`sessionChangeStat` 注释、README 两处口径描述；0.13.0 的 CHANGELOG 条目保留为历史。

## 0.15.3

第三轮：diagnostics.ts 结构重组（`/codex-ui` 报告本身一字未改）：

- 原来 handler 内联 ~30 个巨型模板行（最长 400 字符、嵌套三元），现按报告段落拆成单段构建器（composer/working/model/context/session/cache/speed/interaction/outcome/quota/chrome/transcript/decorations/thinking/margin/glyphs/config/resources/git-changes/selection-copy/history），handler 只剩组装；共享小格式化原语（fmt/pct/seconds）提到模块级。
- 可读性修复：modelLine 三次 `getModel()` 调用合一；configLine 的 working/footer 段改为部件数组 join；报告头版本兜底提前为命名常量。
- **字节级等价是硬验证**：独立 harness 在重构前后各跑一次完整报告（含 refresh-quota 参数分支与无会话分支）并 diff 为空；pty 逐行断言 `/codex-ui` 输出也再次通过。>160 字符行 19 → 6（剩余 6 行均为报告字符串本身，无法再拆）。
- 全 gate 复跑：323/323、check/check:core 0 error、host-smoke PASS、真实 TUI pty rc=0、verify rc=0。
- 其余长行巡检结论：renderers/extension/selection-copy 等处剩余长行均为 import 列表、类型联合或单表达式，按"风格churn 不拆"原则保留。

## 0.15.2

第二轮架构精简（行为完全不变，全 gate 复跑通过）：

- **整个删掉的模块**：`src/file-change.ts`（56 行，全部导出零消费者 —— 唯一的外部引用是 renderers.ts 的类型再导出层，一并删除）。
- **死代码**：surface.ts 的 `surfaceSupported`（零消费者，含内部）；output-speed 的 `SPEED_MIN_TOKENS`/`SPEED_MIN_PLAUSIBLE`（仅内部使用的可调参数，降为模块私有）；bash-lexer 的 `atScriptStart` 占位概念（`tokenizeBashLine`/`highlightBashLine` 两个参数都是 `void` 掉的占位，连内部调用一起清掉）；transcript-state 的 `messageKeyFor` 第一个参数（从未使用）；working.ts 四个 shimmer 常量降私有；turn-summary 渲染器的 `cacheRead/cacheWrite` 死字段（持久化 schema 保留，渲染契约窄化为 `SummaryLineSnapshot`）。
- **activate() 减负 ~140 行，两处职责归位**：
  - 六个快照构建器（footer/working/composer 的 show 与 snapshot）提取到 `src/chrome/snapshots.ts`（`createSnapshotSource`）——纯数据装配，activate 只做接线；
  - `/codex-ui` 诊断命令（glyphStatus/selectionCopyLine/约 30 行状态行）提取到 `src/diagnostics.ts`（`registerDiagnosticsCommand`）——它是所有子系统的纯消费者，独立成模块后 activate 的闭包只剩生命周期与事件编排。
- 验证：`npm test` 323/323、`check`/`check:core` 干净、host-smoke PASS、真实 TUI pty rc=0（pty 逐行断言 `/codex-ui` 输出，证明提取后字节级一致）、`npm run verify` rc=0。

## 0.15.1

内部精简（行为完全不变，无用户可见变化）：

- **去死代码**：adapter.ts 里两条返回相同的 `renderShell === "self"` 分支（含一段重复注释）；diff.ts 的 `DIM_ON/INTENSITY_RESET/BG_RESET` 再导出、`CODEX_DIFF_DARK_*_BG`、`renderCountSummary`；write-tracker 的 `DiffBudget`；write-preview 的 `WRITE_PREVIEW_BODY_ROWS`；ui-metrics 的 `WORKING_PHASE_LABEL`；config.ts 的 `SUMMARY_ENTRY_TYPE`（与 turn-summary 的 `SUMMARY_CUSTOM_TYPE` 同值双名的那份）；extension.ts 的 `formatTokensCompact` 再导出；transcript-state 的 `currentGeneration`/`currentSessionKey`/`hasMessagePlan`/`EXPLORATION_TOOLS` 静态成员；segments.ts 的 `planFits`/`segmentsToText`（`planWidths` 降为内部）；composer-metadata 表面接口里从未使用的 `paintGlyph`；selection-copy 模型里从未被构造的 `"paragraph"` 断行类型；controller 里从未被读取的 `primaryScrollView` 类型字段。
- **收敛重复实现**：usage 去重键语法（`provider:responseId` / `m-${timestamp}`）由 usage-ledger 导出的 `usageKeyOf` 单点拥有（extension 实时确认与 ledger 回放共用，回退策略仍各自本地）；消息 content-block 归一化由 transcript-state 导出的 `normalizeMessageBlocks` 单点拥有（extension 事件边界与 transcript-adapter 渲染适配共用）；scroll-view 布局树查找由 serialize 导出的 `findScrollViewBox` 单点拥有（serializer 锚点与 controller 共用）；header 与 turn-summary 的 lazy theme-probe 画笔下的 `palette.resolveThemePainter` 单点拥有；`LayoutOps` 成为 `DiffLayoutOps` 的类型别名（同构双接口合一）。
- 验证：`npm test` 323/323、`check`/`check:core` 干净、host-smoke 与真实 TUI pty 全过、`npm run verify` rc=0。

## 0.15.0

- **移除 footer 的 `R`/`W` 缓存读写计数**，连带 `footer.showCacheReadWrite` 配置项。会话累计的 cache-read 会随长上下文缓存迅速膨胀（本机实测：656 个请求合计 112,334,848，中位 15.9 万/请求），而 OpenAI/DeepSeek 风格的提供商没有 cache-write 计数器，`W` 恒为 0 —— 两个数字占着宽屏右端却不解释任何可行动的决策。`cache NN%`（最近一次请求的命中率）保留：它才是"缓存有没有生效"的可读信号。
- 清理范围：footer 段与 P2 降级档（窄屏阶梯现在是 缩短目录 → 两行）、`FooterShow.showCacheReadWrite`、配置解析、`/codex-ui` 的 `session Σ` / `interaction usage` 行里的 cacheRead/cacheWrite 数字与 `config` 行的 `rw=`。`UsageLedger`/`UiMetrics` 仍照常解析并累计缓存字段 —— 存活的 `cache NN%` 与交互摘要的持久化 schema 依赖它们；配置里若还留着 `footer.showCacheReadWrite` 会被忽略（不报错，其余键照常生效）。
- 测试：`test/chrome.test.mjs` 宽屏用例从断言 `R10k` 存在改为断言其不再出现（回归守卫），`show` 对象同步收窄。

## 0.14.0

- **修复 emoji 字形覆盖相邻字符**：`✔`/`✖` 这类可被 emoji 字体接管的符号，终端只前进 1 格，但 emoji 字形宽约 1.6 格且合成在文字层之上 —— 用户截图里 `grep -n "✖\|# fail"` 显示成 `✖|# fail`（反斜杠被盖）、`✖ peek:` 显示成 `✖peek:`。渲染层在 frame 写入终端前给默认字符集 `✔ ✖ ✓ ✗ ⚠` 补 U+FE0E 文字呈现选择子（像素级证据：✖ 墨迹 24px vs 格宽 15px；会话日志确认反斜杠一直在内容里）。
- 实现为 **frame 级最后一跳**：只改写入终端的字节流，组件渲染/会话记录/选区复制全部原样（复制逐字精确的 161 字符 pty 用例回归通过）；SGR/OSC 8/OSC 52 转义序列逐字保留（URL 里的 ✔ 不会被改写）；显式 U+FE0F 的 emoji 请求被尊重；宽度中立（pi-tui 宽度表中 VS15 为 0 宽，host-smoke 用真实 `visibleWidth` 断言）。补丁挂在 TUI 的 terminal 原型上，owner-symbol 幂等，`captureTui` 的重试路径会覆盖新实例。
- 配置：`glyphs.textPresentation`（默认 true）+ `glyphs.include`（追加单字符，最多 32 个）；`/codex-ui` 新增 `glyphs:` 行（applied/原因、字符集、frames/changed 计数）。
- 测试 315 → 323：`src/glyph-presentation.ts` 8 例（CSI/OSC/BEL/ST 边界、选择器不重复、显式呈现尊重、escape 逐字、原型级幂等安装、实例级 write、非字符串写入透传），host-smoke 增补真实 pi-tui 帧的宽度中立与转义完整性断言，pty 新增阶段：工具命令与输出里的 ✔/✖ 在真实 TUI 中均带选择子、屏幕无任何裸符号、诊断报告 frames>0/changed>0。

## 0.13.0

- **修正 footer 的增删统计口径**：`+A -D` 现在是**本 session 的累计绝对增删**，不再是"工作区相对 HEAD"的快照。旧口径下，session 中途的 commit 会把已完成的改动从数字里抹掉，剩下的零头看起来就像"净变化"（文件 A `+11 -9`、B `+6 -5` 显示成 `+3 -0`）；现在两者都是 `+17 -14`。这也解释了"很多改动没被统计进去"。
- 新口径：session 第一次读取是**基线**（基线之前的未提交改动不算 session 的），之后每次都跟 **session 开始时的那个 revision** 做 `git diff --numstat`（中途 commit 不归零；`git checkout`/stash 撤掉的工作也会如实消失）；未跟踪文件按基线之后**新增的行数**计入；单文件内永远是绝对新增/绝对删除，不做净差。文件从 untracked 变成 tracked（session 里被 commit）时，基线行数依然不算 session 的，只有增量计入。
- **所有写入者都被统计**：agent 工具、bash/sed/python 脚本、另一个终端都走同一路径（git + 工作区），不依赖任何工具记账，也不需要它们出现在 transcript 里。真实 TUI 断言覆盖了"脚本写的文件"与"中途 commit 后数字不变"。
- **显示精确整数**：`+1.1k -81` 变成 `+1108 -81`（新增 `formatExactCount`，token 类数字仍用 k/M 紧凑格式）。
- **延迟改进**：除 2 秒轮询外，新增**活动触发的去抖刷新**（agent tick / settle，250ms，慢仓库按上次读取消耗自适应退避），活动期间实测 ~0.3s；未跟踪文件改为**流式计数 + size/mtime 缓存**（不再每次轮询同步读整份文件）；git 调用加 5 秒超时、`--no-ext-diff --no-textconv`（用户配置的 diff 驱动/字体转换不会再挂住轮询）、失败时保留上一次正确数字而不是清零。
- 测试 310 → 315（其中 `git-changes` 用例重写为 14 例）：`test/git-changes.test.mts` 重写为 14 例（`-z`/rename 解析、流式计数与缓存失效、基线语义含 untracked→tracked 迁移、失败保留、interval + touch + dispose），新增真实 git 集成用例（脚本改写、中途 commit、ignored/binary 跳过、`+17 -14` 永不坍缩为净值）与 pty 阶段（基线不显示、脚本写入 +3 -0、绝对 +8 -2、commit 后仍 +11 -2）。

## 0.12.0

- 思考块改为 **Codex 式行窗口**：`thinking.streaming` 新增 `"peek"` 并成为默认值，流式期间只渲染最新的 `thinking.peekLines`（默认 6，1..40）行，上方一行 dim 提示 `… N above of M lines (scroll · double-click for all)`；指针在窗口上滚轮可在窗口内滚动（到两端时事件落回正文滚动），滚回最新行恢复跟随。窗口只切片宿主已渲染的行，不重排 Markdown，rail / 高亮 / 复制归属与展开时一致。
- 鼠标手势对进行中与已结束的思考块统一：单击 = 折叠 ↔ 6 行窗口，双击 = 6 行窗口 ↔ 全展开（折叠态双击直接全展开）。单击延迟 300ms 落地以兼容宿主的"按组件身份识别双击"（重建会换实例），因此单击反馈有约 0.3s 延迟；这是同时支持两种手势的唯一可靠方式，`src/thinking-view.ts` 有对应用例。
- 自动折叠语义保持：思考结束时按 `thinking.completed`（默认 `collapsed`）折叠一次，此后用户的手势选择不会被后续重建覆盖（`foldOnEnd` 每轮只清一次）。
- 视图状态改为**每帧推导**而非存储：点击是唯一被记住的选择，其余由 `ended` + 配置决定，避免宿主重建/re-show 时留下过期的"已折叠"记录把窗口撑成全展开（调试过程中在真实 TUI 里复现并修复）。
- `/codex-ui` 的 `thinking:` 行增加 `peekLines`；`thinking.streaming: "full"` 可退回旧的流式全展开，`"collapsed"` 连流式期间也折叠。
- 测试 295 → 310：`src/thinking-view.ts` 的窗口/滚动/手势状态机 13 例，transcript 适配层的 peek 组合与 fold-once 2 例；`test:pty` 新增真实 TUI 断言（流式 6 行 + 提示行、滚轮在窗口内滚动并在滚回后跟随、单击折叠 ↔ 6 行、双击 6 行 ↔ 全展开）。

## 0.11.0

- footer 分支右侧新增**工作区改动行数** `+A -D`：相对 HEAD 的 tracked 改动（暂存 + 未暂存，`git diff --numstat HEAD`）加上未被 ignore 的未跟踪文件行数（`git ls-files --others --exclude-standard`），颜色与 diff 同行（`diffSignFg` 的 `\x1b[32m`/`\x1b[31m`，`NO_COLOR`/无颜色终端不带 SGR）。计数与分支同行，干净仓库不显示该段，`footer.showChanges: false` 可关闭。
- 移除 footer 右下角的**花费**显示，`footer.showCost` 配置项一并删除（`$0.00` 类文本不再出现）。用量 ledger 仍保留宿主上报的金额字段，只是不再渲染。
- 刷新策略：2 秒轮询 + 并发合并 + 仅数字变化时请求重绘；cwd 无 git 元数据时完全不 spawn git；未跟踪按 ≤200 个 / 单个 ≤256 KiB 计数，二进制与超限跳过；任何读取失败都只降级为“不显示”，不影响 agent 结果。`/codex-ui` 新增 `git-timer` 与 `git-changes` 行。
- 测试 284 → 295：`test/git-changes.test.mts` 9 例（解析、边界、tracker、真实 git 集成），chrome 新增“逐段布局 + 真实 git → 帧内绿/红”两例，`test:pty` 新增真实 TUI 帧断言 `(main) +3 -0`。

## 0.10.0

- 新增第二个入口 **`goal.ts`**：长任务 `/goal` 模式纳入本包维护（上游 [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/goal.ts` @ `122e299`，Apache-2.0）。`/goal <objective>`、`/goal pause|resume|edit|clear`、`create_goal` / `get_goal` / `update_goal` 工具、`goal` 类型 CustomEntry 状态链与 footer 状态行（`Pursuing goal (…s)` / `Goal paused` / `Goal complete`）行为与上游一致。
- 与上游的唯一差异：目标 active 期间 footer 状态**每秒刷新**（`syncStatusTimer`，暂停/完成/清空即停，`unref()` 不阻塞退出）。上游只在生命周期事件重算，而 Pi 的 `ctx.ui.setStatus` 只存静态字符串，导致在单次 agent run 内跑完的长目标全程停在 `Pursuing goal (0s)`。计时口径未变：定时器只读快照，时间仍只在 `agent_end` 记账，总时长与上游一致。
- 本包不变式显式收窄：`package.test.mjs` 的“无注册/无工具/无上下文改写”检查限定于显示层运行时（`index.ts` + `src/**`）；`goal.ts` 作为唯一的非显示入口由新增的 `test/goal.test.mts` 覆盖（命令/工具表面、逐秒刷新、暂停/完成/清空停表、不重复计时）。测试 279 → 284。
- 交付物同步登记：`tsconfig.json` 纳入 `goal.ts`（严格类型检查零改动通过），`package.json` 的 `files` 与 `pi.extensions` 登记该入口；因上游为 Apache-2.0，随包新增 `LICENSE-APACHE-2.0` 全文并在 `NOTICE` 登记归属与改动说明。

## 0.9.11

- footer 新增**实测输出速度** `N tok/s`，位置在右块最左、`↑input` 之前（用户指定的那一格）。数值 = 该条 assistant 回复**已确认的** `usage.output` ÷ **真实观测输出窗口**：首个→末个流式 delta 的跨度（不含 TTFT）；无非流式 delta（一次性投递/非流式 provider）时退回 `message_start`→`message_end` 窗口。不按回复字数估算、不取 provider 自报速率。
- 窗口 <300ms、无已确认 output token、或速率越界（<0.1 或 >5000 tok/s）时**不显示**任何占位（绝不出现 `0.0 tok/s`）；无 usage 的回复（中止/错误）不写入样本，保留上一条已测数值；session 结束清空。
- provider 中途上报**累计** output token 时（Anthropic 式 `message_delta`）同一公式实时刷新，OpenAI 兼容 provider 只在 `message_end` 出现并保留到下一次回复；实时值在 `message_end` 被确认值替换。新增 `footer.showSpeed`（默认 true）；`/codex-ui` 输出 `output speed: 38.5 tok/s (output=80 tokens, window=2.1s, scope=final)` 便于核对口径、token 数与窗口。

## 0.9.10

- 修复 fullscreen 模式下鼠标滚动时 diff 背景越过右侧留白：边距 Spacer 按终端高度绘制每一行，隔离宿主自动滚动条合成时泄漏的背景色，调整窗口大小时同步更新。
- 空白边距参与绘制后，复制仍保持中文软折行的逻辑连续性；未映射的空白不再触发原生复制回退。新增回归覆盖上下滚轮、红绿背景、滚动条隐藏与窗口缩放。

## 0.9.9

- fullscreen 历史按需翻页，保留窗口硬上限为 5,000 显示行（含翻页提示）。窗口外历史退出组件绘制路径，并释放派生渲染与复制缓存；session 原始记录保留。
- 恢复会话、跨页跳转和宽度变化按窗口行预算排版；阅读旧历史时维持位置，选区存在时固定复制内容。边界处单个超大组件受宿主整组件 `render()` 接口限制，仍可能完整排版一次。
- 统一工具行缓存实现，收窄 renderer 对会话状态的依赖，合并重复事件处理，移除未使用的状态、接口和复制数据；用量汇总按变更失效缓存。
- 简化测试夹具与重复用例，修复包内源文件检查遗漏子目录的问题，并启用核心代码的未使用声明检查。新增真实 Pi 历史窗口回归，覆盖预算、翻页、缓存释放、重排、阅读位置和选区。

## 0.9.8

- 架构简化：shell 缓存将宽度与行数组作为一个状态更新；结果组件统一输入类型，避免重复字段与额外可变状态。

- 修复大量命令输出后的滚动卡顿：shell 标题和结果按宽度缓存渲染行及其复制映射，内容更新、展开切换与主题失效仍通过宿主刷新，窗口宽度变化重建缓存。
- 工具行及 MouseRegion 发布本次实际渲染结果，复制对齐不再重复渲染这些组件；真实工具树中 shell 叶子由每帧 4 次降为 1 次。
- 补齐 Markdown/Text/Box/Container 复制包装器的防重复安装标记，避免重复初始化叠加包装；不可扩展的原型安全退避。
- 增加真实 Pi 组件回归，覆盖滚轮、流式更新、展开折叠、宽度、主题失效、旧帧及逻辑复制。真实 session 的 truecolor 滚轮回放从约 92.4 ms/帧降到 0.51 ms/帧，显示文本哈希一致（隔离渲染测量，不含真实终端绘制）。

## 0.9.7

深入对照 openai/codex 官方源码（tui/src/style.rs、markdown_render.rs、diff_render.rs、
exec_cell/render.rs、render/highlight.rs）逐项对齐颜色体系。Codex 的双层结构：
**状态/accent/markdown 内联 = 终端 ANSI 调色板**（用户终端实测 Campbell：绿 #13A10E、
红 #C50F1F、黄 #C19C00、青 #3A96DD，四种采样逐一吻合），**语法高亮 = syntect
Catppuccin Mocha**（深色终端默认主题）。据此修正：

- **accent #89b4fa → #3a96dd（ANSI cyan）**：codex `accent_style()` = `Color::Cyan.bold()`。
  影响内联代码（codex `code: cyan`）、列表符号、accent 边框、composer 提示符/footer accent、
  思考 rail、编辑器默认 accent。
- **探索行动词 → #3a96dd**：codex `exploring_display_lines` 里 `title.cyan()`。
- **error 红 #ef8b8b → #c50f1f（ANSI red）**：codex `"•".red().bold()` / `Color::Red`。
  影响错误圆点、Failed、diff 删除文本/计数。
- **diff 增绿 #86c995 → #13a10e（ANSI green）**：codex `style_add` 内容 `Color::Green`。
- **warning 黄 #e8c47a → #c19c00（ANSI yellow）**：codex `StatusTone::Attention = Color::Yellow`。
- **markdown**：链接 = cyan（`link: cyan().underlined()`，URL 段也用 link 色）；引用块 =
  绿色（`blockquote: green()`）；标题/加粗/斜体 codex 不加色，维持原样。
- **代码块语法高亮 → Catppuccin Mocha**（codex `adaptive_default_theme_selection`：深色终端
  默认 catppuccin-mocha）：keyword #cba6f7、function #89b4fa、variable #cdd6f4、string
  #a6e3a1、number #fab387、type #f9e2af、comment #6c7086、punctuation #9399b2。
  此前是 VS Code Dark+ 系（#569cd6/#dcdcaa/#9cdcfe…）。
- **保持不变**：diff 背景板 #213A2B/#4A221D（与 codex `DARK_TC_*_LINE_BG_RGB` 一致）、
  bash lexer 的 MOCHA 调色板（本来就是 Mocha）、Working 动画的 Mocha 蓝（codex 的
  working shimmer 无色相，蓝色是本插件保留的 accent 选择）、标题金色（codex 标题无色，
  属可选项）。

## 0.9.6

工具圆点状态色对齐 Codex（用户反馈：Ran/Explored 左侧小点饱和度太低；取样 Codex 圆点 = #13A10E 高饱和绿）：

- 主题 `success` `#86c995`（淡彩绿）→ `#13a10e`：`Ran`/`Wrote`/`Added`/`Edited`/`Explored`
  等完成态圆点变为 Codex 的高饱和绿；Writing 头部的 "Written" 阶段标签随之同色。
  `toolDiffAdded` 仍用原 `green` 变量，diff 文本色不变。
- `Explored` 头部圆点此前永远是灰色、`Edited`/`Wrote` 完成态也没有 success 分支——现在
  三态清晰：运行中 = dim、完成 = 高饱和绿、错误 = error 红。
- 顺带修复 `formatCall` 在探索/shell 早退前就绘制 marker 的重复圆点绘制。

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
