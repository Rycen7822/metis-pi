# 诊断

在出现问题的会话中执行 `/codex-ui`。报告只描述当前 Pi 进程，包含版本、终端模式、有效配置和各显示组件的状态。

| 现象 | 检查与处理 |
| --- | --- |
| 配置未生效 | 先用 `/metis-config` 核对文件路径，再按[配置参考](configuration.md)重载或重启。 |
| 工具显示与预期不同 | 查看 `transcript` 和 `chrome`。第三方渲染器不由 Metis 接管。 |
| 全屏看不到最新输出 | 查看 `history-window`。出现 `Later history` 时，向下翻页或[跳到最新](features/interface.md#全屏历史与留白)。 |
| 复制带有软换行 | 查看 `selection-copy` 和 `copy-stats`；`native-fallback` 表示使用了 Pi 原生提取。 |
| 用量或速度不符合预期 | 先比对[统计口径](features/interface.md#统计口径)。状态栏的估算不用于计费。 |
| 模型、指令或整理状态有误 | 用 `/model` 核对当前模型；用 `/dynamic-agents` 或 `/pruner status` 查看策略。 |
| 工具未注册或不可用 | 用 [tool_search](features/tool-discovery.md) 核对目录；再检查 `/mcp`、`/lsp`、`/neural-search health` 或 `/metis-subagents`。 |

报告问题时附上 Pi 与 Metis 版本、终端模式、复现步骤和相关诊断字段。发送前移除密钥、私人路径和会话正文。
