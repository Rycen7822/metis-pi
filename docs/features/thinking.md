# 思考块与窥视窗

默认流式思考显示最新 6 行，结束后自动折叠。通过 `thinking.streaming`、`thinking.completed`、`thinking.peekLines` 和 `thinking.rail` 配置，默认值与范围见 [配置参考](../configuration.md)。

## 显示形态

| 形态 | 行为 |
| --- | --- |
| 折叠 | 一行 `Thought for …`；缺少可靠时长时只显示 `Thought`。 |
| 窥视窗 | 显示最新若干已渲染行，上方提示省略行数；沿用原 Markdown 排版、高亮和复制归属。 |
| 全展开 | 显示该 run 的完整思考正文。 |

青色 rail 由 `thinking.rail` 控制，关闭颜色时使用 ASCII 形式。窗口的行数/手势不改变模型正文或计时。

## 手势

| 操作 | 结果 |
| --- | --- |
| 单击折叠块 | 打开窥视窗。 |
| 单击窥视窗或全展开块 | 折叠。 |
| 双击折叠块或窥视窗 | 全展开。 |
| 双击全展开块 | 回到窥视窗。 |
| 在窥视窗内滚轮 | 滚动窗口，到两端后交回正文；回到最新行后恢复跟随。 |
| 带 Shift/Ctrl/Alt 点击 | 交给文本选择。 |

单击延后 300ms 落地，以保留同一组件的双击识别；第二次点击命中双击窗口时立即应用双击目标。进行中与已结束的块遵循相同规则。`ctrl+t` 继续由宿主管理全局显示/隐藏。

## 结束、计时与重建

思考结束时按 `thinking.completed` 自动切换一次。用户之后的显式选择会保留，后续重建不会再次强行覆盖。

连续 thinking 块组成语义 run；任何非 thinking 块，包括空 text，都会切开 run。全空 run 不生成子组件。折叠标签使用对应 run 的计时证据，历史 run 缺少时长时不伪造数字；交互级累计和 Working 统计见 [Working 与 Footer](working-footer.md)。

窥视窗只裁切已排版行，因此单个超大 run 仍可能完整排版一次。宿主内部组件变化时会按兼容守卫退避。

## 实现与验证

`src/thinking-view.ts` 管形态/手势，`transcript-state.ts` 管 run 身份和计时，`transcript-adapter.ts` 与 `chrome/transcript-components.ts` 连接宿主组件。规则、真实组件和 PTY E3 分别验证状态、接线与手势；范围见 [开发说明](../development.md) 和 [VALIDATION](../../VALIDATION.md)。
