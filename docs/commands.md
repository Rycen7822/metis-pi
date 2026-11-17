# 操作速查

## 斜杠命令

| 命令 | 用途 |
| --- | --- |
| `/metis-config`、`/metis-config init` | 查看全局配置路径；生成缺失的 TOML 和说明。 |
| `/codex-ui` | 查看本进程的显示、用量与[诊断](diagnostics.md)。 |
| `/execution` | 修改[执行设置](execution.md)。 |
| `/pruner` | 管理[历史整理](features/condense.md)。常用子命令：`status`、`settings`、`on`、`off`、`now`、`compact`。 |
| `/goal [objective]` | 查看、创建或管理[目标](features/goal.md)。 |
| `/dynamic-agents [reload]` | 查看[指令](features/dynamic-agents.md)；在下一次运行时刷新。 |
| `/metis-subagents` | 查看[子代理](subagents/native.md)；管理运行时或回答待处理的问题。 |
| `/neural-search health`、`/neural-search rescan` | 查看[本地索引](features/neural-search.md)状态或请求重扫。 |
| `/lsp` | 检查[语言服务器](features/lsp.md)的配置与可用性。 |
| `/mcp`、`/mcp reload`、`/mcp refresh [server]` | 查看状态、重读配置或刷新 [MCP 工具目录](configuration.md#mcp)。 |
| `/btw [问题]`、`/websearch`、`/curator`、`/search` | [旁路对话和网页工具](features/managed-plugins.md)。 |
| `/skill:<name>`、`￥<name>` | 展开 [skill](features/skills.md)。 |

`/settings`、`/reload` 和 `/compact` 是 Pi 命令。`/reload` 重载扩展，不替换运行中的 SDK。

## 模型工具

| 工具 | 参考 |
| --- | --- |
| `tool_search` | [发现工具和读取参数定义](features/tool-discovery.md) |
| `exec_command`、`write_stdin`、`change_reasoning` | [执行与会话](execution.md) |
| `edit`、`write` 的 `then_run` | [修改后执行命令](features/action-fusion.md) |
| `context_tree_query` | [原文查询](features/condense.md#原文与分页恢复) |
| `goal`、`subagents_*`、`ask_user_question` | [目标](features/goal.md)、[委派](subagents/native.md)、[提问](features/ask-user-question.md) |
| `lsp`、`neural_search` | [诊断与修复](features/lsp.md)、[本地搜索](features/neural-search.md) |
| `web_access`、`session_recall` | [网页访问与会话检索](features/managed-plugins.md) |

## 按键与鼠标

| 默认操作 | 用途 |
| --- | --- |
| Ctrl+C | 全屏有应用选区时[复制](features/selection-copy.md)；无选区时交给 Pi。 |
| Ctrl+O、Ctrl+T、Esc | 展开工具输出、切换思考显示、中断。 |
| Alt+W、Alt+Q、Alt+E、Alt+R | 展开后台 shell、上一项、下一项、关闭。可在 `[execution.ui]` 修改。 |
| 单击工具行或 skill 标题 | 切换展开。思考块另有[鼠标操作](features/display.md#思考块)。 |
| Ctrl+End | 在全屏[跳到最新消息](features/interface.md#全屏历史与留白)。 |

界面提示显示当前实际绑定。
