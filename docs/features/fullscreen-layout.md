# fullscreen 侧边留白 + 有界历史窗口

> 两个只在 fullscreen 模式生效的布局/内存机制：Codex 式左右留白，以及"只让当前窗口进入昂贵排版路径"的硬上限。

| | |
| --- | --- |
| 入口 | `extensions/appearance.ts` |
| 实现 | `src/chrome/fullscreen-layout.ts`、`src/chrome/history-window.ts` |
| 安装 | `src/chrome/install.ts` 捕获 TUI，`src/extension.ts` 调用唯一的布局 `installOnTui` |
| 配置 | `fullscreen.marginX`（默认 2）、`fullscreen.minWidth`（默认 72） |

## 侧边留白（gutters）

- 布局根被包进一层 pi-tui 的 `HStack`，左右各留 `marginX` 列（默认 2，可 0..8）。
- `marginX: 0` 即关闭；终端宽度窄于 `minWidth`（默认 72）时留白**整体消失**（不做半截留白）。
- **纯插件实现**：不 patch TUI 根渲染器，因此不干扰宿主的鼠标命中与图片协议。
- 留白与历史窗口共用一个 `setLayoutRoot` 安装点。重复捕获不叠加拦截器；卸载先使旧拦截器失效，再释放历史监听、滚轮与根布局，即使其它插件随后包装了同一方法，也不会在清理时重新挂载窗口。`marginX: 0` 不关闭历史窗口。
- 留白带来过一个真实缺陷（0.9.4 记录在 `VALIDATION.md`）：左右留白改变了列坐标，暴露了选区复制 serializer 的映射问题，随后在 `src/selection-copy/**` 修正。

## 有界历史窗口

| 机制 | 行为 |
| --- | --- |
| 硬上限 | `HISTORY_ROW_BUDGET` = **5000** 显示行（含翻页提示行） |
| 窗口外 | 不进昂贵的组件绘制路径；session 原始记录**完整保留** |
| 按需加载 | 滚到窗口顶部/底部继续滚动 → 加载上一段/下一段，并**释放另一端**的派生渲染缓存 |
| 翻页提示 | 边缘显示 `[Earlier history: scroll up to load \| 5000-row window]` / `[Later history: …]` |
| 跨页跳转 | 宿主的回到顶部/底部操作可跨页 |
| 阅读位置 | 阅读旧历史时保留当前位置，新输出不会挤掉正在看的行；翻页与内容重排的定位在宿主提交新窗口/视口尺寸后、生成帧坐标前应用，避免短尾页的旧滚动上限把锚点截到顶部 |
| 恢复/宽度变化 | 从当前窗口边界开始排版，达到行预算即停止；普通滚动复用窗口行 |
| 选区冻结 | 存在选区时**固定已提交窗口**，避免新输出改变将被复制的内容；提交输入时解除冻结 |

**5000 行是"保留窗口"的硬上限，不是单次组件内部计算量的保证**：宿主只提供整组件 `render()`，因此边界处的单个超大输出仍可能被完整排版一次，再裁切并释放其完整缓存。宿主界面搜索只作用于当前已加载窗口。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| 布局安装、卸载与留白降级 | `src/chrome/fullscreen-layout.ts`（布局租约、`installOnTui`、最小宽度判定） |
| 行预算与换页 | `src/chrome/history-window.ts`（`HISTORY_ROW_BUDGET`、`evictedBlocks`、`older`/`newer` 状态） |
| TUI 捕获与接线 | `src/chrome/install.ts`、`src/extension.ts` |

## 不变量与已知限制

- 只在 fullscreen 模式介入；regular（非 fullscreen）模式没有 TUI 选区概念，本项目不拦截任何按键。
- 不修改 session 记录：窗口化只影响**显示**与派生缓存。
- 跨 resize 的旧选区按当前帧坐标解析；无法安全重投影的行按原生保守提取。
- 搜索、跨页跳转等宿主行为仍然可用，但只覆盖已加载窗口。

## 验证

`test/contract/fullscreen.test.mjs`、`test/contract/history-window.test.mjs`、`test/contract/shell-scroll.test.mjs`（滚动/性能路径）、`scripts/pty-verify.mjs`（真实 TUI 的留白与滚动行为）。
