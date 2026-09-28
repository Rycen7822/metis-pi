# Fullscreen 布局与历史窗口

fullscreen 使用左右留白和有界历史窗口。窗口化只影响显示及派生缓存，session 原始记录完整保留。

## 侧边留白

`fullscreen.marginX` 默认 2 列，可设 0–8；`0` 关闭留白。终端窄于 `fullscreen.minWidth`（默认 72）时整段留白消失。完整配置见 [配置](../configuration.md)。

布局通过 HStack 包装根节点，不改写 TUI 根渲染器。留白和历史窗口共用一次 `setLayoutRoot` 安装，重复捕获不叠加；卸载先使旧拦截失效，再释放监听、滚轮和根布局，避免第三方包装导致旧窗口重新挂载。关闭留白不关闭历史窗口。

## 历史窗口

| 行为 | 规则 |
| --- | --- |
| 保留上限 | `HISTORY_ROW_BUDGET` 为 5000 显示行，含翻页提示 |
| 窗口外内容 | 不进入昂贵的组件绘制路径；按需加载后可再次查看 |
| 翻页 | 在顶部/底部继续滚动加载相邻历史，释放另一端的派生缓存 |
| 边缘提示 | 显示 Earlier/Later history 及 5000-row window 提示 |
| 顶部/底部跳转 | 宿主操作可跨页 |
| 阅读旧历史 | 保留当前位置，新输出不挤掉正在阅读的行；新窗口/视口尺寸提交后再定位锚点 |
| 恢复与宽度变化 | 从窗口边界开始排版，到预算即停止；普通滚动复用窗口行 |
| 存在选区 | 固定已提交窗口；提交输入解除冻结 |
| 宿主搜索 | 只搜索当前已加载窗口 |

5000 行限制的是保留窗口。宿主只提供整组件 `render()`，边界处的单个超大组件仍可能完整排版一次，再裁切并释放完整缓存。resize 后无法安全重投影的旧选区按原生方式保守提取，见 [复制](selection-copy.md)。

安装由 `src/chrome/install.ts` 和 `src/extension.ts` 接线，布局与窗口分别位于 `src/chrome/fullscreen-layout.ts`、`src/chrome/history-window.ts`。regular 模式不安装这套窗口；宿主滚动、选区与 PTY 验证范围见 [VALIDATION](../../VALIDATION.md)。
