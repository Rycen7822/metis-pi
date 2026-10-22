# metis-pi 文档

安装与更新见[中文 README](../README.zh-CN.md) / [English README](../README.md)。本目录说明当前用法；默认值与字段以[配置参考](configuration.md)为入口。

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
| MCP | [配置与连接](configuration.md#mcp) |
| 故障定位 | [诊断](diagnostics.md) · [兼容性](compatibility.md) |

## 维护

- [架构](architecture.md)：模块与所有权。
- [开发说明](development.md)：检查、构建、发布和预览生成。
- [Pi 文档指引](PI_Documentation_Guide.md)：SDK 文档定位模板。
- [执行来源](provenance/execution/README.md) · [子代理来源](provenance/subagents/README.md)：来源与许可；其他组件在各源码目录保留记录。
