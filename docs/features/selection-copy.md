# 逻辑选区复制

fullscreen 模式下，选中内容后按 `Ctrl+C` 可复制显示内容对应的逻辑文本：合并软折行，保留真实换行、缩进和选中的语义前缀。开关为 `selectionCopy.enabled` 与 `selectionCopy.ctrlC`，见 [配置](../configuration.md)。

## 按键与草稿

| 情况 | 行为 |
| --- | --- |
| 有选区 | 复制逻辑文本，不清草稿 |
| 无选区 | 交回宿主原有清空草稿、双击退出等行为 |
| 全部选中内容都是 gutter、行号或省略提示 | 不写剪贴板、不清草稿 |
| 剪贴板写入失败 | 保留选区和草稿 |

键位来自宿主 `app.clear` 动作，读取不到才回退 `\x03`，不另注册快捷键。选区存在时固定已提交历史窗口，见 [fullscreen 布局](fullscreen-layout.md)。

## 内容与回退

`/codex-ui` 报告最近一次复制的模式和字符数：`exact` 表示全部行可精确映射，`mixed` 表示部分行保守回退，`native-fallback` 表示整体使用宿主提取。

| 内容 | 处理 |
| --- | --- |
| Markdown 段落、标题、列表、引用、代码围栏；宿主 Text；展开的 thinking；本包 shell/diff/write | 在当前渲染结果与映射一致时精确提取 |
| 列表 marker、引用前缀、diff 增删符号、代码围栏 | 所选列覆盖时才复制 |
| 行号、gutter | 装饰，不复制 |
| 截断省略行 | 作为硬边界，不把两端误拼成连续文本 |
| 表格、未知 token、图片、highlight 行数漂移、Spacer/结构空行 | 原生回退，不猜测逻辑结构 |
| tab、链接、数学块 | 分别按宿主显示口径转为 3 空格、只取显示文本、取渲染后的 Unicode；不附加隐藏 URL |

regular 模式没有应用内 TUI 选区；Shift 拖拽等终端原生选区由终端处理。resize 后的旧选区按当前帧坐标解析，无法安全重投影的行保守回退。

## 剪贴板传输

本地 WSL 缺少 Linux 剪贴板工具时，捕获 fullscreen 界面会预热一个 Windows 剪贴板写入进程。后续复制经管道传输，收到实际写入确认后才显示成功；Ctrl+C、鼠标复制和其它宿主选区复制共用此路径。

- 保留中文、emoji、缩进、LF/CRLF 和字面 BOM，不使用会改写换行的 `clip.exe`，也不依赖终端已许可 OSC 52。
- Windows Terminal 已有快速通道、远程会话和非 WSL 环境沿用宿主路径。
- 启动失败、退出或超时可回退宿主；首次复制仍可能等待预热就绪，发送成功不等于复制成功。
- 一个界面只持有一个写入进程。卸载、重载或关闭时取消请求并结束进程，不在关闭后启动迟到的回退复制。

## 实现与兼容

渲染时生成逐行、逐列的文本映射，按渲染数组身份保存在 WeakMap，绑定当前已提交帧。布局适配覆盖 Box/Container；宿主工具自绘外壳绑定实际已渲染文本，不额外渲染一次。Markdown 词法和折行按宿主规则处理，映射与真实输出不一致就回退；镜像重建节流及降级计数可在诊断中查看。

选区 serializer 安装在当前 **TuiAltScreen 实例** 上，因此覆盖原型链上 pi-copy-soft-wrap 的旧启发式包装；这不保证任意插件后来直接覆盖同一实例仍能共存。`other-wrapper` 报告检测到的外来包装，能力重复时可按 Pi 包配置停用其中一个。

入口由 `src/chrome/install.ts` 捕获 TUI。实现位于 `src/selection-copy/`：`index.ts` 管安装与路由，`serialize.ts` 管提取，`markdown.ts` / `structure.ts` 管映射，`clipboard.ts` / `windows-clipboard.ts` 管系统写入与清理。

复制的字符串正确性、帧漂移和进程生命周期分别由 contract/resource 测试覆盖；严格 PTY 验证真实复制回读。`scripts/copy-perf.mjs` 只测提取与渲染，不能代替系统剪贴板延迟测量。执行证据见 [VALIDATION](../../VALIDATION.md)。
