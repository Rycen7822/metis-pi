# 长任务目标

目标与用量保存在当前 Pi session 分支；活动目标在回合结束后按需续跑。

| 命令 | 操作 |
| --- | --- |
| `/goal <objective>` / `/goal` | 创建或替换 / 查看。 |
| `/goal edit` / `pause` / `resume` / `clear` | 修改 / 暂停 / 恢复 / 清除。 |

`active` 允许续跑；`paused`、`blocked`、`usageLimited` 停止，可由用户恢复；`budgetLimited` 达到预算后停止，`complete` 可由新目标替换。错误停止续跑，额度错误进入 usageLimited；交互中断询问用户，无 UI 时暂停。

## 模型工具

`goal` 的权限与用户命令不同：

| action | 约束 |
| --- | --- |
| `get` | 只读状态、时间、用量和剩余预算。 |
| `create` | 必填 `objective`；仅用户或 system/developer 明确要求时创建，只有明确要求预算才传 `token_budget`。未完成目标不能替换。 |
| `update` | 仅 `status: "complete" / "blocked"`。实际达成且没有必需工作才 complete；同一阻塞连续至少三轮且已陷入僵局才 blocked。不能用来暂停、恢复或修改额度状态。 |

例如 `goal({action: "get"})`。不能因为停止工作或预算将尽宣告完成。

## 查看与编辑弹窗

在全屏界面点击左下目标状态行，或输入 `/goal` 打开弹窗；RPC/非交互模式使用文本查看。

- 弹窗与 Subagent 查看器采用相同的居中布局、90% 宽度、70% 高度和圆角外框；短目标也保持窗口大小。
- **Pause / Resume / Ctrl+P** 在查看模式暂停或恢复，语义与 `/goal pause`、`/goal resume` 相同；暂停不强制中断当前模型回合。
- 长目标显示右侧滚动条，支持滚轮、拖动，以及 ↑/↓、PageUp/PageDown、Home/End；编辑使用 Pi 原生编辑器。
- **Edit / Ctrl+E** 开始编辑；**Save / Ctrl+S** 校验保存。
- **Cancel / 编辑时 Esc** 放弃草稿，回到查看；查看时 **Esc / [X]** 关闭。
- 查看和取消不触发续跑。保存保留 ID、计时、用量和预算；编辑 complete 或 budgetLimited 目标恢复 active。
- 保存失败保留草稿；其他入口已修改目标时不覆盖。会话/分支切换或扩展关闭会丢弃草稿。

## 计时、用量与续跑

active 每秒刷新 Footer，状态变化和回合结算记账；重载、关闭和分支恢复释放旧 timer，不累计离线时间。

每轮用量归属于开始该轮的目标，新目标不继承旧回合。优先使用非缓存 input + output，缺失时回退 totalTokens；最终回复在 agent_end 后结算，所以完成工具回执不含尚未结束的回复用量。

提示保留当前目标的有效续跑消息；OCC 的维护和续跑协调见 [condense](condense.md)。状态与计账归 `src/goal/state.ts`，来源归属见 [NOTICE](../../NOTICE)。入口开关见[配置](../configuration.md)。
