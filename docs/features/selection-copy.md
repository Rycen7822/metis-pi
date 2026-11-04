# 逻辑选区复制

fullscreen 应用选区通过宿主 `app.clear`（缺失才用 Ctrl+C）复制逻辑原文：合并软折行，保留真实换行/缩进及选中的语义前缀。`selectionCopy.enabled/ctrlC` 控制能力/按键接管，见[配置](../configuration.md)；不额外注册快捷键。

| 情况 | 行为 |
| --- | --- |
| 有选区 | 复制、保草稿并固定历史窗口。 |
| 无选区 | 交回宿主清空/退出。 |
| 只选 gutter/行号/省略提示 | 不写剪贴板、不清草稿。 |
| 写入失败 | 保选区/草稿。 |

regular 无应用选区；Shift 拖拽等终端原生选择由终端处理。

## 输入框选区删除

fullscreen Metis editor 的选区完全落在输入正文时，按宿主 Backspace/Delete 一次删整段、光标到起点，原生撤销一次恢复；Ctrl+C 只复制。此能力不受 `selectionCopy.enabled/ctrlC` 控制，regular/终端选区不可用。

从已提交画面映射逻辑行，支持软折行、内滚动、Unicode 字素和粘贴块；部分选中粘贴标记按整块删除，其他粘贴保留。留白不删字符；正文/跨区域选区或草稿变化使映射失效时仅普通光标删除，不按复制文字搜索草稿。

## 映射与回退

| 内容 | 处理 |
| --- | --- |
| Markdown 段落/标题/列表/引用/围栏，宿主 Text、展开思考、本包 shell/diff/write | 与当前帧一致才精确提取。 |
| 列表/引用/diff 符号与围栏 | 所选列覆盖才复制；行号/gutter 不复制。 |
| 省略行 | 硬边界，不拼首尾。 |
| 表格/未知 token/图片/排版漂移/Spacer/结构空行 | 原生回退。 |
| tab / 链接 / 数学 | 宿主的 3 空格 / 显示文字（无隐藏 URL）/ Unicode 公式。 |

来源按渲染数组身份存 WeakMap，绑定提交帧；工具外壳取实际文字、不额外 render。Markdown 复用可核对的宿主 token/代码高亮，不改主题/highlighter，仍逐行验证、保流式节流与降级；弱引用不常驻旧 token/整块数组，resize 不可重投影时回退。

同一同步调用内，同帧/源行/完整端点只序列化一次，诊断仍逐次计数；微任务末清复用，选区/帧/取列函数变化重算，失败不缓存。`/codex-ui` 报 `exact/mixed/native-fallback`、降级/失败；serializer 属于当前 TuiAltScreen 实例，替代 pi-copy-soft-wrap 原型启发式，后装实例包装仍可能冲突（`other-wrapper`）。

## 剪贴板

本地 WSL（排除 Windows Terminal、SSH/MOSH）预热 Windows 写入进程，经管道传输并等写入确认；Ctrl+C/宿主鼠标共用，保 Unicode、缩进、LF/CRLF/字面 BOM，不依赖 OSC52/clip.exe。初次可能等预热，启动失败/退出/超时可回退。

Windows Terminal、远程、非 WSL 或 `PI_CLIPBOARD_OSC52=1` 走 Pi 原生路径。关闭/重载/卸载取消请求并结束进程，不启迟到回退。

owner 为 `src/selection-copy/`；严格 PTY 验证实际回读，`scripts/copy-perf.mjs` 只测渲染/提取。
