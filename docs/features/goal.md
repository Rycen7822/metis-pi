# 长任务目标

目标与用量保存在当前 Pi 会话分支的 custom entries 中。active 目标会在回合结束后按需续跑。

| 命令 | 操作 |
| --- | --- |
| `/goal <objective>`、`/goal` | 创建或替换；查看当前目标。 |
| `/goal edit`、`pause`、`resume`、`clear` | 修改文本；暂停；恢复；清除。 |
| `/goal agent-edit`、`/goal agent-edit off` | 授权一次 agent 编辑；撤销未使用的授权。 |

状态决定是否续跑。active 持续续跑。paused、blocked、usageLimited 等待用户恢复。budgetLimited 在预算耗尽时停止。complete 可以被新目标替换。错误会停止续跑。额度错误进入 usageLimited。交互中断时询问用户，无 UI 时暂停。

## 模型工具

| action | 权限与条件 |
| --- | --- |
| `get` | 只读。返回状态、时间、用量、剩余预算，以及一次性的 `agentEditToken`（无授权时为 null）。 |
| `create` | 仅在用户、system 或 developer 明确要求时使用。objective 必填。token_budget 同样只在明确要求时传入。旧目标完成后才能替换。 |
| `edit` | 凭一次性授权，提交完整的 objective 与 `edit_token`。只修改当前 active 目标的文本。 |
| `update` | 只接受 `complete` 或 `blocked`。`complete` 要求目标确已达成、没有剩余工作。`blocked` 要求同一阻塞连续出现 3 轮以上，并且确实陷入僵局。暂停、恢复和额度状态使用各自的命令。 |

只有目标确已达成，才能标记为 complete。

## agent 的一次性编辑授权

流程如下：用户执行 `/goal agent-edit`；agent 调用 `goal({action:"get"})` 取得 `agentEditToken`；然后调用 `goal({action:"edit",objective:"完整的新目标",edit_token:"该 token"})`。agent 忙碌时，授权请求作为 steering 处理。空闲时则立即启动处理。界面会显示灰色的授权标记。

编辑内容必须来自用户的明确要求。agent 自行补充需求、缩小目标或修改验收标准，都超出了授权范围。

- 保存成功会消耗一次授权。空文本、超过 4000 字符、token 或参数错误，都视为无效调用，授权保留。
- 只能修改 objective。ID、创建时间、状态、预算、累计用量和计时都保留。
- 手动修改目标、暂停、停止、完成、清除、替换、切换会话或分支、重载和关闭，都会撤销授权。`get`、普通输入和日常计时记账的行为不变。
- `off` 撤销授权。重新授权会生成新的 token，每个 token 与一次授权对应。授权只在当前运行时有效，重启后需要重新授权。已保存的编辑会正常恢复。

这是命令与工具层面的门禁，不是进程内隔离。系统级隔离依赖操作系统沙箱。

## 查看与编辑弹窗

fullscreen 下，点击目标状态行或执行 `/goal` 即可打开弹窗。RPC 与非交互模式返回文本。弹窗与子代理弹窗样式一致：居中，宽 90%、高 70%，橙色 `▏` 配深灰底。短目标保持自身高度。

| 操作 | 行为 |
| --- | --- |
| Pause、Resume | 暂停后停止后续续跑，当前回复继续。恢复按现有预算重新续跑。 |
| Clear | 仅在 paused 或 complete 时显示。清除后关闭弹窗。阻塞或限额状态下，需先 Pause。 |
| Edit（Ctrl+E）、Save（Ctrl+S） | 进入编辑；校验后保存。编辑期间隐藏 Pause、Resume 与 Clear。 |
| 编辑中 Esc；查看中 Esc 或 [X] | 丢弃草稿并回到查看；查看中则关闭弹窗。 |

查看和取消不影响续跑状态。保存会保留 ID、计时、用量与预算。complete 或 budgetLimited 的目标保存后回到 active。保存失败时保留草稿。其他入口的新内容不受影响。切换会话或分支、关闭弹窗，都会丢失草稿。按钮隐藏只影响弹窗，斜杠命令的权限不变。

## 计时、用量与续跑

active 状态下，Footer 每秒刷新。状态变化和回合结算时记账。旧 timer 在状态变化后及时释放。离线时间不计入。灰色的 `Goal continue` 只起分隔作用，完整指令原样发送给模型。

一轮的用量记在开启它的目标上。换目标后，各目标分别记账。优先使用非缓存的 input 与 output 之和，缺失时回退到 totalTokens。最终回复在 `agent_end` 之后结算。完成工具的回执只包含当时已经发生的用量。

续跑提示只保留当前目标的最后一条。模型正文按最新目标重新拼接。日志和排队的输入保持原样。agent 编辑不另外排队：本轮看 get 与 edit 的回执，下一轮看重建后的提示。与 OCC 的协同见 [condense](condense.md)。状态与记账实现在 `src/goal/state.ts`。来源见 [NOTICE](../../NOTICE)，入口开关见[配置](../configuration.md)。
