# 原生 Pi 子代理

Metis 通过延迟加载的 `subagents_*` 工具提供持久化的 Pi 子代理。通过 codemode 或工具发现找到它们。每个父会话拥有一个 scope。子代理的会话、结果与投递收据，在前端重载和空闲关闭后仍然保留。

## 要求与配置

- 支持 Linux、WSL 或 Windows，需要 Python 3.11 及以上、Node.js 22.19 及以上，且只支持 Pi SDK 1.5.2。子代理使用父端的 SDK、Node 可执行文件和 agent 目录。Windows 通过 PATH 或 `py` 查找已安装的 Python。
- 全局的 `[subagents]` 控制注册、容量、超时、`childEnv` 和 profiles。后端策略在 daemon 启动时读取。
- profile 选择工具、扩展、skills，以及可选的模型与 thinking 覆盖。读取权限是一种工具策略，不是操作系统沙箱。
- 启用时，worker 会加载并激活 Pi 原生的 `codemode` 与 `tool_search`。脚本调用遵循相同的访问与禁止递归规则。显式排除的扩展或工具仍然无效。
- 启动前先解析已注册的模型 ID 和 thinking 能力，不要猜测。

参数说明见[参数指南](../../metis-pi-config.md)，生命周期见[生命周期](lifecycle.md)。

## 委派 skill

启用的父模块通过 Pi 的资源发现提供 [`subagent-delegation`](../../skills/subagent-delegation/SKILL.md)。它的唯一来源是 `skills/subagent-delegation/SKILL.md`。包清单将它排除在无条件的 skill 扫描之外。

分派任务前先阅读它。轻量模型通常需要明确的步骤顺序。能力较强的自主模型可以接受以结果为导向的任务。请根据任务和实际表现调整，不要通过改变权限或模型选择来补偿。

`enabled` 控制工具、模块指导和 skill 暴露，重载后生效。停用不会终止正在运行的工作，也不会删除对话中已有的指令。

## 工作流

| 工具 | 用途 |
| --- | --- |
| `subagents_spawn_agent` | 启动一个有界任务，明确归属与期望的证据。 |
| `subagents_wait_agent` | 等待完成或问题。 |
| `subagents_agent_result` | 读取并分页取回保留的结果。 |
| `subagents_list_agents`、`subagents_inspect_agent` | 查看状态、历史与收据。 |
| `subagents_answer_agent` | 回答已投递的问题。 |
| `subagents_followup_task` | 使用已保存的 worker 会话继续工作。 |
| `subagents_send_message` | 排队一条备注。不会唤醒空闲的 worker。 |
| `subagents_interrupt_agent` | 停止当前工作。保留历史，以及可能已产生的部分文件修改。 |

并发写入者应使用互不重叠的 cwd 子树，并明确文件边界。准入控制无法约束操作系统层面的实际写入。受管子代理不能重载、分叉、导航或替换自己的会话。

被接受的输入不一定已被消费。正常完成也不代表产物已被接受。检查结果时，若 `has_more=true`，需读取全部分页。只有在完全相同的请求结果不确定时，才能重试同一个操作 ID，不能借此让工作自动重放。

在全屏界面中点击活动的子代理，可以查看它实时的只读转录。`/subagents` 同时列出保留的子代理，以及 worker 与最近任务的状态。选择非活动的子代理，会打开已保存的转录，读取可用分页，并停止轮询。标签、滚动条、滚轮和导航键只影响查看，不影响结果确认。

查看器与 BTW 共用嵌入式 TUI、原生消息组件、视口组合和展示租约。工具绘制工厂与来源选择策略也与主界面共享。只读检查只适配注册信息。原生自动滚动条在交互时出现，且不占用正文列。每个代理保留独立的滚动、展开、思考与选区状态。切换标签会清除选区。最多缓存 8 个视图，每个视图限制为 256 条显示条目和 512 KiB。被淘汰的视图会释放分离的消息计划。查看历史不会创建 worker 会话或空编辑器。

重新打开绑定的父会话时，会恢复已保存的结果，但不会启动模型回合，也不会重放任务。未确认的投递会显示警告与状态指示。要把保留的结果投递给父会话，用 `subagents_wait_agent` 或 `subagents_agent_result` 并指定 run ID。父端收据确认投递成功。

## 状态与所有权

私有状态位于 **`<agentDir>/metis/subagent/`**：

| 路径 | 内容 |
| --- | --- |
| `registry.sqlite` 及其附属文件 | scope、agent、run、request 与收据。 |
| `agents/<agentId>/` | 会话、generation 所有权与诊断信息。 |
| `results/` | 不可变的分页结果。 |

账本要求 Metis 的 owner marker 和受支持的 schema。外部状态在写入前即被拒绝。源码职责见 [`src/subagents/README.md`](../../src/subagents/README.md)。

修改已安装的后端或其策略之前，先完成活动工作，并等待空闲关闭被验证。前端重载会重新连接 scope，但不能升级正在运行的 daemon。遇到所有权不明的情况，应检查，而不是直接清除或重放不确定的工作。
