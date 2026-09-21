# `/goal` 长任务模式

> 给会话挂一个持久目标，让 agent 跨多轮持续朝它推进；目标状态随会话记录走，不依赖外部数据库。

| | |
| --- | --- |
| 入口 | `extensions/goal.ts`（**vendored**：mitsuhiko/agent-stuff `extensions/goal.ts` @ `122e299`，Apache-2.0） |
| 命令 | `/goal`（查看 / 设定 / `pause` / `resume` / `edit` / `clear`） |
| 工具 | `create_goal`、`get_goal`、`update_goal` |
| 事件 | `session_start`、`session_tree`、`before_agent_start`、`agent_start`、`agent_end`、`context` |
| 状态显示 | 宿主状态行的 `goal` 槽位 |

## 行为

- **目标状态**：`active` / `paused` / `blocked` / `complete`，带 token 预算与累计用量、耗时。
- **系统提示注入**：`before_agent_start` 把"当前目标"追加进上下文。
- **续跑**：`agent_end` 结算用量并按需排入续跑消息，`context` 事件把它注入下一轮。
- **状态行**：`Pursuing goal (…s)`（accent）/ `Goal paused (/goal resume)`（warning）/ `Goal complete`（success）。
- **恢复**：`session_start` 与 `session_tree` 从**当前分支**重建状态——切换分支/恢复会话都正确，不依赖外部数据库。

## 与上游的唯一差异：逐秒刷新

上游只在目标生命周期事件（创建/暂停/恢复/编辑/清空、`session_start`、`session_tree`、`agent_end`）重算并推送状态行文本。而宿主的 `ctx.ui.setStatus` **只存静态字符串**，因此一个单次跑几十分钟的目标会从创建（`0s`）起一直不动，直到下一次状态变更。

本包在目标 active 期间挂 1 秒定时器重新推送同一份快照（`syncStatusTimer`）：

- 暂停 / 完成 / 清空即停；`unref()` 不阻塞进程退出。
- **计时口径未变**：定时器只**读**快照，时间仍只在 `agent_end` 记账（`test/goal.test.mts` 有对应用例）。

## 工具使用纪律（写进了工具描述）

| 工具 | 约束 |
| --- | --- |
| `create_goal` | 只在被**明确要求**时使用；只有明确要求预算时才设 `token_budget`；存在未完成目标时**失败**；上一个目标已完成则替换 |
| `update_goal` | `complete` 只在目标**确实达成且无剩余必需工作**时设置；`blocked` 只在同一阻塞条件连续三轮重复且已陷入僵局时设置；不得因为预算将尽而标记完成 |
| `get_goal` | 读取当前目标、状态、预算、token 与耗时用量、剩余预算 |

## 关掉它

不需要目标模式时，给本包加一条只含显示入口的过滤即可：

```jsonc
{ "source": "git:git@github.com:Rycen7822/metis-pi.git", "extensions": ["-goal.ts"] }
```

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| 状态与记账 | `extensions/goal.ts`（`STATE_TYPE` = `"goal"`、`version: 2`、`goalSummary`） |
| 会话记录条目类型 | 同文件（`UI_MESSAGE_TYPE` = `"goal-ui"`、`CONTINUATION_MESSAGE_TYPE` = `"goal-continuation"`） |
| 逐秒刷新（本包改动） | 同文件的 `syncStatusTimer`（文件头有改动说明） |
| 上游出处与许可 | 文件头 + 仓库根 `NOTICE`、`LICENSE-APACHE-2.0` |

## 不变量与已知限制

- 这是本包**唯一**注册命令与工具、监听 `context` 的非显示层入口（另两处是 todo 与内置 vendor 层）。`extensions/appearance.ts` 与 `src/**` 的"不注册工具、不改写结果与上下文"边界不受影响，`test/package.test.mjs` 把该范围写成了显式测试。
- 状态只进**会话记录**（CustomEntry）：换机器、换会话目录都跟着会话走。
- 上游风格：文件保持**制表符缩进**，便于与上游对照同步；`122e299` 之后上游若有改动，需要重新套用本包改动（见文件头说明）。
- 这是 vendored 文件：**改上游比改它更划算**——把 `syncStatusTimer` 提给上游后即可整体删除本包副本。

## 验证

`test/goal.test.mts`（含逐秒刷新用例）；`scripts/pty-verify.mjs` 覆盖目标状态行与计时。
