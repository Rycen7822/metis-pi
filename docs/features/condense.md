# 历史精简、恢复与 OCC

`extensions/condense.ts` 归档工具原文、按有效证据生成精简投影，并提供 `context_tree_query` 回读。**自动精简和 OCC 默认关闭**；读取归档不会重放工具操作。

## 启用与配置

使用全局 TOML 的 `[contextPrune]`，命令保存到同一文件；手动编辑后 `/reload`。

```text
/pruner settings
/pruner on
/pruner status
```

| 设置 | 默认值 / 用途 |
| --- | --- |
| `enabled` / `opportunisticCompaction` | `false` / `false`；自动精简 / 空闲时的 Pi 原生摘要。 |
| `pruneOn` / `batchingMode` | `agent-message` / `turn`；最终回复评估 / 按助手轮次分批。 |
| `summarizerModel` | `default` 跟随会话；也可填已注册的 `provider/model-id`。 |
| `summarizerFallbackModels` | `[]`；有序备用模型，会话模型放在最后。 |
| `autoBudgetThreshold` | `0.7`；付费摘要压力比例，`false` 关闭自动付费摘要。 |
| `minBatchChars` | `5000`；剩余语义候选低于此值不请求模型。 |
| `compactionSummaryMaxTokens` | `0` 沿用 Pi；正数为原生压缩摘要额外输出上限。 |
| `showPruneStatusLine` / `showOccStatusLine` | `true`；精简比例、摘要用量与 OCC 状态。 |

全部字段与合法值见[参数说明](../../metis-pi-config.md)，不要用示例覆盖个人完整配置。

| 命令 | 操作 |
| --- | --- |
| `/pruner now` / `off` | 立即处理 pending / 停自动精简、保留回读。 |
| `/pruner model <id>[:thinking]` / `thinking` | 选择摘要模型与思考级别。 |
| `/pruner prune-on` / `batching` | 选择触发点与分批粒度。 |
| `/pruner protected-tools` / `protected-paths` | 设置工具名或路径 glob 保护。 |
| `/pruner compaction-summary-limit [n]` | 查看或设置原生摘要 cap，`0` 使用 Pi 默认。 |
| `/pruner recovery-grace [n]` / `dedup on\|off` | 恢复保护窗口 / 精确内容去重。 |
| `/pruner compact` / `stats` / `help` | 整理已关闭调用链 / 用量 / 完整命令帮助。 |

备用链在认证缺失、模型未注册、provider 错误或超时时继续；用户取消立即停止。空、截断或超预算摘要保留原文，不触发服务故障回退。成功备用模型暂时复用，每 10 分钟在后续请求中从主模型重试；更换链或会话模型会清除该状态。

## 候选与摘要预算

先处理精确去重和可确定的安全结果，再处理语义候选。每次调用保留独立参数、状态、时间戳和恢复引用；归档成功本身不授权隐藏。

- 明确成功的 build/test 日志可确定性精简，`exec_command` 必须确认退出码 0。运行中、失败、未知命令和受保护内容保留。
- 成功 edit/write 组的参数合计至少 5,000 字符、可恢复且净缩小时才精简；保留近期交互。Fusion 保留修改回执，仅整理安全命令日志。
- 有效 `context_edit` 先投影；编辑后的正文、非文本附件与未完成 nested 证据不交给该批次摘要替换。
- 子代理管理回执保留原文；正文结果和详细历史可归档、摘要。模型摘要有损，验收和代码判断需回读原文。

自动付费准入默认取三者最小值：`0.7 × 模型窗口`、`300000`、`Pi 原生容量线 − 16384`；第三项仅在 auto-compaction 开启且容量可解析时使用。`now` 绕过压力线，不绕过净收益和输出预算。

付费替换以去除内部元数据后的消息 JSON 测量本地 o200k proxy tokens：

```text
B = 被替换的原工具结果消息
K = 保留占位符、预览和恢复路径
G = max(2048, ceil(0.40 × B))
R = min(6144, floor(B − K − G))
目标 = min(6144, 512 + 96 × 工具调用数)
```

目标容纳必要包装和至少 256 tokens；超过 R 时不调用模型。R 检查整个新消息，包括正文、引用、尾注与包装。拒绝或测量失败保留原文和 pending，后续成功片段不越过未提交缺口。

proxy 不是 provider 计费或输出 token；provider cap 单独遵循模型与推理配置。缩短上下文可能使缓存前缀变冷，不保证账单收益。高级预算参数位于 `[contextPrune.summaryBudget]`。

