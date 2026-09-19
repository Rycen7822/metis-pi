# pi-codex-appearance

**默认启用的 Codex 风格工具转录界面。** 安装后，Pi 原生工具使用紧凑工具行、运行状态、探索记录、折叠输出与 diff 预览。模型、工具执行与上下文处理保持原有路径。

版本：**0.19.0**。面向用户当前使用的 classic Pi **0.85.1** 接口。0.16.0 起改为 **agent-stuff 式多扩展布局**：manifest 导出 `./extensions/*.ts`，`appearance.ts`（本主题，即原 index.ts）、`goal.ts`（长任务 `/goal` 模式，见 [/goal 长任务模式](#goal-长任务模式0100)）、`todo.ts`（**codex-todo 任务子插件**，见下方专节）是三个独立入口；0.17.0 起 manifest 再加一项 `./vendor/pi-codex-conversion/dist/index.js`——**Codex 转换层**（见 [vendored codex-conversion](#vendored-codex-conversion0170)）由本仓库自带并维护。四者共享一个 repo 但加载互不影响；其余部分仍是独立负责主界面外观的 Codex 风格转录界面（0.8.0 起，0.7.x 的 Zentui 协同方案已随 0.7.0 发布并废弃）。0.8.5 起输入区收敛为三块：

- **灰色 composer surface**（仍继承宿主 `CustomEditor`，编辑状态机零改动）：去掉整条 accent 边框，改为低对比 `#1f1f1f` 背景面（truecolor；ansi256 用最近灰阶；ansi16/NO_COLOR 无背景、保留布局）；首行两个 padding 格借用为 `> ` 提示符（格数不变，光标/鼠标/补全几何零偏移，`getText()` 不含该字符），空输入显示暗色 `Ask anything...` 占位；`↑ N more`/`↓ N more` 滚动指示保留。
- **Surface 内 metadata 行**（公开 belowEditor widget，与编辑区同一底色）：`模型 · 推理等级 · provider    ctx 已用/容量 · 占用%`，全部来自 Pi 真实公开接口（`ctx.model`、`ctx.thinkingLevel`、`ctx.getContextUsage()`），切换模型/等级即时更新。
- **紧凑产品 footer**：`目录 (分支) +新增 -删除   N tok/s · ↑input ↓output · cache 命中率 · Codex 5h 82% · week 64%`；分支右侧的 `+A -D` 是**当前未提交的 session 改动行数**（绝对值，不是净变化；用与 diff 相同的绿/红，始终精确到个位，干净仓库不显示；**commit 后即清零**）；`N tok/s` 是**实测输出速度**，位于右块最左、紧跟其后才是 `↑input`。窄屏按 优先级 降级（缩短目录 → 两行），P0/P1 永不整块消失；不与 metadata 重复显示 model/context。
- **Codex 式 Working 行**（aboveEditor widget）：`• Working (3m 36s · thinking 24s · esc to interrupt) · read`，`Writing…`/`Waiting for input` 相位，思考结束后 `thought for Ns`；克制的渐变彗尾 shimmer（亮头 + 连续渐隐尾：彗头 128ms/格悠闲扫过，32ms 高帧率驱动亚格强度渐变，truecolor only，NO_COLOR/ansi16 静态）；计时与动画分用两个定时器，settle 后归零；动画帧不扫 session、不读盘、不查 quota（实测 0.003ms/帧）。
- **真实 Codex 额度**（只读）：经本机已登录 Codex CLI 的 `codex app-server`（stdio JSON-RPC：initialize → initialized → account/rateLimits/read），`remaining = 100 − used`（永不混用方向）；超时/退出/异常全部有界并按类别进 `/codex-ui`；不读任何凭据文件、不请求私有 HTTP、不 scrape Codex TUI；quota 失败绝不影响 agent 交互与 outcome 判定。

- **有界历史窗口（fullscreen）**：仅让当前历史窗口进入昂贵的组件绘制路径，硬上限 **5,000 显示行**（含翻页提示）。滚到窗口顶部／底部继续滚动会按需加载上一段／下一段，并释放另一端的派生渲染缓存；session 原始记录保留。原生回到顶部／底部操作可跨页跳转；阅读旧历史时保留当前位置，新输出不会挤掉正在查看的行。恢复和宽度变化从当前窗口边界开始排版，达到行预算即停止；普通滚动复用窗口行。选区存在时固定已提交窗口，避免新输出改变复制内容；提交输入时解除选区冻结。宿主只提供整组件 `render()`，因此边界处的单个超大输出仍可能完整排版一次，再裁切并释放其完整缓存；5,000 行是保留窗口的硬上限，不是单次组件内部计算量的保证。宿主界面搜索作用于当前已加载窗口。
- **逻辑选区复制（0.9.0，fullscreen）**：鼠标选区后 Ctrl+C 复制**已选显示内容的逻辑文本** —— 视觉软折行合并（中文不补空格、英文按源空格桥接）、真实换行/空行保留、代码源缩进保留（宿主展示缩进与 diff 行号/gutter 不混入）、列表 marker / 引用首行边框 / diff 增删符号 / 代码围栏按所选列决定是否包含（语义前缀，不凭字符猜测）。无选区时 Ctrl+C 保持原生行为（清空草稿、双击退出）；纯装饰选区不写剪贴板、不清草稿；剪贴板失败保留选区与草稿。渲染时逐组件生成带来源映射的 sidecar（WeakMap 以渲染数组身份为键，天然绑定已提交帧），并与宿主真实输出逐行 diff —— 任何漂移只降级为原生提取，绝不猜。表格/未知 token/图片行按 conservative 回退；与 `pi-copy-soft-wrap` 共存时精确路径优先生效（加载顺序无关），`/codex-ui` 报告其存在。选区复制零新按键注入、零 prototype 工具执行改动；`selectionCopy.enabled` / `selectionCopy.ctrlC` 可关闭。

既有能力保留：运行时终止证据判定（v2 摘要 schema：stop=Worked / error=Failed / aborted=Interrupted / length=Ended·output limit / 证据不足=Ended；旧 v1 `failed` 显示 `legacy status unverified`，历史不改写）、极简真实身份启动头（运行时读取真实版本号）、`agent_start`→`agent_settled` 单一交互时钟、`Worked for … · thought for … · ↑↓` 结束摘要（可随会话恢复；`summary.persist:false` 走 footer 状态行临时路径）、thinking 光条（**0.12.0 起默认 `peek/collapsed`**：流式期间只显示最新的 6 行思路窗口，滚轮在窗口内滚动，结束后自动折叠；单击在折叠 ↔ 6 行窗口之间切换，双击在 6 行窗口 ↔ 全展开之间切换，Ctrl+T 仍是全局显示/隐藏）、write 实时预览（结构化标题 + 物理行尾部预算）、文档/代码 edit 整行背景 diff surface、探索分组。以 openai/codex 固定参考提交 1b83e5c 为视觉与行为 reference，全部仅作用于显示层。

配置：`~/.pi/agent/codex-appearance.json`（可省略，非法值回退默认、用户文件永不改写）。`enabled: false` 为总开关；`composer.surface` / `composer.promptPrefix` / `composer.metadata` / `thinking.rail` / `thinking.streaming`（`peek`/`full`/`collapsed`，默认 `peek`）/ `thinking.completed`（`collapsed`/`full`，默认 `collapsed`）/ `thinking.peekLines`（1..40，默认 6）/ `writePreview.enabled` / `writePreview.rows` / `working.elapsed` / `working.thought` / `working.tool` / `working.tokens`（默认 false）/ `working.animation` / `working.animationIntervalMs`（32..1000，默认 32）/ `footer.enabled` / `footer.details` / `footer.showCache` / `footer.showChanges` / `footer.showCodexQuota` / `footer.showSpeed`（默认 true） / `quota.codex`（auto/on/off）/ `quota.refreshSeconds`（30..3600，默认 120）/ `quota.timeoutMs`（默认 8000）/ `summary.enabled` / `summary.persist` / `selectionCopy.enabled` / `selectionCopy.ctrlC` / `glyphs.textPresentation`（默认 true）/ `glyphs.include`（追加字符）可分别关闭。诊断命令：`/codex-ui`（各数值来源、统计范围、终止证据、composer/working/footer/quota 组件真实状态；`/codex-ui refresh-quota` 手动刷新额度）。

**统计口径（三个范围不混淆）**：`ctx …` 是当前上下文占用（宿主实时接口）；`Σ` 是本 session 文件已记录的标准 usage 累计（assistant 消息 + compaction/branch_summary；本插件自己的摘要 CustomEntry 不计回）；`cache(last)` 是活动分支最近一条已确认请求的命中率 `cacheRead/(input+cacheRead+cacheWrite)`，session 加权比率在 `/codex-ui` 可查；`↑`/`↓` 沿用 Pi 归一化口径的 `usage.input`/`usage.output`（input 为不含缓存的输入）；`tok/s` 是**当前或最近一次 assistant 回复**的 `usage.output ÷ 观测输出窗口`（首个→末个流式 delta，排除 TTFT；无非流式 delta 时退回 `message_start`→`message_end`），窗口 <300ms、无已确认 output token 或速率越界时整段不显示（`/codex-ui` 同时给出 token 数与窗口长度，`scope` 区分流式中实时值与 `message_end` 确认值）；`+A -D` 是**本 session 未提交的增删行数**：session 第一次读取时的状态是基线（之前的未提交改动不算你的），之后每次都跟**当前的 HEAD** 比 —— **commit 会把已提交的部分从数字里折掉、工作区干净时归零**，只有仍未提交的改动继续累计；并且只统计**绝对**新增与绝对删除 —— 文件 A `+11 -9`、文件 B `+6 -5` 就是 `+17 -14`，永远不会被压成净变化 `+3 -0`；数字不做 k/M 缩写。所有写入者一视同仁：agent 的工具、bash/sed/python 脚本、另一个终端，都从 git 与工作区读取（不经任何工具记账）。未跟踪文件按 ≤200 个、单个 ≤256 KiB 流式计数（二进制与超限文件跳过，按 size+mtime 缓存，未变不重读）；git 调用有 5 秒超时与 `--no-ext-diff --no-textconv --no-optional-locks`（不会被用户的 diff 驱动或索引锁拖住），读取失败保留上一次正确数字而不是清零。节奏：2 秒轮询 + agent 活动触发的 250ms 去抖刷新（活动期间实测 ~0.3s，空闲 ≤2s）；取不到 git 元数据时整段不显示（`/codex-ui` 的 `git-changes`/`git-timer` 行给出同一口径、基线 revision 与轮询状态）。未知值显示 `—`，从不伪造为 0。

![由本项目渲染函数生成的预览，非真实 Pi 会话截图](docs/preview.png)

上图由 `src/renderers.ts` 的同一 diff layout 函数生成 ANSI 文本，再渲染到 HTML。0.4.0 的预览包含整行 diff 背景、悬挂缩进与语法高亮 shell 行；它仍不是完整 Pi 或用户全部插件的联合实测。

## 默认显示

```text
• Explored
  └ Read src/server.ts (lines 1–120)

• Ran npm test
  └ Running unit tests...
    … +24 lines (ctrl+o to expand)
    tests passed

• Edited src/server.ts (+2 -1)
  12  export function startServer() {
  13 -  server.listen(3000);        ← muted red full-row surface
  13 +  const port = Number(...);   ← muted green full-row surface
  14 +  server.listen(port);        ← muted green full-row surface
  15  }
```

- **命令执行**：`Running → Ran`，标题加粗。命令在换行**前**按 Codex Catppuccin Mocha 调色板做完整语法高亮（executable 蓝、keyword 紫、string 绿、number 橙、operator 青、parameter 红、builtin 红壳、comment/标点灰蓝）；continuation 行 `  │ ` 最多 2 个屏幕行。输出首行 `  └ `、后续行 4 空格，wrap 后最多 5 个屏幕行，超出做 middle truncation。错误前景标红。
- **文件探索**：`read/grep/find/ls` 使用 `Exploring → Explored`，动作动词使用 ANSI cyan，查询与路径之间的 ` in ` 使用 dim。成功输出默认折叠；点击工具行或使用 Pi 当前的工具展开快捷键可查看所有文本块。快捷键提示来自 Pi，自定义键位不会被覆盖。
- **文件修改**：`edit` 采用 Codex 式 `行号 + 空格 + +/- + 内容`：删除行整行背景 `#4A221D`，新增行整行背景 `#213A2B`（truecolor；ANSI-256 使用 22/52；ANSI-16 仅前景色），diff 正文按文件扩展名做语法高亮且前景 reset 不清除 diff 背景；换行后内容悬挂对齐到正文列，context 行无背景，Pi 自带的 compact context window 不再二次截断。
- **写入（write）**：内建 `write` 工具在 `tool_execution_start` 读取 pre-image、`tool_execution_end` 验证 post-image，只在可靠时呈现结果：新文件显示 `Added path (+N -0)` 与全绿新增面，覆盖写显示 `Edited path (+A -D)` 与真实 diff；二进制、超大、不可读、post 不匹配或任何不确定场景一律 fallback 到原始内容预览，**绝不伪造 diff**。追踪状态是 ephemeral 的（进程内存），不写盘、不进会话记录。
- **图像结果**：保留 Pi 原生图片显示路径，服从 `terminal.showImages`。关闭图片预览时显示轻量图片数量提示，不输出 Base64。
- **配色**：中性文字、灰色层次、红绿 diff 和错误色；shell 输出保留安全 SGR 颜色序列、剥离其他控制序列；主题不强制终端背景色。

每个工具调用保留独立的显示与展开状态，不跨调用合并结果。连续探索不会完全复现 Codex 的跨调用聚合。输入框、页脚、Working line、思考块、审批流程和快捷键沿用现有插件；本项目没有复制另一套完整终端客户端。

## 本地安装

解压本版本压缩包，然后执行：

```bash
pi install /绝对路径/pi-codex-appearance
```

重新启动 Pi。**紧凑转录布局默认生效，无需另行启用 optional 扩展。**

在 `/settings` 选择 `codex-appearance` 可同时应用中性配色。也可以只修改现有 `~/.pi/agent/settings.json` 的这个字段，保留其他内容：

```json
"theme": "codex-appearance"
```

原生工具采用 self-shell，因此即便仍使用原有 `dark` 主题，也会移除这些工具的外层卡片。第三方工具自带的布局继续保留；配套主题可以统一使用主题 token 的背景色，但不会强行覆盖插件硬编码的颜色。

若已经安装上游 `pi-codex-style-tools`，先移除上游包，避免它继续注册同名工具及改写搜索结果。移除旧包后重新启动。0.1.0 用户应移除自己额外添加的 `optional/format-tools.ts` 条目；0.2.0/0.3.0 都自动加载 `index.ts`。

## /goal 长任务模式（0.10.0）

本包第二个入口 `goal.ts` 提供长任务目标模式：`/goal <objective>` 设定目标，`/goal pause|resume|edit|clear` 管理状态，`create_goal` / `get_goal` / `update_goal` 工具只在被明确要求时由模型使用；目标状态（active / paused / blocked / complete、token 预算与累计用量）以 `goal` 类型 CustomEntry 追加进会话记录，恢复会话或切换分支时从当前分支重建，不依赖外部数据库。footer 左下的 `Pursuing goal (…s)` / `Goal paused` / `Goal complete` 由该扩展推送。

与上游的唯一差异是**逐秒刷新**：上游只在目标生命周期事件（创建/暂停/恢复/编辑/清空、`session_start`、`session_tree`、`agent_end`）重算并推送 footer 文本，而 Pi 的 `ctx.ui.setStatus` 只存静态字符串——因此在一个单次 agent run 里连续跑几十分钟的目标，会从创建（`0s`）到状态变更前一直不动。本包在目标 active 期间挂 1 秒定时器重新推送同一快照（`syncStatusTimer`；暂停/完成/清空即停，`unref()` 不阻塞退出）。计时口径未变：定时器只读快照，时间仍只在 `agent_end` 记账（`test/goal.test.mts` 有对应用例）。

来源：`goal.ts` 取自 [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) 的 `extensions/goal.ts`（Apache-2.0，@ `122e299`），按 Apache-2.0 §4 随包附带许可证全文（`LICENSE-APACHE-2.0`）并在 [NOTICE](NOTICE) 登记归属与改动，改动点标注在文件头。上游更新时按文件头的同一处说明重新套用即可（文件保持上游制表符缩进，便于对照同步）。

本扩展是本包唯一的非显示层入口：它注册 `/goal` 命令、三个目标工具，并监听 `session_start` / `session_tree` / `before_agent_start` / `agent_start` / `agent_end` / `context`。`index.ts` 与 `src/**` 的“不注册工具、不改写结果与上下文”边界不变（`test/package.test.mjs` 显式限定该范围）。不需要目标模式时，给本包加一条只含显示入口的过滤即可：

```json
{ "source": "git:git@github.com:Rycen7822/pi-codexy.git", "extensions": ["-goal.ts"] }
```

## 思考块交互（0.12.0）

流式思考默认渲染成 **6 行窗口**（`thinking.peekLines`，1..40）：显示最新的几行，上方一行 dim 提示 `… N above of M lines (scroll · double-click for all)` 说出被裁掉多少行；把指针放在窗口上滚轮即可在窗口内滚动（滚到两端时事件落回正文滚动），滚回最新行后恢复自动跟随。窗口只对宿主已经渲染好的行做切片，不重排 Markdown，也不重新着色，所以 rail、语法高亮和复制归属都与展开时完全一致。

鼠标手势对**进行中与已结束**的思考块是同一套规则：单击在"折叠 ↔ 6 行窗口"之间切换，双击在"6 行窗口 ↔ 全展开"之间切换（从折叠状态双击直接全展开）。单击会等一个 300ms 的双击窗口再落地——宿主按组件身份识别双击，而每次重建都会换掉组件实例，只有延迟落地才能同时保住单击语义和双击语义（`src/thinking-view.ts` 有对应用例）。思考结束时按 `thinking.completed` 自动折叠一次（默认折叠，与旧版一致）；折叠之后的手势选择不会被后续重建覆盖。

`thinking.streaming: "full"` 可以退回旧的"流式全展开"，`"collapsed"` 则连流式期间也折叠。窗口高度、提示行和手势都不影响计时口径：思路用时仍只在 `agent_end` 记账。

## 字形呈现（0.14.0）

`✔`/`✖`（U+2714/U+2716）这类"可被画成 emoji"的符号，终端只给它们前进 1 格（pi-tui 的宽度表同样按 1 格算），但 emoji 字体会把字形画到 ~1.6 格宽并合成在文字层之上 —— 于是 `grep -n "✖\|# fail"` 在屏幕上变成 `✖|# fail`（反斜杠被 ✖ 的笔画盖住），`✖ peek:` 变成 `✖peek:`。渲染层（frame 写入终端前的最后一跳）会给这类符号补一个 U+FE0E 文字呈现选择子，终端于是改用等宽字体画它们：1 格宽、单色、不再压住右边的字符。

- **只动显示**：写入终端的字节流里多了一个零宽选择子；组件渲染、会话记录、选区复制全部保持原样（`glyphs.textPresentation:false` 可整体关闭，复制逐字精确的 pty 用例会回归验证）。
- **宽度中立**：选择子在 pi-tui 的宽度表里是 0 宽（`[65024,65039,0]`），且插在布局完成之后，rail/背景/选区的列映射不会移动（host-smoke 用真实 `visibleWidth` 断言）。
- **转义序列逐字保留**：SGR/OSC 8 超链接（URL 里有 ✔ 也不会被改写）/OSC 52 剪贴板载荷都原样通过；内容里显式写了 U+FE0F（要求 emoji 形态）的不动。
- 默认字符集 `✔ ✖ ✓ ✗ ⚠`（等宽字体都带文字形态）；`glyphs.include` 可以追加，例如 `["⏺"]`。
- 不做的事：`✅`/`❌`/`🔴` 这类没有文字形态的符号不处理（强转会变成豆腐块）。

## codex-todo 任务子插件（0.16.0）

第三个扩展入口 `extensions/todo.ts`：带**常驻输入框上方面板**与子任务树的磁盘持久化任务列表。
设计融合 rpiv-todo（面板工程）、pi-goal-x（长任务推进）、pi-agent-extensions todos（持久化与认领）：

- **常驻面板**：`Todos 2/5 done` 标题 + 树形行（`○ ◐ ✓ ✗ ⚠︎` 状态符，有 blockedBy 时才显示 `#id`），
  完成后保留到下一 turn 再收起；全部完成即消失。
- **鼠标点击展开**：面板默认显示**三行任务**，超出时尾部折叠成 `+N more (a completed, b pending)`
  汇总行（先丢已完成、再截断未完成，保留 pending 优先）。**左键单击面板任意一行**即展开成完整列表
  （汇总行消失、标题变 `▴ · click to collapse`），**再点一次收回三行视图**。展开态写盘，重启保留；
  **右键（按下即触发，无需松开——Warp 等终端会吃掉右键释放事件）单击面板任意一行则手动隐藏**（隐藏态写盘，重启仍隐藏）；再打开一次 `/todos` 即恢复显示。
  面板无键盘快捷键——交互全部走鼠标（0.17.3 起移除原 `ctrl+shift+t`）。首帧锁定高度、实时更新不会缩行（防终端跳动），
  显式展开/收起则允许改高；刷新零轮询（store 变更才触发）。
- **子任务树**：模型提交扁平 `[{title, parentId}]`、扩展端建树（≤4 层、≤15 个）；父任务显示态由
  子树推导不落库；complete 默认**门禁**（未完成子任务 + 非空证据，可要求证据文件真实存在），
  证据记为 UNTRUSTED claim；blockedBy 增量增删、waits-for 环检测；skip 级联留痕。
- **subagent 认领**：claim/release（含 force 夺取），认领即 in_progress，跨进程文件锁保护写操作
  （30min TTL，过期锁自动归档）。
- **存储**：`<cwd>/.pi/codex-todos/tasks.json`（version 字段、原子写、损坏自动归档成
  `.bak-<ts>` 并空载，绝不让会话崩溃；`gcDays` 默认 7 清理已完成）。环境变量
  `PI_CODEX_TODO_PATH` 可整体搬迁。
- **交互**：`/todos` = 恢复面板（右键隐藏过的话）+ notify 打印文字任务列表
  （**0.17.5 起移除了原全屏 overlay 弹窗**——面板 + todo 工具已覆盖其用途，不再弹窗挡屏幕）；0.17.6 起新增 **skill-mux**：`/skill:a /skill:b 其他文字` 一条输入展开多个 skill（宿主只认第一个，此处补齐；0.17.7 起 `￥skill名` 是等价快捷触发符，可混用：`￥a /skill:b 文字`；0.17.8 起第二个及以后的 token 也有补全菜单——内置补全器只为首 token 弹菜单，此处补齐，`/` 与 `￥` 均可；0.18.1 起菜单弹出时机：`￥` 按下即弹，第二个及以后的 `/` 也**按下即弹**（根因：宿主只在行首自动触发 `/`，且补全查询返空会清掉菜单状态，状态一死 `/` 按键零查询；0.18.1 由 composer 在插入 `/` 后补发一次查询；0.18.2 去掉了 0.18.0 曾加的状态提示行，该位置不再多显示任何内容）；0.18.3 起多 skill 展开在转写区**合并成一条可折叠的 `[skill] …`**（宿主只解析一个 skill 块，后续块嵌套进第一块内部，模型仍逐字收到全部正文）；**0.19.0 起该条目可点击**——左键单击展开，再次单击折叠（ctrl+o 依旧可用；带 Shift/Ctrl/Alt 的点击仍交给文本选择））；`/todos-doctor`
  只读诊断（坏档归档、过期锁、GC）。模型侧是单 `todo` 工具 action 分发：校验错误抛出并附
  纠正提示（模型自我修正），无变更返回 `No change:` 结果（防重试循环）。

**部署注意**：另有两个同名扩展会抢占工具名 `todo` 与命令 `/todos`——mitsuhiko/agent-stuff 的
`extensions/todos.ts`（文件式 `.pi/todos/*.md`）与 pi-agent-extensions 的 `extensions/todos/index.ts`。
两者**必须禁用其一**（本插件撞名时只提示一次、不刷屏；工具名冲突是静默后写覆盖，命令冲突会退化成
`/todos:2`，所以不要靠运气）。禁用方式：settings.json 对应包的 `extensions` 数组里写
`"-extensions/todos.ts"`（`-` 前缀 = 强制排除）。当前的 settings.json 已按此配置。
存储目录刻意不同名 `.pi/codex-todos`，双装过渡期互不踩数据；如需迁移旧列表，把 `.pi/todos/*.md`
的内容转成任务用 `todo` 工具 `add` 即可。

## vendored codex-conversion（0.17.0）

`@howaboua/pi-codex-conversion`（Codex 风格的工具层：`exec_command`/`write_stdin`/`apply_patch`/
`view_image`/`notebook` + code/notebook 运行时）**已整包纳入本仓库**，不再依赖 npm 安装：

- `vendor/pi-codex-conversion/`：上游源码（321 个 `.ts`，**patch 打在这里**）+ 构建产物 `dist/`（提交进
  git，pi 直接加载，安装期零构建）+ 运行时资源（`vendor/tree-sitter-bash.wasm`、`js-tiktoken`、
  `code-mode/`、仅 linux-x64 的原生工具）+ `CHANGELOG.md`/`changelog.js`。
- **升级上游是显式动作**：`npm run vendor:sync`（拷新源码 → 重放 `patches/local.patch` → 重建 dist）。
- **patch 独立记账**：`vendor/pi-codex-conversion/PATCHES.md` 记每条改动的现象/根因/验证；
  `patches/local.patch` 是相对上游的合并 diff，`npm run vendor:patch` 重新生成。
- 出处、载荷裁剪（剔除各平台语音二进制与其它平台原生工具，因此**语音功能不可用**）与
  精确版本/commit 记在 `UPSTREAM.md`。
- 门禁：`npm run vendor:check`（类型检查上游源码）、`npm run vendor:smoke`（用假 pi 激活 vendored
  入口，断言 12 个工具注册且每个工具的 parameters 都是顶层 object）、`npm run vendor:fresh`
  （重建后 dist 必须无 diff，防"改了源码忘记重建"）。

**部署注意**：本包自带 codex-conversion 后，**必须卸载/禁用 npm 上的同名包**，否则两套工具同名注册
（工具名冲突是静默后写覆盖，命令会退化成 `xxx:2`）。卸载：`pi remove @howaboua/pi-codex-conversion`。

## 与现有插件的边界

### 与 pi-copy-soft-wrap 共存（0.9.0）

旧复制插件在 `TuiAltScreen.prototype.getActiveSelectionText` 上做启发式 unwrap。本插件的精确
serializer 安装在原型层并整体接管该入口（先加载者的启发式被精确路径替代，与扩展加载顺序无关）：
复制结果不再经过启发式正规化，因此二者能力重叠但结果以本插件为准。建议停用旧插件避免重复工作：

```bash
pi remove pi-copy-soft-wrap   # 或从 ~/.pi/agent/settings.json 的 packages 移除
```

`/codex-ui` 的 `selection-copy` 行报告 `other-wrapper=` 检测结果与最近复制的模式/字符数。

### 选区复制的边界（诚实清单）

- **exact**：assistant/user Markdown（段落/标题/列表/引用/代码围栏）、宿主 Text、thinking 展开正文
  （经 rail）、自有 shell/diff/write 渲染器（gutter/行号=装饰，增删符号=语义前缀，截断=gap）。
- **native-fallback（mixed）**：Markdown 表格（v1 无单元格级映射）、未知 token、图片行、
  highlight 行数漂移的代码块、Spacer/结构空行；fallback 行与相邻内容之间按硬边界断开，不猜。
- **不受支持**：regular（非 fullscreen）模式无 TUI 选区，不拦截任何按键；终端原生选区（按住
  Shift 拖拽等）绕过应用，属终端行为；跨 resize 的旧选区按当前帧坐标解析，无法安全重投影的
  行按原生保守提取。CRLF 统一为 LF；tab 遵循宿主显示归一化（3 空格）；链接只复制显示文本，
  不追加 OSC8 隐藏 URL；数学块复制渲染后的 Unicode 文本。



工具来源通过 Pi 的 `sourceInfo` 核对。**只有明确来自 Pi 内建实现的工具会使用新的 renderer。** FFF/LSP 等插件即便覆盖相同的 `read/grep/find/edit` 名称，也会保留其 renderer。

| 已有功能/插件 | 本项目的处理 |
| --- | --- |
| FFF、LSP 的同名工具覆盖 | 保留来源为扩展的工具定义、执行函数与 renderer |
| `pi-codex-conversion` 的结构化工具 | 不接管 `exec_command/apply_patch/...` |
| Web、MCP、session recall、subagent、询问工具 | 不注册对应工具，不改写其搜索内容或结果 |
| RTK、condense、contextPrune | 不监听 `tool_call/tool_result/context/before_agent_start` |
| `pi-zentui` | 保留 editor、footer、Working line；不增加第二套计时器 |
| `pi-copy-soft-wrap` 与思考快捷键 | 不改 TUI 根渲染器、终端输出、复制接口、思考块或快捷键 |

这些结论描述代码边界与契约测试范围。没有在用户的整套已安装插件实例上完成联合运行，不能据此宣称任意版本的任意插件都零冲突。

## 实现与退避

扩展的**显示层运行时**（`index.ts` 与 `src/**`）没有 `registerTool()`，不重新创建内建工具，不修改工具参数、执行结果、会话记录、模型上下文或系统提示词；上游的 `compactSearchResult` 与全局结果改写已删除。唯一的非显示入口是 vendored 的 `goal.ts`（注册自己的 `/goal` 命令与目标工具，见上），`test/package.test.mjs` 已把这条边界写成显式范围。

针对已核对的 Pi 0.85.1 UI，扩展装饰 `ToolExecutionComponent` 的三个 renderer/shell selector 以及这个**工具行组件自身**的 `render()`。默认构造的子组件树保持不变；首次实际绘制时切换 self-shell 并填充显示内容。这使卸载后可以还原原有卡片，不需要剪切 children，也不改写鼠标命中或图片协议。

以下情况会退避：已有 selector/render patch、接口形状未知、来源不明、第三方自渲染工具、原型不可修改。启动时会给出警告，说明紧凑转录没有安装；不会默默宣称已启用。后来插件修改同一接口时，本项目退回原有 selector，并在卸载时避免覆盖后来者。内部 UI 接口未来仍可能变化，详见 [兼容性说明](docs/compatibility.md)。

## 测试与预览

无需调用模型的核心检查：

```bash
npm test
npm run check:core
npm run preview
```

完整宿主检查需要 Node.js **>=22.19.0** 和真实 Pi 依赖：

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run verify
```

`test:host` 使用真正的 Pi `ToolExecutionComponent`，不以 mock 包替代依赖。当前交付环境未能下载该依赖；完整宿主检查及完整插件联合运行仍未验证。已经执行的检查、失败项目与环境记录见 [VALIDATION.md](VALIDATION.md)。

## 来源与许可

基于用户提供的 `pi-codex-style-master.zip` 修改，保留上游 MIT 许可。来源和归属见 [NOTICE](NOTICE)。`goal.ts` 是 Apache-2.0 上游代码的 vendored 副本，许可证全文见 `LICENSE-APACHE-2.0`，改动说明见文件头与 NOTICE。本项目与 OpenAI、Pi 上游无官方关联。
