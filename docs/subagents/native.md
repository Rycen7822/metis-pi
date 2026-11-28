# Pi 子代理

Metis 子代理在独立的 Pi 会话中执行任务。每个父会话有自己的范围（scope），可重新打开已保存的子会话和结果。

## 要求与配置

需要 Pi 1.7.0、Node.js 22.19.0 或更新版本、Python 3.11 或更新版本。支持 Linux、WSL 和 Windows。子代理使用父端的 Node、SDK 和 agent 目录；Windows 从 PATH 或 `py` 查找 Python。

全局 `[subagents]` 控制开关、容量、超时与额外环境变量。`[subagents.profiles.<name>]` 选择工具、扩展和 skills，也可覆盖模型和推理级别。模型与权限应在启动前确认。`access: "read"` 仅限制工具列表；操作系统隔离由外部沙箱负责。并发写入任务使用互不重叠的工作目录，实际文件访问由操作系统权限控制。配置字段见 [参数参考](../../metis-pi-config.md#subagentsnative-pi)。

启用时可用 [`subagent-delegation`](../../skills/subagent-delegation/SKILL.md)。关闭模块并重载会隐藏工具与 skill；正在运行的任务继续执行。

## 委派与查看

通过 [`tool_search`](../features/tool-discovery.md) 查找 `subagents_*`。分派时给出工作目录、允许的操作、必要背景和验收标准；子会话通过显式输入获取任务上下文。

| 工具 | 操作 |
| --- | --- |
| `subagents_spawn_agent` | 创建子代理并启动任务。 |
| `subagents_wait_agent`、`subagents_agent_result` | 等待任务或问题；读取指定 run 的结果。 |
| `subagents_list_agents`、`subagents_inspect_agent` | 查看状态、历史和投递收据。 |
| `subagents_answer_agent` | 回答已投递的待处理问题。 |
| `subagents_followup_task` | 在保存的子会话中启动后续任务。 |
| `subagents_send_message` | 保存备注；空闲的子代理保持原状态。 |
| `subagents_interrupt_agent` | 中断当前任务；写代理停驻后释放目录写入资格，历史和已有修改不受影响。 |

`/metis-subagents` 列出子代理。全屏可打开只读转录，也可点击活动子代理直接查看。用 `/metis-subagents stop <agent>`、`continue <agent> <task>` 或 `answer <agent>` 操作任务。结果投递由收据确认，转录查看仅供检查。

`completed` 标记执行结束，验收需检查产物；若 `has_more` 为 true，继续读取结果分页。投递、重试与升级规则见 [生命周期](lifecycle.md)。

## 本地数据

状态保存在 `<agentDir>/metis/subagent/`：`registry.sqlite` 记录任务和收据，`agents/` 保存子会话，`results/` 保存分页结果。父端重载后这些数据仍然保留，账本由子代理运行时独占写入。
