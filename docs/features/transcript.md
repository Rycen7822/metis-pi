# 转录显示（工具行 / diff / write / 探索 / 终局 / 摘要 / 启动头）

> Pi 原生工具调用在转录区的整套 Codex 风格显示：紧凑工具行、运行状态、探索记录、折叠输出、整行背景 diff、write 实时预览与结果判定。

| | |
| --- | --- |
| 入口 | `extensions/appearance.ts` |
| 安装点 | `src/adapter.ts`（装饰宿主 `ToolExecutionComponent`） |
| 渲染实现 | `src/renderers.ts` `src/shell.ts` `src/diff.ts` `src/diff-component.ts` `src/explore.ts` `src/output-style.ts` `src/palette.ts` |
| 状态/协调 | `src/transcript-adapter.ts` `src/transcript-state.ts` |
| 配置 | `enabled`、`summary.*`（见 [../configuration.md](../configuration.md)） |
| 诊断 | `/codex-ui` |

## 用户可见行为

```text
• Explored
  └ Read src/server.ts (lines 1–120)

• Ran npm test
  └ Running unit tests...
    … +24 lines (ctrl+o to expand)
    tests passed

• Edited src/server.ts (+2 -1)
  12  export function startServer() {
  13 -  server.listen(3000);
  13 +  const port = Number(...);
  14 +  server.listen(port);
  15  }
```

- **命令执行**：`Running` → `Ran`（标题加粗）。命令在换行**前**做完整 bash 语法高亮（executable 蓝、keyword 紫、string 绿、number 橙、operator 青、parameter 红、builtin 红、comment/标点灰蓝），词法状态跨行保持（`src/bash-lexer.ts`）。continuation 行前缀 `  │ `，最多 `COMMAND_CONTINUATION_MAX_ROWS` = 2 个屏幕行。
- **输出区**：首行 `  └ `、后续缩进 4 空格，wrap 后最多 `OUTPUT_MAX_ROWS` = 5 个屏幕行，超出做 **middle truncation**（保留首尾、中间折叠）并给出 `… +N lines (ctrl+o to expand)` 提示（提示文本取自宿主，自定义键位不会被覆盖）。错误输出前景标红。超过 `MAX_LOGICAL_LINE_CHARS` = 1200 的**单条逻辑行**会先做安全截断，避免超长行吃光行预算。
- **文件探索**：`read` / `grep` / `find` / `ls` 归入 `Exploring` → `Explored`；动作动词用 Codex cyan（`CODEX_CYAN`），查询与路径之间的 ` in ` 用 dim（`src/explore.ts`）。成功输出默认折叠。
- **文件修改（edit/diff）**：Codex 式 `行号 + 空格 + +/- + 内容`。删除行整行底色 `#4A221D`（256 色 `52`），新增行 `#213A2B`（256 色 `22`），ANSI-16 只保留前景色；diff 正文按文件扩展名做语法高亮，且前景 `reset` **不会**清掉 diff 底色；换行后内容悬挂对齐到正文列；context 行无底色；宿主自带的 compact context window 不再二次截断。整条路径只有**一个** diff 渲染实现（`src/diff.ts` → `src/diff-component.ts`）。
- **写入（write）**：`tool_execution_start` 抓 pre-image、`tool_execution_end` 校验 post-image，只在可靠时呈现：新文件 `Added path (+N -0)` 全绿；覆盖写 `Edited path (+A -D)` 真实 diff；二进制 / 超大 / 不可读 / post 不匹配 / 任何不确定 → 回退成原始内容预览。差分除输入大小限制外，搜索数组合计上限为 4 MiB；没有共同正文行的整块改写直接生成精确增删行，复杂搜索超限则明确回退，不展示半份 diff 或虚假的 `+0 -0`。**绝不伪造 diff**（`src/write-tracker.ts`，状态仅存进程内存，不写盘、不进会话记录）。
- **内置 apply_patch**：单文件/多文件的默认 diff 预览和展开视图均复用与 `edit` 相同的 Codex 整行背景、行号与换行布局（`src/apply-patch-view.ts`），包括新增、删除和移动。折叠预览在换行后跨文件合计保留 11 个屏幕行，随后显示展开提示；展开后显示完整 diff。转换层仍决定是否只显示摘要，预览来自其唯一的执行前结构化快照，不在执行后重读文件。失败/部分失败及无快照的历史记录保留原生诊断，不伪造成功 diff。
- **内置 exec_command**：普通命令直接复用 `bash` 的 call 组件，按当前终端宽度换行后计算屏幕行预算，移除本路径的“每行 100 字符、最多 5 个输入行”截断。标题行、续行栏、展开/折叠和复制元数据均来自同一组件（沿用 bash 的安全长度上限）。命令与展开探索分组中的原始命令仍共用 `src/bash-lexer.ts` 的颜色及 heredoc 高亮。转换层继续负责探索分组、执行状态、后台会话和结果显示；组件工厂与着色函数仅通过调用时主题传递，不增加共享状态，也不改动输出或执行参数。
- **写入实时预览**：模型还在生成 `write` 参数时实时显示标题 + 阶段行 + 物理行尾部预算内的正文。`writePreview.rows` 是**整块**屏幕行预算（标题行 + 阶段行 + 正文 + 省略行），且至少保留 1 行正文；`0` 表示只留标题与阶段行。
- **图像结果**：保留宿主原生图片路径，服从 `terminal.showImages`；关闭图片预览时只显示轻量数量提示，不输出 Base64。
- **启动头**：1–2 行极简身份行，运行时读取**真实**版本号（`src/chrome/header.ts`）。
- **终止证据**：`stop` → `Worked`、`error` → `Failed`、`aborted` → `Interrupted`、`length` → `Ended · output limit`、证据不足 → `Ended`；旧 v1 记录显示 `legacy status unverified`，历史不改写（`src/interaction-outcome.ts`）。
- **结束摘要**：`Worked for … · thought for … · ↑↓`，可随会话恢复。`summary.persist: false` 时改走 footer 状态行的临时路径（不落会话记录）。

