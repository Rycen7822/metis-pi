# pi-codex-appearance

**默认启用的 Codex 风格工具转录界面。** 安装后，Pi 原生工具使用紧凑工具行、运行状态、探索记录、折叠输出与 diff 预览。模型、工具执行与上下文处理保持原有路径。

版本：**0.9.10**。面向用户当前使用的 classic Pi **0.85.1** 接口。0.8.0 起，本插件独立负责主界面外观（0.7.x 的 Zentui 协同方案已随 0.7.0 发布并废弃）。0.8.5 起输入区收敛为三块：

- **灰色 composer surface**（仍继承宿主 `CustomEditor`，编辑状态机零改动）：去掉整条 accent 边框，改为低对比 `#1f1f1f` 背景面（truecolor；ansi256 用最近灰阶；ansi16/NO_COLOR 无背景、保留布局）；首行两个 padding 格借用为 `> ` 提示符（格数不变，光标/鼠标/补全几何零偏移，`getText()` 不含该字符），空输入显示暗色 `Ask anything...` 占位；`↑ N more`/`↓ N more` 滚动指示保留。
- **Surface 内 metadata 行**（公开 belowEditor widget，与编辑区同一底色）：`模型 · 推理等级 · provider    ctx 已用/容量 · 占用%`，全部来自 Pi 真实公开接口（`ctx.model`、`ctx.thinkingLevel`、`ctx.getContextUsage()`），切换模型/等级即时更新。
- **紧凑产品 footer**：`目录 (分支)   ↑input ↓output · cache 命中率 · Codex 5h 82% · week 64%`，宽屏追加 `R读 W写 · 花费`；窄屏按 优先级 降级（cost → R/W → 缩短目录 → 两行），P0/P1 永不整块消失；不与 metadata 重复显示 model/context。
- **Codex 式 Working 行**（aboveEditor widget）：`• Working (3m 36s · thinking 24s · esc to interrupt) · read`，`Writing…`/`Waiting for input` 相位，思考结束后 `thought for Ns`；克制的渐变彗尾 shimmer（亮头 + 连续渐隐尾：彗头 128ms/格悠闲扫过，32ms 高帧率驱动亚格强度渐变，truecolor only，NO_COLOR/ansi16 静态）；计时与动画分用两个定时器，settle 后归零；动画帧不扫 session、不读盘、不查 quota（实测 0.003ms/帧）。
- **真实 Codex 额度**（只读）：经本机已登录 Codex CLI 的 `codex app-server`（stdio JSON-RPC：initialize → initialized → account/rateLimits/read），`remaining = 100 − used`（永不混用方向）；超时/退出/异常全部有界并按类别进 `/codex-ui`；不读任何凭据文件、不请求私有 HTTP、不 scrape Codex TUI；quota 失败绝不影响 agent 交互与 outcome 判定。

- **有界历史窗口（fullscreen）**：仅让当前历史窗口进入昂贵的组件绘制路径，硬上限 **5,000 显示行**（含翻页提示）。滚到窗口顶部／底部继续滚动会按需加载上一段／下一段，并释放另一端的派生渲染缓存；session 原始记录保留。原生回到顶部／底部操作可跨页跳转；阅读旧历史时保留当前位置，新输出不会挤掉正在查看的行。恢复和宽度变化从当前窗口边界开始排版，达到行预算即停止；普通滚动复用窗口行。选区存在时固定已提交窗口，避免新输出改变复制内容；提交输入时解除选区冻结。宿主只提供整组件 `render()`，因此边界处的单个超大输出仍可能完整排版一次，再裁切并释放其完整缓存；5,000 行是保留窗口的硬上限，不是单次组件内部计算量的保证。宿主界面搜索作用于当前已加载窗口。
- **逻辑选区复制（0.9.0，fullscreen）**：鼠标选区后 Ctrl+C 复制**已选显示内容的逻辑文本** —— 视觉软折行合并（中文不补空格、英文按源空格桥接）、真实换行/空行保留、代码源缩进保留（宿主展示缩进与 diff 行号/gutter 不混入）、列表 marker / 引用首行边框 / diff 增删符号 / 代码围栏按所选列决定是否包含（语义前缀，不凭字符猜测）。无选区时 Ctrl+C 保持原生行为（清空草稿、双击退出）；纯装饰选区不写剪贴板、不清草稿；剪贴板失败保留选区与草稿。渲染时逐组件生成带来源映射的 sidecar（WeakMap 以渲染数组身份为键，天然绑定已提交帧），并与宿主真实输出逐行 diff —— 任何漂移只降级为原生提取，绝不猜。表格/未知 token/图片行按 conservative 回退；与 `pi-copy-soft-wrap` 共存时精确路径优先生效（加载顺序无关），`/codex-ui` 报告其存在。选区复制零新按键注入、零 prototype 工具执行改动；`selectionCopy.enabled` / `selectionCopy.ctrlC` 可关闭。

