# 操作速查

配置路径、默认值与入口开关见[配置参考](configuration.md)。

## 命令与工具

| 命令 | 用途 |
| --- | --- |
| `/codex-ui` | 显示、统计与复制[诊断](diagnostics.md)。 |
| `/metis-config` / `/metis-config init` | 查看配置路径 / 创建缺失的 TOML 和说明。 |
| `/execution` | 全局执行设置。 |
| `/metis-subagents` | 子代理状态和 `stop` / `continue` / `answer`。 |
| `/neural-search health` / `rescan` | 本地索引状态 / 重扫。 |
| `/websearch` / `/curator` / `/search` | 网页检索设置 / 策展流程 / 已存结果。 |
| `/goal [objective]` | 查看、创建或管理[目标](features/goal.md)。 |
| `/pruner` | 精简与恢复；常用 `status`、`settings`、`on`、`off`、`now`、`compact`。 |
| `/dynamic-agents [reload]` | 查看指令状态 / 下一 run 刷新。 |
| `/lsp` | 语言服务器配置与可用状态。 |
| `/mcp` / `/mcp reload` / `/mcp refresh [server]` | MCP 状态 / 重读配置 / 刷新目录。 |
| `/skill:<name>` / `￥<name>` | 调用或组合 skills。 |

`/settings`、`/reload`、`/compact` 等宿主命令由 Pi 提供。

| 模型工具 | 说明 |
| --- | --- |
| `goal` | [读取、创建与完成规则](features/goal.md)。 |
| `subagents_*` | [委派、等待、结果与清理](subagents/native.md)。 |
| `context_tree_query` | [历史证据与原文分页](features/condense.md#原文与分页恢复)。 |
| `exec_command` / `write_stdin` | [PTY 会话](execution.md)。 |
| `change_reasoning` | 开启 `autoReasoning` 后按模型能力提供。 |
| `lsp` | [diagnostics / fix](features/lsp.md)；fix 默认预览，`write: true` 才写入。 |
| `neural_search` | [本地路径与内容搜索](features/neural-search.md)。 |
| `web_access` / `session_recall` | [网页访问与会话检索](features/managed-plugins.md)。 |
| `ask_user_question` | [结构化决策](features/ask-user-question.md)。 |
| edit/write 的 `then_run` | [修改后执行命令](features/action-fusion.md)。 |

工具发现和权限由 Pi 管理；`lsp` 的只读策略还需按 `action` / `write` 限制。重复工具或命令只启用一个提供者。

## 按键与鼠标

| 默认操作 | 行为 |
| --- | --- |
| `ctrl+c` | fullscreen 有选区时复制并保留草稿；无选区时交回宿主。 |
| `ctrl+o` / `ctrl+t` / `esc` | 宿主的展开、思考显示与中断。 |
| `alt+w` / `alt+q` / `alt+e` / `alt+r` | 后台 shell 展开、上一项、下一项、关闭；可配置。 |
| 思考块左键 / 右键 / 滚轮 | 窥视、全展开与窗口滚动，见[思考块](features/display.md#思考块)。 |
| skill 左键 / 工具行左键 | 折叠 skill / 宿主工具展开。 |
| fullscreen 正文拖拽 | 应用选区，见[复制](features/selection-copy.md)。 |

按键提示跟随实际绑定。