单批最多 24 次调用、65,536 字符，并按整条模型链最小上下文预留提示与输出。超长轮次拆批，单个超长参数以明确标记的片段进入摘要。最多并发 3 片，按来源顺序归档发布；失败停止调度并取消后续请求，已开始请求仍可能产生费用。

调用链整理复用已有摘要或已归档确定性事实，保留每条用户消息、最终回复、受保护回执和恢复引用；Pi 估计与本地复核都必须缩小。自动整理不额外请求链融合；手动 `compact` 的付费融合也受完整消息净收益预算限制。

## 原文与分页恢复

归档位于会话旁 `<sessionId>-blobs/`，备份、复制与清理时和 session 一并考虑。进程输出在显示截断前捕获，Pi bash 的完整输出及时导入；上游已丢失的内容无法补回。nested 归档保留 prepared 参数、结束状态和不完整原因。

`context_tree_query` 为 deferred 工具，可经 Pi `tool_search` 激活或通过 codemode 调用。省略目标先列目录，再分页读取：

| 参数 / 字段 | 语义 |
| --- | --- |
| `toolCallIds` | 原 ID、短引用或链 block；重复调用分别返回。 |
| `parentToolCallId` | 父工具的子归档；与其他 ID 选择器互斥。 |
| `sourceEntryIds` | 历史来源条目，仅 output；与 toolCallIds 互斥。 |
| `component` | `output` / `arguments`；arguments 需要 toolCallIds。 |
| `maxBytes` | 2048–32768，默认 32768，限制整个 JSON。 |
| `cursor` | 绑定 session、内容版本和 component；目标在分支中消失则失效。 |
| `complete/eof` / `archiveComplete` | 分页进度 / 原始捕获完整性。 |

分页按 UTF-8 安全边界切分。恢复保护按用户消息组生效，不将整段历史塞回下一请求。

## OCC 调度与成本

OCC 仅在最终回复后的空闲边界使用 Pi 普通摘要，等待不算尝试。与本地精简共享保持期：发布、尝试或宿主压缩后，至少 4 次真实工具工作请求，历史增长达到 `max(5000 字符, 15%)`，才再次自动摘要。轮询、回读、预热、失败和近期重复不计工作。

开启 Pi auto-compaction 时，令容量线 `T = 窗口 − Pi 解析的 reserve`、缓冲 `B = max(1024, 5% × T)`：

- OCC 在 60%T 等待、72%T 就绪、低于 52%T 退出等待。三次工作后未就绪可释放本地摘要；达到条件可重新评估，每次外部请求最多一次实际尝试。
- 距 T 不足 B 时让本地摘要释放空间，实际用量超过 T 时由 Pi 容量压缩接管；候选前后均留 2B。
- 关闭 auto-compaction 时按模型窗口评估经济门槛；手动和必要容量恢复不受经济判断限制。

成本权重为普通输入∶输出∶缓存输入 **1∶5∶0.1**，考虑前缀变冷、输出上限与剩余窗口。取得 4 个不同成功工具轮次的增长观察后，估计可复用次数，超过回本所需次数才摘要；这是资源估算，不是美元价格。

`compactionSummaryMaxTokens` 在 Pi 与模型限制内生效，覆盖原生手动、阈值、溢出及 OCC 摘要；触及上限导致截断时保留原历史。OCC 使用同一 cap 做容量/成本预检，并通过 customInstructions 请求默认约 16,384 输出 tokens 的软目标；软目标不是硬 cap，也不自动加入普通原生压缩。没有有限模型输出上限或显式 cap 时，OCC 提示 `unknown-output-limit`。

## 保护与状态

用户要求、错误、显式保护、当前 goal 和恢复引用按来源保留。源编辑、保护过大、归档失败、后台进程运行或结果变大均可阻止发布，包含 Pi 普通压缩的保护检查。

维护完成只恢复仍欠下且有效的 goal 续跑；暂停、已接受输入和取消状态会重新核对。取消清理候选和续跑债务，安全拒绝不伪装成用户取消。

prune 用量统计当前加载以来已报告的额外摘要输入与输出，拒绝候选也记录；切分支重置，未知用量不猜金额。OCC 状态区分 compacting、compacted、cancelled 和 not compacted，隐藏状态不改变调度。

远端加密路径见[远端压缩](codex-compaction.md)。来源与许可见 [NOTICE](../../NOTICE)和 [LICENSE](../provenance/condense/LICENSE)。
