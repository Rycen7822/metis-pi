# Condense：历史整理与原文恢复

Condense 用摘要、去重引用或预览替换后续模型请求中的旧工具结果。原始参数和结果仍可从会话归档读取。摘要会丢失细节；需要核实命令、结果或错误时，请读原文。

自动历史整理与空闲整段压缩（OCC）默认关闭。Pi 自身的自动压缩独立于这两个开关。

## 启用与配置

| 命令 | 用途 |
| --- | --- |
| `/pruner settings` | 设置摘要模型、触发方式与保护规则。 |
| `/pruner on`、`/pruner off` | 开关本地历史整理；关闭后仍可查询归档。 |
| `/pruner status`、`/pruner stats` | 查看队列、整理进度与摘要用量。 |
| `/pruner now` | 在 Condense 开启时处理待整理内容。 |
| `/pruner compact` | 整理具备有效摘要的闭合小 chain，不受 `rollingWindow` 限制。 |

命令保存到全局 TOML 的 `[contextPrune]`。手动编辑后运行 `/reload`。字段见[参数参考](../../metis-pi-config.md#contextprunecondense--occ)。

## 三层分组

| 单位 | 边界 |
| --- | --- |
| Batch | 一次模型请求产生的工具调用和结果。 |
| 小 chain | 一条完整、非空的 assistant 文本开始，到下一条文本、用户输入或 Goal 续跑之前。仅有工具的开头可单独成段。 |
| 大 chain | 从用户输入或 Goal 续跑开始，到下一次输入或续跑之前。 |

完整文本可与工具调用出现在同一条消息里。思考、流式片段和工具结果本身不分段。`batchingMode = "turn"` 各批次独立；`"agent-message"` 可合并同一小 chain 中的相邻批次。

## 何时整理

默认 `pruneOn = "agent-message"`，在完整可见的回复后评估。`"on-demand"` 也会按上下文压力、工作增长或积压评估。`pending` 表示模型视图仍在使用原文，可能在等待消费确认、近期保护解除、预算或费用条件。

交互终端中，自动付费批次摘要等当前运行结束、会话没有排队输入时再执行，不挡住工具后的下一次主请求。新输入会中止尚未完成的后台摘要，原文保持可见；已报告的用量仍计入，未收到回执的调用不按零成本处理。显式 `/pruner now` 和非交互模式仍等待摘要结果。

- 大结果可在捕获时落盘，留下预览与引用；`spillThreshold` 默认为 65,536 字符。归档完成不等于该结果已被模型消费。
- 精确去重保留每次调用的参数、结果引用和执行状态。可识别的成功构建或测试可用本地规则摘录。工具结果也可交给摘要模型。闭合的小 chain 可复用已有的摘要。
- 自动摘要和 chain 整理要求结果已被成功的主模型请求消费。保护范围包括开放的小 chain、最近 32,768 个估算 token、最近 4 轮有效工具工作、配置的工具和路径，以及回读宽限期。`rollingWindow` 默认参考最多 3 个近期闭合的小 chain，并与开放段共用近期 token 预算。手动整理仍须通过保护、归档完整性和实际收益检查。

### 付费摘要预算

付费压力线取三者中最小值：`autoBudgetThreshold × 模型窗口`、`summaryBudget.maxBudgetWindowTokens`、`max(0, Pi 自动压缩线 − growthHeadroomTokens)`。比例默认为 0.7，上限为 300,000 token，预留量为 16,384 token。Pi 阈值未知时跳过第三项。`autoBudgetThreshold = false` 关闭自动付费摘要，不关闭本地处理、手动整理或 Pi 压缩。

候选原文默认至少 5,000 字符。每次付费替换默认至少净省 2,048 token 且节省 40%，每个 batch 的完整摘要最多 6,144 token（含恢复引用和包装）。归档不全、摘要为空、截断或收益不足时保留原文。输入和输出预算见[参数参考](../../metis-pi-config.md#contextprunesummarybudget摘要预算)。

### 有界成组兜底

自动处理时，如果队列末尾三个独立批次仅因费用条件不通过且尚未安排模型请求，可再评估一次成组替换。各批次分别摘要、各自满足预算；最终组合视图须能摊回缓存改写和全部摘要费用。组未发布时保留原文，已经发生的摘要费用仍然计入。相同来源、模型、策略和报价下不会反复自动付费重试同一次尝试。

## 缓存与费用

改写输入前缀可能使下一次模型请求变冷。Condense 先估算冷请求和摘要费用，再与不改写的路径比较。已有改写的额外费用尚未摊回，或没有足够新工作时，会推迟下一次改写。缺少同一请求路径的有效缓存证据时，按冷重建做预算；首个正常请求的用量用于校正估算。主请求失败不算摘要成本，摘要请求失败仍可能计费。

普通批次按后续 3 次请求比较，自动大 chain 与共享规则整理按 24 次，有界独立候选最多 32 次。这些是**费用预测范围，不是等待轮数**。预测采用每次请求增加 2,000 token、目标缓存命中率 98% 的假设。短任务可能来不及摊回成本，账单以提供商为准。

报价依次采用 Pi 模型目录、[models.dev](https://models.dev/) 本地快照、缓存输入与普通输入 1:10 的相对估算。报价快照为 `<agentDir>/cache/metis-model-prices.json`。模型目录或安装版本变化时重新检查；刷新失败可使用已有报价。

### 与 Pi 自动压缩的关系

Pi 自动压缩开启且有效阈值为 `T` 时，上下文达到 `90% × T` 后，Condense 让出自动整理和 OCC，等待 Pi 压缩。`T` 包含 Metis 配置的[自动压缩上限](../configuration.md#自动压缩上限)。在途改写尚未发布时保留原文；`/pruner now` 和 `/pruner compact` 仍可用。

## 摘要模型与故障处理

`summarizerModel = "default"` 使用当前模型，也可填已注册的 `provider/model-id`。认证、可用性、超时或提供商故障时，依次尝试主摘要模型、`summarizerFallbackModels` 和当前模型，跳过重复项。无效摘要或预算拒绝则保留原文。

摘要模型与备用模型都会收到该批工具参数和结果。跨提供商配置前，请确认允许把这些资料发送给目标模型。

## 原文与分页恢复

通过 [`tool_search`](tool-discovery.md) 发现 `context_tree_query`。首次不传选择器可列出证据目录；之后按 ID 读取，例如：

```js
text(await tools.context_tree_query({ toolCallIds: ["t12"], maxBytes: 8192 }));
```

| 参数 | 用途 |
| --- | --- |
| `toolCallIds` | 原始工具 ID、目录短引用（`t12`）或 chain 引用（`b1`）。重复的原始 ID 可对应多条记录。 |
| `parentToolCallId` | 读取父调用下的嵌套结果，包括转录未显示的项。 |
| `sourceEntryIds` | 按当前分支的历史、压缩或摘要条目读取。只支持 `output`。 |
| `component` | 默认 `output`；`arguments` 用于读取工具原始参数。 |
| `maxBytes` | 完整 JSON 页的字节预算，含元数据与游标；2,048–32,768，默认 32,768。 |
| `cursor` | 上一页的 `nextCursor`。选择器和 `component` 必须保持一致；游标失效时重新从第一页读取。 |

三类选择器最多使用一种。`eof` 只表示分页结束；`archiveComplete` 表示捕获是否完整。查询读取的是执行时的证据，不代表当前文件或进程状态。回读会启动 `recoveryGraceTurns` 保护，默认持续 3 次用户输入或 Goal 续跑边界。

归档存放在会话旁的 `<sessionId>-blobs/`。移动、备份或清理会话时请同时处理；压缩不会删除归档。

## 空闲整段压缩（OCC）

同时开启 `contextPrune.enabled` 和 `opportunisticCompaction`，才会在回复已交付且工具空闲时尝试 OCC。每次用户任务或 Goal 续跑最多尝试一次。Pi 自动压缩开启时，OCC 在有效压缩阈值的 60% 开始等待，达到 72% 可就绪，低于 52% 退出等待，达到 90% 交给 Pi 自动压缩。实际执行还取决于工作增长、费用和可释放容量。

OCC 使用 Pi 的普通文字摘要，不替代[远端压缩](codex-compaction.md)。`compactionSummaryMaxTokens` 限制普通文字摘要，设为 0 使用 Pi 与模型的限制。`summaryBudget.nativeTargetTokens` 是 OCC 的软目标。压缩取消、失败或摘要无效时保留原历史。
