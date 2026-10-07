# 长任务目标

目标保存为 Pi session 的 `goal` custom entry v2，从当前分支恢复；活动目标在回合结束后按需续跑。

| 命令 | 操作 |
| --- | --- |
| `/goal <objective>` / `/goal` | 创建或替换 / 查看。 |
| `/goal edit` / `pause` / `resume` / `clear` | 修改 / 暂停 / 恢复 / 清除。 |

`active` 注入提示并续跑；`paused`、`blocked`、`usageLimited` 停止，可由用户恢复；`budgetLimited` 达到预算后停止；`complete` 可由新目标替换。错误停止续跑，额度错误进入 usageLimited；无 UI 的中断暂停，有 UI 时询问。

## 模型工具

| 工具 | 约束 |
| --- | --- |
| `create_goal` | 仅明确要求时创建，仅明确要求预算时设 token_budget；已有未完成目标时失败。 |
| `get_goal` | 读取状态、时间、用量和剩余预算。 |
| `update_goal` | 只允许 complete / blocked；实际达成才完成，同一阻塞连续三轮且陷入僵局才 blocked。不能暂停、恢复或设置额度状态。 |

UI 与模型权限不同；禁用入口见 [配置](../configuration.md)。

## 计时、用量与续跑

- active 每秒刷新 Footer，只读快照；状态切换和回合结算按整秒记账，保留余毫秒。
- 重载/关闭/分支恢复释放旧 timer/context；恢复目标只有一个计时器，不累计离线时间。
- 用量属于开始该回合的目标，新目标不继承旧回合用量；input 去掉 cacheRead 后加 output，无测量值时回退 totalTokens。
- 取分支最后一条 goal 记录；提示只保留当前目标最近续跑消息，移除 UI 消息。OCC 协调见 [condense](condense.md)。

入口拥有宿主 I/O；`src/goal-state.ts` 拥有状态和计账。Apache-2.0 来源与修改归属见 [NOTICE](../../NOTICE)。
