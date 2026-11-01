# 长任务目标

目标与用量保存在当前 Pi session 分支；活动目标在回合结束后按需续跑。

| 命令 | 操作 |
| --- | --- |
| `/goal <objective>` / `/goal` | 创建或替换 / 查看。 |
| `/goal edit` / `pause` / `resume` / `clear` | 修改 / 暂停 / 恢复 / 清除。 |
| `/goal agent-edit` / `/goal agent-edit off` | 授权 agent 成功编辑一次当前 active 目标 / 撤销未使用授权。 |

`active` 允许续跑；`paused`、`blocked`、`usageLimited` 停止，可由用户恢复；`budgetLimited` 达到预算后停止，`complete` 可由新目标替换。错误停止续跑，额度错误进入 usageLimited；交互中断询问用户，无 UI 时暂停。

## 模型工具

`goal` 的权限与用户命令不同：

| action | 约束 |
| --- | --- |
| `get` | 只读状态、时间、用量和剩余预算；`agentEditToken` 是当前一次性编辑授权，未授权时为 null。 |
| `create` | 必填 `objective`；仅用户或 system/developer 明确要求时创建，只有明确要求预算才传 `token_budget`。未完成目标不能替换。 |
| `edit` | 仅用户输入 `/goal agent-edit` 后，提交完整 `objective` 和从 `get` 读取的 `edit_token`；只改当前 active 目标文本。 |
| `update` | 仅 `status: "complete" / "blocked"`。实际达成且没有必需工作才 complete；同一阻塞连续至少三轮且已陷入僵局才 blocked。不能用来暂停、恢复或修改额度状态。 |

例如 `goal({action: "get"})`。不能因为停止工作或预算将尽宣告完成。

## Agent 一次性编辑授权

默认禁止 agent 编辑目标。用户先输入 `/goal agent-edit`，agent 再读取 `goal({action: "get"})`，
用返回的 `agentEditToken` 调用 `goal({action: "edit", objective: "完整新目标", edit_token: "读取的授权"})`。
命令会通知 agent；忙碌时作为 steering 输入在后续模型请求中处理，空闲时启动处理。界面显示灰色授权标记。
授权不表示可以自行缩小目标、编造需求或修改验收标准，修改内容必须来自用户明确要求。

- 每次成功保存即消耗授权；空文本、超过4000字符、错误 token 或非法参数失败，不消耗有效授权。
- 仅接受 `objective` 和 `edit_token`，不能借编辑修改状态、预算、累计用量或时间；目标 ID 与创建时间不变。
- 用户手动修改目标、暂停/停止/完成、清除/替换、切换会话或分支、重载/关闭均撤销授权。
- `get`、普通输入和未触发预算停止的计时/记账不撤销；需要再次成功编辑时必须重新授权。
- `/goal agent-edit off` 可主动撤销；重新授权生成新 token，旧请求不能借用新授权。
- 授权仅在当前扩展运行时有效，不从会话日志恢复。已保存的目标编辑仍照常恢复。

这是命令与模型工具之间的能力门控，不是操作系统沙箱。Pi 命令也可由可信扩展或 RPC 调用，
因此不把它描述为能够鉴别物理键盘输入或防范同进程恶意扩展。

## 查看与编辑弹窗

在全屏界面点击左下目标状态行，或输入 `/goal` 打开弹窗；RPC/非交互模式使用文本查看。
弹窗与 Subagent 一样居中，占终端宽度90%、高度70%，使用橙色 `▏` 左边线和深灰背景；短目标也填满相同高度。

- **Pause** 暂停后续自动续跑；不主动中止当前正在生成的回复。**Resume** 恢复暂停或停止的目标，沿用当前预算。
- **Clear** 仅在 paused 或 complete 状态显示，清除后关闭弹窗。阻塞或限额停止的目标可先 Pause 再清除。
- 编辑草稿时隐藏 Pause / Resume / Clear；斜杠命令的能力保持不变。
- **Edit / Ctrl+E** 开始编辑；**Save / Ctrl+S** 校验保存。
- **Cancel / 编辑时 Esc** 放弃草稿，回到查看；查看时 **Esc / [X]** 关闭。
- 查看和取消不触发续跑。保存保留 ID、计时、用量和预算；编辑 complete 或 budgetLimited 目标恢复 active。
- 保存失败保留草稿；其他入口已修改目标时不覆盖。会话/分支切换或扩展关闭会丢弃草稿。

## 计时、用量与续跑

active 每秒刷新 Footer，状态变化和回合结算记账；重载、关闭和分支恢复释放旧 timer，不累计离线时间。
自动续跑时，上一阶段回复与下一阶段输出之间显示灰色 `Goal continue`。界面只显示这个标记，完整续跑指令仍发给模型，不额外添加消息。

每轮用量归属于开始该轮的目标，新目标不继承旧回合。优先使用非缓存 input + output，缺失时回退 totalTokens；最终回复在 agent_end 后结算，所以完成工具回执不含尚未结束的回复用量。

提示只保留当前目标最后一条续跑消息，并以当前目标重建其模型上下文正文，不修改原始日志或用户排队输入。
agent 编辑不额外排队续跑；当前回合以最新 `goal get/edit` 回执为准，下一轮重建目标提示。
OCC 的维护和续跑协调见 [condense](condense.md)。状态与计账归 `src/goal/state.ts`，来源归属见 [NOTICE](../../NOTICE)。入口开关见[配置](../configuration.md)。