既有能力保留：运行时终止证据判定（v2 摘要 schema：stop=Worked / error=Failed / aborted=Interrupted / length=Ended·output limit / 证据不足=Ended；旧 v1 `failed` 显示 `legacy status unverified`，历史不改写）、极简真实身份启动头（运行时读取真实版本号）、`agent_start`→`agent_settled` 单一交互时钟、`Worked for … · thought for … · ↑↓` 结束摘要（可随会话恢复；`summary.persist:false` 走 footer 状态行临时路径）、thinking 光条（默认 `full/full`，Ctrl+T/点击手动切换）、write 实时预览（结构化标题 + 物理行尾部预算）、文档/代码 edit 整行背景 diff surface、探索分组。以 openai/codex 固定参考提交 1b83e5c 为视觉与行为 reference，全部仅作用于显示层。

配置：`~/.pi/agent/codex-appearance.json`（可省略，非法值回退默认、用户文件永不改写）。`enabled: false` 为总开关；`composer.surface` / `composer.promptPrefix` / `composer.metadata` / `thinking.rail` / `writePreview.enabled` / `writePreview.rows` / `working.elapsed` / `working.thought` / `working.tool` / `working.tokens`（默认 false）/ `working.animation` / `working.animationIntervalMs`（32..1000，默认 32）/ `footer.enabled` / `footer.details` / `footer.showCache` / `footer.showCacheReadWrite` / `footer.showCost` / `footer.showCodexQuota` / `quota.codex`（auto/on/off）/ `quota.refreshSeconds`（30..3600，默认 120）/ `quota.timeoutMs`（默认 8000）/ `summary.enabled` / `summary.persist` / `selectionCopy.enabled` / `selectionCopy.ctrlC` 可分别关闭。诊断命令：`/codex-ui`（各数值来源、统计范围、终止证据、composer/working/footer/quota 组件真实状态；`/codex-ui refresh-quota` 手动刷新额度）。

**统计口径（三个范围不混淆）**：`ctx …` 是当前上下文占用（宿主实时接口）；`Σ` 是本 session 文件已记录的标准 usage 累计（assistant 消息 + compaction/branch_summary；本插件自己的摘要 CustomEntry 不计回）；`cache(last)` 是活动分支最近一条已确认请求的命中率 `cacheRead/(input+cacheRead+cacheWrite)`，session 加权比率在 `/codex-ui` 可查；`↑`/`↓` 沿用 Pi 归一化口径的 `usage.input`/`usage.output`（input 为不含缓存的输入，R/W 单独列缓存读写）。未知值显示 `—`，从不伪造为 0。

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

扩展没有 `registerTool()`，不重新创建内建工具，不修改工具参数、执行结果、会话记录、模型上下文或系统提示词。上游的 `compactSearchResult` 与全局结果改写已删除。

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

基于用户提供的 `pi-codex-style-master.zip` 修改，保留上游 MIT 许可。来源和归属见 [NOTICE](NOTICE)。本项目与 OpenAI、Pi 上游无官方关联。
