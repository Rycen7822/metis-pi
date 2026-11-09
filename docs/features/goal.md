# 长任务目标

目标与用量保存在当前 Pi session 分支中，active 目标在回合结束后按需续跑。

| 命令 | 操作 |
| --- | --- |
| `/goal <objective>` / `/goal` | 创建或替换 / 查看。 |
| `/goal edit` / `pause` / `resume` / `clear` | 修改文本 / 暂停 / 恢复 / 清除。 |
| `/goal agent-edit` / `agent-edit off` | 授权一次编辑 / 撤销未使用的授权。 |

状态决定续跑：active 持续，paused/blocked/usageLimited 等待用户恢复，budgetLimited 到预算停止，complete 可被新目标替换。错误会停止续跑，额度错误进入 usageLimited；交互中断时询问用户，无 UI 时暂停。

## 模型工具

| action | 权限与条件 |
| --- | --- |
| `get` | 只读：状态、时间、用量、剩余预算，一次性 `agentEditToken`（无授权为 null）。 |
| `create` | 仅用户/system/developer 明确要求时创建，objective 必填；token_budget 同样只在明确要求时传递；旧目标完成后才能替换。 |
| `edit` | 凭一次性授权提交完整 objective/edit_token，只修改当前 active 目标的文本。 |
| `update` | 只接受 complete/blocked：complete 要求目标确已达成且无剩余工作，blocked 要求同一阻塞连续 3 轮以上且陷入僵局；暂停、恢复、额度状态使用各自命令。 |

标记 complete 的唯一依据是目标确已达成。

## Agent 一次性编辑授权

授权流程为：用户 `/goal agent-edit` → agent `goal({action:"get"})` 取得 agentEditToken → `goal({action:"edit",objective:"完整新目标",edit_token:"该token"})`。命令忙时作为 steering，空闲时启动处理，界面显示灰色授权标记。编辑内容必须来自用户明确要求，agent 自行补写需求、缩小目标、修改验收都超出授权范围。

- 保存成功消耗一次授权；空文本、超 4000 字符、token 或参数错误视为无效调用，授权保留。
- 只有 objective 可修改，ID、创建时间、状态、预算、累计用量、计时全部保留。
- 手改目标、暂停/停止/完成、清除/替换、切会话/分支、重载/关闭都会撤销授权；get、普通输入、日常计时记账保持原有行为。
- off 撤销授权，重新授权生成新 token，token 与授权一一对应。授权只在当前运行时有效，重启后需重新授权；已保存的编辑正常恢复。

这是命令/工具层面的能力门禁。进程内隔离不在其范围内，系统级隔离依赖 OS 沙箱。

## 查看与编辑弹窗

fullscreen 下点击目标状态行或 `/goal` 打开弹窗，RPC/非交互返回文本。弹窗与 Subagent 一致：居中，宽 90%、高 70%，橙色 `▏` 配深灰底；短目标保持自身高度。

| 操作 | 行为 |
| --- | --- |
| Pause / Resume | 停止后续续跑（当前回复继续）/ 按现有预算恢复暂停或停止。 |
| Clear | 仅 paused/complete 显示，清除后关闭；阻塞/限额可先 Pause。 |
| Edit / Ctrl+E；Save / Ctrl+S | 进入编辑 / 校验保存，编辑期间隐藏 Pause/Resume/Clear。 |
| Cancel / 编辑中 Esc；查看中 Esc / [X] | 丢弃草稿回查看 / 关闭。 |

查看与取消不影响续跑状态；保存保留 ID、计时、用量、预算，complete/budgetLimited 保存后回到 active。失败保留草稿，其他入口的新内容不受影响；切换会话/分支或关闭会丢失草稿。按钮隐藏只影响弹窗，斜杠命令权限不变。

## 计时、用量与续跑

active 状态下 Footer 每秒刷新，状态变化与回合结算时记账；旧 timer 及时释放，离线时间剔除。灰色 `Goal continue` 只分隔阶段，完整指令原样发给模型。

一轮用量记在开启它的目标上，换目标后按目标分别记账；优先非缓存 input+output，缺失回退 totalTokens。最终回复在 agent_end 后结算，完成工具回执只含当时已发生的用量。

续跑提示只保留当前目标的最后一条，模型正文按最新目标重拼，日志与排队输入保持原样。agent 编辑不另排队：当轮看 get/edit 回执，下轮看重建提示。OCC 协同见 [condense](condense.md)，状态与记账在 `src/goal/state.ts`，[来源](../../NOTICE)和[入口开关](../configuration.md)见对应指南。
