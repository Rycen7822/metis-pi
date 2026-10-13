# 长任务目标

目标保存为 Pi session 的 `goal` custom entry v2，从当前分支恢复；活动目标在回合结束后按需续跑。

| 命令 | 操作 |
| --- | --- |
| `/goal <objective>` / `/goal` | 创建或替换 / 查看。 |
| `/goal edit` / `pause` / `resume` / `clear` | 修改 / 暂停 / 恢复 / 清除。 |

`active` 注入提示并续跑；`paused`、`blocked`、`usageLimited` 停止，可由用户恢复；`budgetLimited` 达到预算后停止；`complete` 可由新目标替换。错误停止续跑，额度错误进入 usageLimited；无 UI 的中断暂停，有 UI 时询问。

## 模型工具

统一使用 `goal` 工具，必填 `action`：

| action | 参数与约束 |
| --- | --- |
| `get` | 读取状态、时间、用量和剩余预算，不修改目标。 |
| `create` | 必填 `objective`，可选 `token_budget`。仅用户或 system/developer 明确要求时创建，仅明确要求预算时设置；已有未完成目标时失败，已完成目标可替换。 |
| `update` | 必填 `status`，只允许 `complete` / `blocked`；实际达成且无剩余必需工作才完成，同一阻塞连续至少三轮且陷入僵局才 blocked。不能因停止工作或预算将尽而完成，也不能暂停、恢复或设置额度状态。 |

例如 `goal({action: "get"})`、`goal({action: "create", objective: "完成指定任务"})`、`goal({action: "update", status: "complete"})`。必填字段按 action 校验；状态持久化和 `/goal` 命令保持不变。

UI 与模型权限不同；禁用入口见 [配置](../configuration.md)。

## 计时、用量与续跑

- active 每秒刷新 Footer，只读快照；状态切换和回合结算按整秒记账，保留余毫秒。
- 重载/关闭/分支恢复释放旧 timer/context；恢复目标只有一个计时器，不累计离线时间。
- 用量属于开始该回合的目标，新目标不继承旧回合用量；Pi 的 input 已排除 cacheRead，直接加 output，无测量字段时回退 totalTokens。完成工具回执显示当时用量，最终回复的用量在 agent_end 后结算。
- 取分支最后一条 goal 记录；提示只保留当前目标最近续跑消息，移除 UI 消息。OCC 协调见 [condense](condense.md)。

入口拥有宿主 I/O；`src/goal-state.ts` 拥有状态和计账。Apache-2.0 来源与修改归属见 [NOTICE](../../NOTICE)。
