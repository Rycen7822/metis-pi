# 思考块（rail / 窥视窗 / 手势）

> 流式思考默认只显示最新 6 行；单击在「折叠 ↔ 窥视窗」间切换，双击在「窥视窗 ↔ 全展开」间切换，思考结束自动折叠。

| | |
| --- | --- |
| 入口 | `extensions/appearance.ts` |
| 状态机 | `src/thinking-view.ts` |
| 组件 | `src/chrome/transcript-components.ts`（rail / peek / clickable） |
| 标签 | `src/thinking-summary.ts` |
| run 归并 | `src/transcript-state.ts` 的 `semanticRuns` / `renderedThinkingRuns` |
| 配置 | `thinking.streaming`、`thinking.completed`、`thinking.rail`、`thinking.peekLines` |

## 三种形态

| 形态 | 何时 | 外观 |
| --- | --- | --- |
| 折叠 | `thinking.completed: "collapsed"` 后的默认；或 `thinking.streaming: "collapsed"` | 一行标签 `Thought for 1m 04s` / `Thought`（无可靠时长证据时不伪造 `0s`） |
| 窥视窗（peek） | `thinking.streaming: "peek"`（**默认**） | 最新 `peekLines` 行 + 上方一行 dim 提示 |
| 全展开 | `thinking.streaming: "full"`，或用户双击 | 宿主渲染的完整思考正文 |

青色 rail 由 `thinking.rail` 控制（`▏`；`NO_COLOR` 下降级为 `| `），三种形态下都在。

## 窥视窗

- 行数由 `thinking.peekLines`（默认 6，钳制 1..40）决定，显示**最新**若干行。
- 上方提示行说清裁掉多少：`… N lines (scroll · double-click for all)`（`src/thinking-view.ts`），总数取自该 run 的**全部**已渲染行。
- **指针在窗口上滚轮**即在窗口内滚动；滚到两端时事件落回正文滚动；滚回最新行后恢复自动跟随。
- 窗口只对宿主**已经渲染好的行**做切片：不重排 Markdown、不重新着色，所以 rail、语法高亮、复制归属与展开态完全一致。

## 手势

| 手势 | 从 | 到 |
| --- | --- | --- |
| 左键单击 | 折叠 | 窥视窗 |
| 左键单击 | 窥视窗 | 折叠 |
| 左键双击 | 窥视窗 | 全展开 |
| 左键双击 | 折叠 | 全展开（直接跳过中间态） |
| 滚轮 | 窥视窗内 | 窗口内滚动 / 到端点后落回正文 |

**单击为什么延迟 300ms**（`DOUBLE_CLICK_MS`）：宿主按**组件身份**识别双击，而每次重建都会换掉组件实例，所以只有把单击延后到双击窗口之后再落地，才能同时保住单击与双击两种语义。第二个点击落在窗口内时立即应用双击目标。进行中与已结束的思考块用**同一套**规则。

`ctrl+t` 仍是宿主的全局显示/隐藏，本项目不注册任何键位。

## 自动折叠与"用户意志优先"

思考结束时按 `thinking.completed` 自动折叠**一次**（默认折叠，与旧版一致）。折叠之后用户的手势选择**不会被后续重建覆盖**——`src/thinking-view.ts` 记录用户是否显式选择过。

## 计时口径

窗口高度、提示行、手势**都不影响**计时：思路用时只在 `agent_end` 记账（`src/ui-metrics.ts` 的单一交互时钟），折叠标签显示的是同一份时长。Working 行的 `thinking Ns` 用的是同一个来源，见 [working-footer.md](working-footer.md)。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| 形态与变换 | `src/thinking-view.ts`（`ThinkingView`、`doubleClickTarget`、`DOUBLE_CLICK_MS`、`applyView`） |
| run 归并（与宿主重建对齐） | `src/transcript-state.ts`（`semanticRuns`、`renderedThinkingRuns`、`ThinkingRunSlot`） |
| rail / peek / 可点击组件 | `src/chrome/transcript-components.ts` |
| 折叠标签 | `src/thinking-summary.ts` 的 `thoughtSummaryText` |
| 协调与重建 | `src/transcript-adapter.ts` |

## 不变量与已知限制

- **run 归并与宿主重建共用一份实现**：连续 thinking 块合并为一个 run，但任何非 thinking 块（包括**空 text 块**）都会打断它；全部为空的 run 不产生子组件、也不占 `runIndex`。思考计时、折叠标签、窥视窗、点击目标全部基于这一份 run 列表，因此不会各自漂移。
- 窥视窗是**切片视图**：单个超大的 run 仍会被完整排版一次再切片。
- 手势靠鼠标事件，不注入新键位；带修饰键（Shift/Ctrl/Alt）的点击交给文本选择。

## 验证

`test/core/thinking-view.test.mts`（形态/手势/延迟落地）、`test/core/transcript.test.mjs`（run 状态）、`test/contract/thinking.test.mjs`（真实协调器）、`scripts/pty-verify.mjs`（真实 TUI：窥视窗行数、提示行、单击/双击、自动折叠、计时增长一致）。
