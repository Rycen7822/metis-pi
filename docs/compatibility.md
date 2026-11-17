# 兼容性

| 组件 | 要求 |
| --- | --- |
| Pi | 1.5.2。安装、运行与开发应使用同一 SDK 版本。 |
| Node.js | 22.19.0 或更新版本。 |
| 子代理 | Linux、WSL 或 Windows；Python 3.11 或更新版本。Windows 从 PATH 或 `py` 查找 Python。 |
| PTY | 随包提供 Linux x64 和 Windows x64 helper。Windows ConPTY 要求 Windows 10 1809 或更新版本。 |
| 路径与内容搜索 | Linux x64（glibc ≥ 2.31）或 Windows x64。安装时保留可选依赖 `ffi-rs`。 |
| 语义搜索 | Linux x64。自动安装运行包要求 glibc ≥ 2.39，见[语义搜索](features/neural-search.md#语义搜索)。 |

## 安装与重启

在受管 Pi 1.5.2 上，Metis 的安装钩子会准备补丁版 SDK。钩子未运行时，首次加载扩展也会尝试准备。安装后退出并重新启动 Pi；`/reload` 只能重载扩展。更新 Windows 原生库前，关闭正在使用该库的 Pi 进程。使用随包资产不需要 Rust 或 MSVC。

Windows 上使用 Git for Windows 提供的 Bash。如未安装在默认位置，在 Pi 的 `settings.json` 中设置 `shellPath`，例如 `"D:\\app\\Git\\bin\\bash.exe"`。不要指向用于启动 WSL 的 `bash.exe`。

## 与其他扩展一起使用

同一工具或命令只启用一个提供者，尤其是 `tool_search`、MCP 和 `/compact` 的扩展。显示层只接管能识别的 Pi 内置工具或 Metis 自有渲染器；第三方组件仍由第三方渲染。用 `/codex-ui` 检查当前进程接入了哪些组件。

需要终端原生滚动缓冲区时，使用 `--tui-mode regular` 或设置 `tuiMode: "regular"`。应用选区和历史分页属于全屏模式。

## 移动会话或停用扩展

移动或备份会话时，把同级 `<sessionId>-blobs/` 一并复制。检查点的账户与提供商限制见[远端压缩](features/codex-compaction.md)。停用相关入口前，先确认所需历史仍可恢复。更新子代理运行时前，按[生命周期](subagents/lifecycle.md)检查活动工作和清理状态。
