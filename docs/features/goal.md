# 长任务目标

目标/用量保存在当前 Pi session 分支；active 目标在回合结束后按需续跑。

| 命令 | 操作 |
| --- | --- |
| `/goal <objective>` / `/goal` | 创建或替换 / 查看。 |
| `/goal edit` / `pause` / `resume` / `clear` | 修改 / 暂停 / 恢复 / 清除。 |
| `/goal agent-edit` / `agent-edit off` | 授权成功编辑一次 / 撤销未用授权。 |

active 可续跑；paused/blocked/usageLimited 停止，可由用户恢复；budgetLimited 达预算停止，complete 可被新目标替换。错误停止续跑，额度错误进入 usageLimited；交互中断询问用户，无 UI 时暂停。

## 模型工具

| action | 权限与条件 |
| --- | --- |
| `get` | 只读状态、时间、用量、剩余预算及一次性 `agentEditToken`（无授权为 null）。 |
| `create` | 仅用户/system/developer 明确要求才创建，必填 objective；只有明确要求才传 token_budget，未完成目标不可替换。 |
| `edit` | 需下述一次性授权，提交完整 objective/edit_token，仅改当前 active 目标文本。 |
| `update` | 仅 complete/blocked；确已达成且无必需工作才 complete，同一阻塞连续 ≥3 轮且陷僵局才 blocked，不用于暂停/恢复/额度状态。 |

不能因为停止工作或预算将尽宣告完成。

## Agent 一次性编辑授权

用户 `/goal agent-edit` → agent `goal({action:"get"})` 取 agentEditToken → `goal({action:"edit",objective:"完整新目标",edit_token:"该token"})`。命令忙时作为 steering、空闲时启动处理，界面显示灰色授权标记；授权不允许编造需求、缩小目标或变验收，编辑内容须来自用户明确要求。

- 成功保存消耗一次；空文本、>4000 字符、错误 token/参数失败不耗有效授权。
- 只能改 objective，ID/创建时间/状态/预算/累计用量/计时不变。
- 手动改目标、暂停/停止/完成、清除/替换、切会话/分支、重载/关闭均撤销；get、普通输入及未触发预算停止的计时/记账不撤销。
- off 撤销，重新授权生成新 token；旧请求不能借新授权。授权只在当前运行时有效，不从日志恢复，已保存编辑仍恢复。

这是命令/工具能力门控，不是 OS 沙箱或物理键盘鉴别；可信扩展/RPC 也可调用 Pi 命令，不能防同进程恶意扩展。

## 查看与编辑弹窗

fullscreen 点目标状态行或 `/goal` 打开，RPC/非交互返回文本。与 Subagent 同为居中 90% 宽×70% 高、橙色 `▏`/深灰背景，短目标不缩高。

| 操作 | 行为 |
| --- | --- |
| Pause / Resume | 停后续续跑（不打断当前回复）/ 沿现预算恢复暂停或停止状态。 |
| Clear | 仅 paused/complete 显示，清后关闭；阻塞/限额可先 Pause。 |
| Edit / Ctrl+E；Save / Ctrl+S | 编辑 / 校验保存，编辑中隐藏 Pause/Resume/Clear。 |
| Cancel / 编辑中 Esc；查看中 Esc / [X] | 弃草稿回查看 / 关闭。 |

查看/取消不续跑；保存保 ID/计时/用量/预算，complete/budgetLimited 编辑后恢复 active。失败留草稿，不覆盖其他入口的新修改；切会话/分支或关闭丢草稿。斜杠命令权限不因按钮隐藏改变。

## 计时、用量与续跑

active 每秒刷新 Footer，状态变化/回合结算记账，释放旧 timer 且不计离线时间。灰色 `Goal continue` 分隔阶段，完整指令仍发模型，不额外添消息。

轮次用量归开始它的目标，不转给新目标；优先非缓存 input+output，缺失回退 totalTokens。最终回复在 agent_end 后结算，完成工具回执不含该回复未结束用量。

仅保留当前目标最后一条续跑提示，按最新目标重建模型正文，不改日志/排队输入；agent 编辑不额外排队，当前轮以 get/edit 回执、下轮以重建提示为准。OCC 协调见 [condense](condense.md)，状态/计账归 `src/goal/state.ts`，[来源](../../NOTICE)与[入口开关](../configuration.md)另见指南。
