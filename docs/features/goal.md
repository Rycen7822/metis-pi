# `/goal` 长任务模式

目标以 session custom entry 保存，并从当前分支恢复。活动目标在回合结束后按需自动续跑。

## 命令与状态

| 命令 | 操作 |
| --- | --- |
| `/goal <objective>` | 创建目标 |
| `/goal` / `/goal edit` | 查看 / 修改 |
| `/goal pause` / `/goal resume` | 暂停 / 恢复续跑 |
| `/goal clear` | 清除目标 |

| 状态 | 行为 |
| --- | --- |
| `active` | 注入目标提示，按需续跑 |
| `paused` / `blocked` / `usageLimited` | 停止续跑，可由用户恢复 |
| `budgetLimited` | 达到 token 预算后停止续跑 |
| `complete` | 已完成，可由新目标替换 |

错误停止续跑，额度类错误进入 `usageLimited`。无 UI 的中断直接暂停，有 UI 时询问用户是否暂停。

## 模型工具契约

| 工具 | 约束 |
| --- | --- |
| `create_goal` | 仅在明确要求时创建；只有明确要求预算时才设 `token_budget`；存在未完成目标时失败 |
| `get_goal` | 读取状态、累计时间/用量和剩余预算 |
| `update_goal` | 本包工具只允许 `complete` / `blocked`；达成后才完成，同一阻塞连续三轮且陷入僵局才标记 blocked。不能暂停、恢复或设置额度状态 |

UI 暂停/恢复和模型工具权限不同。禁用本功能可过滤 `-extensions/goal.ts`，见 [配置](../configuration.md)。

## 计时、用量与恢复

- active 时每秒刷新 Footer，刷新只读快照。状态切换、编辑和回合结算按整秒记账，保留剩余毫秒，避免重复累计。
- 关闭、重载和分支恢复清理旧计时器与上下文引用；恢复的活动目标只启动一个计时器，离线时间不计入 active 时长。
- 用量归开始该回合的目标；中途清空并新建目标不转移旧用量。计费口径为去掉 cacheRead 的 input 加 output，无测量值时回退 totalTokens。
- 分支恢复取最后一条 goal 记录；提示上下文只留当前目标最近一次续跑消息，并移除 UI 消息。与 OCC 的续跑协调见 [历史压缩](condense.md)。

`extensions/goal.ts` 拥有宿主 I/O、提示、命令和工具，`src/goal-state.ts` 的 `GoalState` 拥有状态、时钟与用量；持久化格式为 `goal` custom entry v2。来源为 mitsuhiko/agent-stuff `extensions/goal.ts` @ `122e299`，Apache-2.0 归属见 [NOTICE](../../NOTICE) 和 [LICENSE-APACHE-2.0](../../LICENSE-APACHE-2.0)。真实入口验证见 [VALIDATION](../../VALIDATION.md)。
