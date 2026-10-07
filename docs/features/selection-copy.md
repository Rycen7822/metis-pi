# 逻辑选区复制

fullscreen 选区按 Ctrl+C 复制对应逻辑文本：合并软折行，保留真实换行、缩进和选中的语义前缀。开关见 [配置](../configuration.md)。

| 情况 | 行为 |
| --- | --- |
| 有选区 | 复制，不清草稿；存在选区时固定历史窗口。 |
| 无选区 | 交回宿主清空/退出行为。 |
| 只选中 gutter、行号或省略提示 | 不写剪贴板、不清草稿。 |
| 写入失败 | 保留选区和草稿。 |

路由读取宿主 `app.clear` 键位，缺失才用 Ctrl+C，不另注册快捷键。regular 模式无应用选区；Shift 拖拽等终端原生选择由终端处理。

## 映射与回退

| 内容 | 处理 |
| --- | --- |
| Markdown 段落、标题、列表、引用、围栏；宿主 Text；展开思考；本包 shell/diff/write | 映射与当前帧一致时精确提取。 |
| 列表/引用/diff 符号和围栏 | 仅所选列覆盖时复制；行号与 gutter 不复制。 |
| 省略行 | 硬边界，不能误拼首尾。 |
| 表格、未知 token、图片、排版漂移、Spacer/结构空行 | 原生回退。 |
| tab、链接、数学块 | 按宿主显示转为 3 空格、显示文字、渲染 Unicode，不追加隐藏 URL。 |

映射按渲染数组身份保存在 WeakMap，绑定已提交帧；工具外壳读取实际渲染文字，不额外 render。resize 无法安全重投影时保守回退。

`/codex-ui` 报告 `exact` / `mixed` / `native-fallback`、镜像降级与最近失败。serializer 安装在当前 TuiAltScreen 实例，覆盖 pi-copy-soft-wrap 的原型启发式包装；后装实例包装仍可能冲突，`other-wrapper` 报告已检测来源。

## 剪贴板

本地 WSL 缺少 Linux 剪贴板工具时预热一个 Windows 写入进程，经管道传输，收到写入确认才报成功。Ctrl+C 与宿主鼠标复制共用该路径，保留 Unicode、缩进、LF/CRLF 和字面 BOM，不依赖 OSC 52 或 clip.exe。

Windows Terminal 快速通道、远程和非 WSL 环境沿用宿主路径。启动失败、退出或超时可回退；首次复制仍可能等待预热。关闭、重载和卸载取消请求、结束进程，不启动迟到回退。

`src/selection-copy/` 持有映射、提取、传输与清理。严格 PTY 验证实际复制回读，`scripts/copy-perf.mjs` 仅测渲染/提取成本。