每个工具调用保留**独立**的显示与展开状态，不跨调用合并结果。

## 子代理启动提示

交互界面启用期间，metis-pi 精确过滤 `pi-web-access` 的
`Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.`
这条 `console.warn` 兼容性回退提示，避免子代理重新加载扩展时将它写进输入框。
这不是对子代理运行期间全局静音：其他警告、附带额外诊断的输出、`console.error`、
工具结果和 `ctx.ui.notify` 均不拦截；不改变 Web 工具启用方式。
过滤仅绑定到启用 metis-pi 的 TUI 生命周期（不区分提示来自主会话还是子代理）；
界面启动前、退出后和独立非交互进程保持原行为。

## 安装机制（为什么能安全卸载）

`src/adapter.ts` 不注册工具、不替换执行、不加 context 中间件、不 patch TUI 根渲染器。它只装饰宿主 `ToolExecutionComponent` 原型的四个方法：三个 renderer/shell selector（`getCallRenderer`、`getResultRenderer`、`getRenderShell`）与该组件自身的 `render`。

- **安装前逐字校验**：三个 selector 的**函数源码**必须与预期字符串一致，`render` 的方法体必须含 `this.selfRenderContainer.render(`、`this.selfRenderHeight=`、`this.imageComponents` 三个标记；任何一个不符 → 直接退避（`skipped(reason)`），启动时给出警告而不是默默声称已启用。
- **自己的占位标记**：`Symbol.for("Rycen7822.metis-pi.tool-view.v2")` 作为原型自有属性，第二份副本会退避。
- **来源核对**：原生工具要求 `sourceInfo.source === "builtin"` 且 `path === "<builtin:name>"`；内置 `apply_patch` 和 `exec_command` 只允许本包 `vendor/pi-codex-conversion/dist/index.js` 的精确来源路径。FFF / LSP 或其他来源的同名工具不受影响。
- **只在首次实际绘制时切 self-shell**：默认构造的子组件树保持原样，因此卸载/禁用可以还原原生卡片，不需要剪切 children、不改写鼠标命中、不动图片协议。`exec_command` 只接管 command call，保留原来的外层 shell 和结果布局。
- **每帧核对归属**：`ownsMethods()` 用身份比较确认原型上仍是自己的包装；后来者替换了就立即停止接管，卸载时也不会覆盖后来者。
- **呈现失败降级**：单行渲染抛错时把该行退回默认视图，绝不让渲染路径把宿主进程带崩。
- 不持有转录行的强引用（`WeakRef` 集合 + 定期清扫）。

退避条件汇总见 [../compatibility.md](../compatibility.md)。

## 宽度模型

`src/shell.ts` 用**物理行**模型排版：逻辑行先按可用宽度 wrap 成 VisualRow（每行记录视觉列范围），再按行预算裁剪。所有截断（含 compose 的 header/summary 行）都按**显示宽度**计算，不按 UTF-16 码元——所以中文路径、emoji 不会把行撑出两倍宽，也不会劈开代理对（`src/segments.ts` 的 `clipLine`）。

## 不变量与已知限制

- 显示层**不接管第三方工具**：Web、MCP、session recall、subagent、code-mode 等插件的 renderer 与结果原样保留。
- 不重复实现完整终端客户端：输入区、页脚、Working 行、审批流程、快捷键都沿用宿主/既有插件。
- 连续探索**不会**完全复现 Codex 的跨调用聚合；每个调用各自成行。
- 单次组件 `render()` 是宿主给的整体接口，因此边界处的单个超大输出仍可能被完整排版一次再裁切。
- 当前真实组件和终端验证使用 Pi 0.86.1；内部 UI 接口变化时，按上面的校验规则整块退避。验证边界见 [VALIDATION](../../VALIDATION.md)。

## 验证

`test/transcript/adapter.test.mjs`（安装/退避/归属）、`test/transcript/renderers.test.mjs`、`test/shell.golden.test.mjs`、`test/golden.layout.test.mjs`、`test/diff.parser.test.mjs`、`test/unit/write-tracker.test.mjs`、`test/host/write-stream-crash.test.mts`、`test/transcript/transcript.test.mts`（最大的一份，覆盖状态与协调逻辑）、`scripts/pty-verify.mjs`（真实 TUI 逐帧断言）。
