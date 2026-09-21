# 输入区（composer）

> 三块组成：灰色 surface、借 padding 格实现的 `> ` 提示符、编辑区下方 metadata 行。全部只改显示，宿主编辑状态机零改动。

| | |
| --- | --- |
| 入口 | `extensions/appearance.ts` |
| 实现 | `src/chrome/editor.ts`（工厂）`src/surface.ts`（配色）`src/chrome/composer-metadata.ts`（metadata 行） |
| 安装 | `src/chrome/install.ts` 的 `install`（经公开 `ui.setEditorComponent` / `ui.setWidget`） |
| 配置 | `composer.surface`、`composer.promptPrefix`、`composer.metadata` |

## 行为

### 1. 灰色 surface（`composer.surface`）

- 去掉整条 accent 边框，改为低对比 **`#1f1f1f`** 背景面（`src/surface.ts` 的 `COMPOSER_BG`）。
- 降级：truecolor 精确色；ansi256 用最近灰阶；ansi16 / `NO_COLOR` **无背景**但**布局完全不变**。
- **仍继承宿主 `CustomEditor`**：编辑状态机、补全、鼠标命中、光标几何都不动；宿主的 paddingX 会在自定义编辑器上被重新套用（`src/chrome/editor.ts` 有说明）。
- 原 padding 行改为 surface 着色的 padding 行，滚动指示 `↑ N more` / `↓ N more` 保留。

### 2. `> ` 提示符（`composer.promptPrefix`）

首行的**两个 padding 格**被借用为 `> `：

- 格数不变 → 光标、鼠标、补全的几何**零偏移**；
- `getText()` **不含**该字符（纯粹是显示借用，不影响提交内容）；
- 空输入时显示暗色占位符 `Ask anything...`（display only，同样不进 `getText()`）。

### 3. metadata 行（`composer.metadata`）

公开的 `belowEditor` widget，与编辑区同一底色，视觉上属于同一个 surface：

```
模型 · 推理等级 · provider    ctx 已用/容量 · 占用%
```

- 数据全部来自宿主公开接口：`ctx.model`、`ctx.thinkingLevel`、`ctx.getContextUsage()`（`src/chrome/snapshots.ts` 的 `getComposerMetaSnapshot`）。
- 切换模型 / 推理等级即时更新（snapshot 带 revision，model/effort/context 一起刷新）。
- 上下文容量优先用**实时 usage 窗口**，取不到才退回模型声明的 `contextWindow`；未知值显示 `—`，不伪造 0。

## 安装条件与退避

| 块 | 条件 | 不满足时 |
| --- | --- | --- |
| surface | `ui.setEditorComponent` 存在 且 宿主当前没有自定义 editor 且 拿到宿主 `CustomEditor` 类 | 保留宿主原生编辑区 |
| metadata | 上面的 surface **已生效**（`composer.surface` 且拿到 surface 绘制 ops） | 不安装（metadata 不会浮在裸背景上） |

关闭 `composer.surface` 时不安装 surface，但 `promptPrefix` 无法单独存在（它借用 surface 的 padding 格），metadata 也随之不安装。

## 多 skill 输入（`skillTrigger`）

宿主只在**行首**自动触发 `/`，且补全查询返空会清掉菜单状态——于是第二及以后的 skill token 永远不弹菜单。工厂因此带 `skillTrigger: true`：在插入 `/` 后由 composer 补发一次查询。完整行为见 [skills.md](skills.md)。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| surface 颜色与降级 | `src/surface.ts` 的 `COMPOSER_BG`、`surfacePaint` |
| editor 工厂与选项 | `src/chrome/editor.ts` 的 `makeCodexEditorFactory`（`paddingX` / `placeholder` / `promptPrefix` / `skillTrigger` / `selectionCopy`） |
| `> ` 与占位符 | 同文件（padding 行替换逻辑） |
| metadata 行内容 | `src/chrome/composer-metadata.ts` 的 `createComposerMetaComponent` / `composerMetaSegments` |
| 数据快照 | `src/chrome/snapshots.ts` |
| 安装/卸载 | `src/chrome/install.ts` |

## 不变量与已知限制

- 不改宿主输入框的状态机、键位、补全实现；只提供自定义 editor 实现与一个 widget。
- `> ` 与占位符**永不**进入提交文本；pty 用例逐字验证 `getText()`。
- 无背景的降级等级下，只剩 `> ` 与布局：这是刻意的（不把 16 色终端画花）。
- metadata 行依赖 surface 生效；这是有意的耦合，避免出现"浮在半空"的一行字。

## 验证

`test/transcript/transcript.test.mts`（editor 工厂与 surface 行为）、`test/chrome/chrome.test.mjs`、`test/host/host-surface.test.mjs`（真实宿主组件）、`scripts/pty-verify.mjs`（真实 TUI 的输入区几何与占位符）。
