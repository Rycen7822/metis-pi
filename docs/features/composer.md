# 输入区（composer）

> 两块组成：灰色 surface、借 padding 格实现的 `> ` 提示符。模型和上下文信息现位于输入框下方的 footer，不再贴在编辑区内。全部只改显示，宿主编辑状态机零改动。

| | |
| --- | --- |
| 入口 | `extensions/appearance.ts` |
| 实现 | `src/chrome/editor.ts`（工厂）`src/surface.ts`（配色）；底部信息见 [Footer](working-footer.md) |
| 安装 | `src/chrome/install.ts` 的 `install`（经公开 `ui.setEditorComponent`） |
| 配置 | `composer.surface`、`composer.promptPrefix`、`composer.metadata` |

## 行为

### 1. 灰色 surface（`composer.surface`）

- 去掉整条 accent 边框，改为低对比 **`#1f1f1f`** 背景面（`src/surface.ts` 的 `COMPOSER_BG`）。
- 降级：truecolor 精确色；ansi256 用最近灰阶；ansi16 / `NO_COLOR` **无背景**但**布局完全不变**。
- **仍继承宿主 `CustomEditor`**：编辑状态机、补全、鼠标命中、光标几何都不动；宿主的 paddingX 会在自定义编辑器上被重新套用（`src/chrome/editor.ts` 有说明）。聚焦时使用终端真实竖线光标（DECSCUSR），只去掉宿主在光标下方字符上的反色，不替换字符；输入法定位 marker 和提交文本保持不变。卸载时恢复 Pi 原有的光标显示开关和终端默认形状；缺少硬件光标 API 时保留宿主原生反色光标。
- 原 padding 行改为 surface 着色的 padding 行，滚动指示 `↑ N more` / `↓ N more` 保留。

### 2. `> ` 提示符（`composer.promptPrefix`）

首行的**两个 padding 格**被借用为 `> `：

- 格数不变 → 光标、鼠标、补全的几何**零偏移**；
- `getText()` **不含**该字符（纯粹是显示借用，不影响提交内容）；
- 空输入时显示暗色占位符 `Ask anything...`（display only，同样不进 `getText()`）。

### 3. 输入框下方信息

`composer.metadata` 控制 footer 中的模型、推理等级、provider、上下文信息；与编辑区 surface 是否启用无关。切换模型或推理等级时由宿主快照刷新；上下文容量优先采用实时 usage 窗口，取不到才使用模型声明的 `contextWindow`。详见 [Footer](working-footer.md)。

## 安装条件与退避

| 块 | 条件 | 不满足时 |
| --- | --- | --- |
| surface | `ui.setEditorComponent` 存在 且 宿主当前没有自定义 editor 且 拿到宿主 `CustomEditor` 类 | 保留宿主原生编辑区 |
| footer 信息 | `ui.setFooter` 可用且 `footer.enabled` | 保留宿主原生 footer |

关闭 `composer.surface` 时不安装 surface，`promptPrefix` 无法单独存在（它借用 surface 的 padding 格）；footer 信息仍独立显示。

## 多 skill 输入（`skillTrigger`）

宿主只在**行首**自动触发 `/`，且补全查询返空会清掉菜单状态——于是第二及以后的 skill token 永远不弹菜单。工厂因此带 `skillTrigger: true`：在插入 `/` 后由 composer 补发一次查询。完整行为见 [skills.md](skills.md)。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| surface 颜色与降级 | `src/surface.ts` 的 `COMPOSER_BG`、`surfacePaint` |
| editor 工厂与选项 | `src/chrome/editor.ts` 的 `makeCodexEditorFactory`（`paddingX` / `placeholder` / `promptPrefix` / `skillTrigger` / `selectionCopy`） |
| `> `、占位符、光标格反色 | `src/chrome/editor.ts` |
| 硬件光标启停与终端形状恢复 | `src/chrome/hardware-cursor.ts`、`src/chrome/install.ts` |
| 模型和上下文信息 | `src/chrome/footer.ts` 的 `layoutFooter` |
| 数据快照 | `src/chrome/snapshots.ts` |
| 安装/卸载 | `src/chrome/install.ts` |

## 不变量与已知限制

- 不改宿主输入框的状态机、键位、补全实现；只提供自定义 editor 实现，信息单独显示在 footer。
- `> ` 与占位符**永不**进入提交文本；pty 用例逐字验证 `getText()`。
- 无背景的降级等级下，surface 只保留 `> ` 与布局；光标由终端独立绘制，不依赖背景色。

## 验证

`test/transcript/transcript.test.mts`（editor 工厂与 surface 行为）、`test/chrome/chrome.test.mjs`、`test/host/host-surface.test.mjs`（真实宿主组件）、`scripts/pty-verify.mjs`（真实 TUI 的输入区几何与占位符）。
