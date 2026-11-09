# metis-pi 文档

安装步骤在[中文 README](../README.zh-CN.md)或 [English README](../README.md)里；本目录逐项介绍用法，默认值以[配置参考](configuration.md)为准。

## 使用

| 需求 | 页面 |
| --- | --- |
| 命令、工具、按键 | [操作速查](commands.md) |
| 工具输出、diff、write 预览、思考块 | [转录显示](features/display.md) |
| 输入区、Working、Footer、历史、字形 | [界面](features/interface.md) |
| 选区与剪贴板 | [复制](features/selection-copy.md) |
| 多 skill 输入 | [skills](features/skills.md) |
| 委派与恢复 | [子代理](subagents/native.md) · [生命周期](subagents/lifecycle.md) |
| 持久目标与续跑 | [goal](features/goal.md) |
| `/compact`、检查点和模型切换 | [远端压缩](features/codex-compaction.md) |
| 工具历史精简、原文回读、OCC | [condense](features/condense.md) |
| 模型对应的全局规则 | [动态指令](features/dynamic-agents.md) |
| 修改后执行命令 | [Action Fusion](features/action-fusion.md) |
| PTY 会话和图片 | [执行工具](execution.md) |
| 网页与会话查询 | [内置扩展](features/managed-plugins.md) |
| 阻塞决策问卷 | [结构化提问](features/ask-user-question.md) |
| 诊断与单文件修复 | [LSP](features/lsp.md) |
| 路径、内容与语义检索 | [Neural Search](features/neural-search.md) |
| MCP | [配置与连接](configuration.md#mcp) |
| 故障定位 | [诊断](diagnostics.md) · [兼容性](compatibility.md) |

## 维护

模块归属见[架构](architecture.md)，检查与发布流程见[开发说明](development.md)，SDK 文档定位模板见[Pi 文档指引](PI_Documentation_Guide.md)。执行与子代理的来源和许可分别在[执行说明](provenance/execution/README.md)与[子代理来源](provenance/subagents/README.md)，其余组件的记录放在各自源码目录。
