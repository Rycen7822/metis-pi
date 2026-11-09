# 逻辑选区复制

fullscreen 的应用选区通过宿主 `app.clear` 复制逻辑原文（宿主缺失时才用 Ctrl+C）：软折行合并，真实换行、缩进与选中的语义前缀保留。`selectionCopy.enabled/ctrlC` 控制能力与按键接管，见[配置](../configuration.md)，快捷键沿用宿主。

| 情况 | 行为 |
| --- | --- |
| 有选区 | 复制、保留草稿、固定历史窗口。 |
| 无选区 | 交回宿主清空或退出。 |
| 只选 gutter、行号、省略提示 | 剪贴板与草稿均保持原样。 |
| 写入失败 | 选区与草稿原样保留。 |

regular 没有应用选区，Shift 拖拽等终端原生选择由终端处理。

## 输入框选区删除

fullscreen Metis editor 中，选区完全落在输入正文内时，宿主 Backspace/Delete 会一次删除整段，光标回到起点，一次原生撤销即可恢复；Ctrl+C 仅复制。该能力独立于 `selectionCopy.enabled/ctrlC`，regular 与终端选区下不可用。

映射从已提交画面提取逻辑行，支持软折行、内滚动、Unicode 字素与粘贴块；粘贴标记选中一部分时整块删除，其余粘贴保留。留白原样保留；映射失效（正文跨区选、选区变化、草稿变化）时退回普通光标删除，已复制文字仅存在于剪贴板。

## 映射与回退

| 内容 | 处理 |
| --- | --- |
| Markdown 段落、标题、列表、引用、围栏，宿主 Text、展开思考、本包 shell/diff/write | 与当前帧一致才精确提取。 |
| 列表、引用、diff 符号和围栏 | 所选列覆盖才复制，行号/gutter 排除在外。 |
| 省略行 | 视为硬边界，两侧文字各自独立。 |
| 表格、未知 token、图片、排版漂移、Spacer、结构空行 | 走原生提取。 |
| tab / 链接 / 数学 | 宿主的 3 空格 / 显示文字（隐藏 URL 排除）/ Unicode 公式。 |

来源按渲染数组身份存 WeakMap，只认提交帧；工具外壳取实际文字，无需二次 render。Markdown 复用可核对的宿主 token 和代码高亮，主题与 highlighter 沿用宿主，逐行验证并保持流式节流和降级；弱引用及时释放，resize 映射失效时回退原生。

同一同步调用内，同帧、同源行、完整端点只序列化一次，诊断仍逐次记录；微任务末清空复用，选区、帧、取列函数变化时重算，失败当次不缓存。`/codex-ui` 报告 `exact/mixed/native-fallback`、降级与失败；serializer 属于当前 TuiAltScreen 实例，沿用 pi-copy-soft-wrap 原型启发式，后装实例包装可能冲突（`other-wrapper`）。

## 剪贴板

本地 WSL（Windows Terminal、SSH/MOSH 除外）预热 Windows 写入进程，经管道传输并等待写入确认；Ctrl+C 与宿主鼠标共用，保留 Unicode、缩进、LF/CRLF、字面 BOM，绕开 OSC52/clip.exe 的限制。首次可能等待预热；启动失败、退出、超时时回退。

Windows Terminal、远端、非 WSL、`PI_CLIPBOARD_OSC52=1` 使用 Pi 原生路径。关闭、重载、卸载会取消请求并结束进程，迟到的回退请求作废。

owner 在 `src/selection-copy/`；严格 PTY 验收实际回读，`scripts/copy-perf.mjs` 只测渲染与提取。
