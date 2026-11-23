# 结构化提问

`ask_user_question` 在交互会话中显示问卷。需要开启全局 `[askUserQuestion].enabled`。通过 [`tool_search`](tool-discovery.md) 的 `describe` 查看参数并激活。Codemode 内使用同样的参数调用 `tools.tool_search`。

## 等待模式

| `mode` | 行为 |
| --- | --- |
| `blocking`（默认） | 等待提交、取消或执行中断。必须由用户决定的事项和授权请求使用此模式。 |
| `skip` | 整份问卷最多等待 10 分钟。超时时 `details.timedOut` 为 `true`，可继续执行其他已确定的工作。 |

超时状态由 `details.timedOut` 表示；用户授权和默认选择需要显式操作。终端草稿停留在编辑状态，RPC 已答题目随超时结果返回。

## 问卷

每次 1–4 题，每题 2–4 个选项。可以允许多选；用户也可自定义输入。预览只支持单选。Esc 取消；在自定义输入中按 Esc 返回选项列表。提交前可用 PageUp 和 PageDown 查看答案与备注。

## 配置

```toml
[askUserQuestion]
enabled = true
collapseKey = "ctrl+]"
```

`collapseKey = "off"` 关闭折叠快捷键，取消、确认和提交仍优先。`[askUserQuestion.guidance]` 可替换 `description`、`promptSnippet` 或 `promptGuidelines`；变更工具说明后运行 `/reload`。可用字段见[参数参考](../../metis-pi-config.md#askuserquestion)。实现与许可见[来源说明](../../src/ask-user-question/METIS.md)。
