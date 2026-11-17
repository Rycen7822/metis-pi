# Pi 子代理

Metis 子代理在独立的 Pi 会话中执行任务。每个父会话有自己的范围（scope）；可重新打开已保存的子会话和结果，不会重放旧任务。

## 要求与配置

需要 Pi 1.5.2、Node.js 22.19.0 或更新版本、Python 3.11 或更新版本。支持 Linux、WSL 和 Windows。子代理使用父端的 Node、SDK 和 agent 目录；Windows 从 PATH 或 `py` 查找 Python。

全局 `[subagents]` 控制开关、容量、超时与额外环境变量。`[subagents.profiles.<name>]` 选择工具、扩展和 skills，也可覆盖模型和推理级别。模型与权限应在启动前确认。`access: "read"` 是工具策略，不是系统沙箱。并发写入任务使用互不重叠的工作目录；目录声明不能约束进程实际写入的位置。配置字段见[参数参考](../../metis-pi-config.md#subagentsnative-pi)。

启用时可用 [`subagent-delegation`](../../skills/subagent-delegation/SKILL.md)。关闭模块并重载会隐藏工具与 skill，不会终止正在运行的任务。

## 委派与查看

通过 [`tool_search`](../features/tool-discovery.md) 查找 `subagents_*`。分派时给出工作目录、允许的操作和验收标准。不要假定子代理能读取父会话的对话。

| 工具 | 操作 |
| --- | --- |
| `subagents_spawn_agent` | 创建子代理并启动任务。 |
| `subagents_wait_agent`、`subagents_agent_result` | 等待任务或问题；读取指定 run 的结果。 |
| `subagents_list_agents`、`subagents_inspect_agent` | 查看状态、历史和投递收据。 |
| `subagents_answer_agent` | 回答已投递的待处理问题。 |
| `subagents_followup_task` | 在保存的子会话中启动后续任务。 |
| `subagents_send_message` | 保存备注；不启动空闲的子代理。 |
| `subagents_interrupt_agent` | 中断当前任务，保留历史和可能已产生的修改。 |

`/metis-subagents` 列出子代理。全屏可打开只读转录，也可点击活动子代理直接查看。用 `/metis-subagents stop <agent>`、`continue <agent> <task>` 或 `answer <agent>` 操作任务。查看转录不会确认结果投递。

结果显示 `completed` 只表示执行结束。请检查产物；若 `has_more` 为 true，继续读取结果分页。投递、重试与升级规则见[生命周期](lifecycle.md)。

## 本地数据

状态保存在 `<agentDir>/metis/subagent/`：`registry.sqlite` 记录任务和收据，`agents/` 保存子会话，`results/` 保存分页结果。父端重载不会删除这些数据。不要用其他工具改写账本。
