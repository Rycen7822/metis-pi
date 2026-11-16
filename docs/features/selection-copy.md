# 逻辑选区复制

在 fullscreen 中，应用选区通过宿主的 `app.clear` 复制逻辑原文。宿主缺失时才使用 Ctrl+C。软折行会被合并，真实换行、缩进和选中的语义前缀都保留。`selectionCopy.enabled` 与 `ctrlC` 控制能力与按键接管，见[配置](../configuration.md)。快捷键沿用宿主。

| 情况 | 行为 |
| --- | --- |
| 有选区 | 复制，保留草稿，并固定历史窗口。 |
| 无选区 | 交还宿主，由宿主清空或退出。 |
| 只选中 gutter、行号或省略提示 | 剪贴板与草稿都保持原样。 |
| 写入失败 | 选区与草稿原样保留。 |

regular 模式没有应用选区。Shift 拖拽等终端原生选择由终端自己处理。

## 输入框选区删除

fullscreen 的 Metis editor 中，若选区完全落在输入正文内，宿主的 Backspace 与 Delete 会一次删除整段，光标回到起点。一次原生撤销即可恢复。Ctrl+C 只负责复制。该功能独立于 `selectionCopy.enabled` 与 `ctrlC`。regular 模式和终端选区下不可用。

映射从已提交的画面中提取逻辑行，支持软折行、内滚动、Unicode 字素和粘贴块。粘贴标记部分被选中时，整个粘贴块一起删除，其余粘贴内容保留。留白原样保留。映射失效（正文跨区选择、选区变化、草稿变化）时，退回普通的光标删除。已复制的文字只存在于剪贴板中。

## 映射与回退

| 内容 | 处理方式 |
| --- | --- |
| Markdown 段落、标题、列表、引用、代码围栏；宿主 Text、展开的思考块；本包的 shell、diff、write | 与当前帧一致时才精确提取。 |
| 列表、引用、diff 符号与代码围栏 | 所选列覆盖时才复制。行号与 gutter 排除在外。 |
| 省略行 | 视为硬边界。两侧的文字各自独立。 |
| 表格、未知 token、图片、排版漂移、Spacer、结构性空行 | 交给原生提取。 |
| tab、链接、数学公式 | 分别使用宿主的 3 空格、显示文字（隐藏 URL 不计入），以及 Unicode 公式。 |

来源按渲染数组的身份存入 WeakMap，只认已提交的帧。工具外壳取实际文字，无需二次渲染。Markdown 复用可核对的宿主 token 与代码高亮。主题与 highlighter 沿用宿主。逐行验证，并保持流式节流与降级。弱引用及时释放。resize 导致映射失效时，回退到原生。

同一同步调用内，同一帧、同源行、完整端点只序列化一次。诊断仍逐次记录。在微任务末尾清空复用结果。选区、帧或取列函数变化时重新计算。单次失败不缓存。`/codex-ui` 报告 `exact`、`mixed`、`native-fallback`、降级与失败。serializer 属于当前 TuiAltScreen 实例，沿用 pi-copy-soft-wrap 原型的启发式。后装的实例包装可能冲突，显示为 `other-wrapper`。

## 剪贴板

本地 WSL 中（不含 Windows Terminal、SSH 与 MOSH），预热 Windows 写入进程，经管道传输，并等待写入确认。Ctrl+C 与宿主鼠标共用这条路径。它保留 Unicode、缩进、LF/CRLF 与字面 BOM，并绕开 OSC52 和 clip.exe 的限制。首次复制可能需要等待预热。启动失败、退出或超时时，回退到原生路径。

Windows Terminal、远端、非 WSL 环境，以及 `PI_CLIPBOARD_OSC52=1`，都使用 Pi 原生路径。关闭、重载或卸载会取消请求并结束进程。迟到的回退请求作废。

实现位于 `src/selection-copy/`。严格的 PTY 验收会实际回读剪贴板内容。`scripts/copy-perf.mjs` 只测量渲染与提取的成本。
