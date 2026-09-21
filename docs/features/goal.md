# `/goal` 长任务模式

目标随会话 custom entry 保存，并从当前分支恢复。`/goal <objective>` 创建目标，空参数查看，`edit` 修改，`pause`/`resume` 控制续跑，`clear` 清除。

## 状态与工具

| 状态 | 行为 |
| --- | --- |
| `active` | 注入目标提示并在回合结束后按需续跑。 |
| `paused` / `blocked` / `usageLimited` | 停止自动续跑，可由用户恢复。 |
| `budgetLimited` | 已达到 token 预算，停止续跑。 |
| `complete` | 目标已完成，创建新目标时可替换。 |

| 工具 | 约束 |
| --- | --- |
| `create_goal` | 仅在明确要求时创建；只有明确要求预算时才设 `token_budget`；存在未完成目标时失败。 |
| `get_goal` | 读取状态、累计时间/用量和剩余预算。 |
| `update_goal` | 仅允许 `complete` / `blocked`；达成后才完成，同一阻塞连续三轮且陷入僵局才标记 blocked。不能用它暂停、恢复或设置额度状态。 |

UI 的暂停/恢复与工具契约不同。错误会停止续跑，额度类错误进入 `usageLimited`；无 UI 的中断直接暂停，有 UI 时询问用户是否暂停。

## 计时、用量与恢复

- active 状态每秒刷新 footer。刷新只读快照；状态切换、编辑和回合结算按整秒记账，保留剩余毫秒，不重复累计。
- 用量只记到开始该回合的目标；回合中清空并创建新目标不会把旧用量移给新目标。计费口径为去掉 cacheRead 的 input 加 output，无测量值时回退 totalTokens。
- 分支恢复沿用最后一条 goal 记录，不把离线时间算入 active 时长。提示上下文只保留当前目标最近一条续跑消息，并移除 UI 消息。
- `extensions/goal.ts` 拥有宿主 I/O、提示、命令和工具；`src/goal-state.ts` 的 `GoalState` 拥有状态、时钟与用量。持久化格式仍是 `goal` custom entry v2。

按包入口过滤 `"extensions": ["-goal.ts"]` 可禁用该功能，不影响其它入口。

源自 mitsuhiko/agent-stuff `extensions/goal.ts` @ `122e299`，本地增加逐秒刷新并重构状态所有权；Apache-2.0 归属见根目录 NOTICE 和 LICENSE-APACHE-2.0。行为由 `test/unit/goal.test.mts` 驱动真实扩展入口验证；当前覆盖与限制见 [VALIDATION](../../VALIDATION.md)。
