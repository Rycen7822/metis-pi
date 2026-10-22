# OpenAI / Codex 远端压缩

`extensions/codex-compaction.ts` 处理 provider 为 `openai` / `openai-codex`、API 为 `openai-responses` / `openai-codex-responses` 的 `/compact`、阈值压缩及 context-overflow 恢复。其他 API 使用 Pi/Condense/OCC；切换自带检查点的会话时按下文迁移。

Pi 管理登录、退出、device ID、刷新和凭据存储。Metis 消费已解析的认证；Codex CLI 兼容路径仅读取登录文件，所有路径均不替换 OAuth 或改写个人认证。

## 协议与会话

| 请求路径 | 压缩方式 |
| --- | --- |
| `openai` + ChatGPT OAuth | 日常推理走 Responses API，压缩走 Codex Remote V2，再把检查点接回推理路径。优先使用 Pi `openai-codex` OAuth，否则只读 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）的 ChatGPT 登录；凭据只发向官方 Codex 后端。两套登录应使用同一账户和工作区；缺失时运行 `codex login`。 |
| `openai-responses` + API key | 使用 [`POST /responses/compact`](https://developers.openai.com/api/docs/guides/compaction)，保存并按顺序回放完整 `output` 窗口。 |
| `openai-codex-responses` | SSE `/responses` 请求附加 `compaction_trigger` 与 `remote_compaction_v2` beta header；要求成功终止事件和恰好一个完整加密 item，保留约 64k token 预算的最新真实用户消息。 |

所有路径先使用 Goal/Condense 的有效投影，只压缩 canonical prefix，保留 Pi 的 `firstKeptEntryId` 和近期尾部。system/tool 增量、模型、thinking 与 session cache key 使用原生编码；自定义压缩指令附在历史尾部。

检查点保存在 `CompactionEntry.details.metisCodexRemoteCompaction`。界面只显示标记，请求准备后在 provider payload 阶段恢复原生结构；普通正文中的相同字符串不触发替换。重载、分支和再次压缩从会话记录恢复，原始条目保留。

压缩卡片的 `estimated context` 是本地估计；有有效用量时另显示 `Summary request input (provider-reported)`，即 `input + cacheRead + cacheWrite`。后续普通响应继续更新 provider 用量，密文字节数不能换算成 token 数。

## 认证范围与跨模型使用

检查点记录模型、provider、API、地址、凭据类型和可见账户。API key 使用单向摘要隔离不同 key；OAuth 不绑定可变 token。已知账户不匹配或账户证据可见性变化时拒绝回放；信息始终不透明时由原后端使用 Pi 当前认证验证密文。

**不透明账户不具备本地跨账户隔离。** 检查点含保留的明文用户消息，Responses 窗口也可能含明文；它们与会话尾部一起发送给当前账户，后端验证只保护密文。切换账户且不希望传递历史时，应使用新会话。

同一路由、账户范围未变的 OAuth 检查点可在 Pi 刷新或重新登录后继续使用。执行中的压缩或文字摘要若发生刷新，同一已知账户且其他范围未变时可发布；账户不透明且 token 已变化时取消本次过期结果，重试使用当前认证。API key 在执行期间变化也取消。

首次跨模型/provider 使用时，经原模型和范围检查通过的 Pi 当前认证将加密 prefix 生成文字摘要，再交给目标模型；目标 provider 不接收密文。该步骤额外产生一次 low-reasoning、最多 8,192 输出 tokens 的请求，结果以 `metisCodexPortableSummary` 持久保存。有效摘要可在重启、分支和失去原登录后复用；编辑覆盖源会使其失效，目标模型仍需有效认证。

## 失败与边界

- 模型不可用、范围无法验证、摘要生成失败或源被编辑时暂停请求并保留账本，既不展开原文，也不只发送标记。
- 生成、发布和发送前检查会话、分支、模型、认证、provider 与取消状态。仅目录重建包装对象不使结果失效；等待 Condense maintenance 后协商压缩所有权。
- 本地容量估计包含自定义指令。普通文字摘要预留输出空间，远端压缩按模型输入窗口检查；加密内容的实际 token 数未知，本地通过不保证后端接受。
- 远端拒绝、断流、无效结果或过期源取消本次压缩、保留历史，不自动改成文本总结。压缩沿用原生 HTTP 重试，最多两次；后端必须支持对应协议。
- 压缩卡片与失败记录区分本地估计和 provider 用量；`projectedInputTokensEstimate`、`inputWindow`、`outputReserve`、`hasOpaqueCheckpoint` 是准备状态，不是后端实测拒绝原因。

## 恢复与停用

先检查 Pi 当前认证、原模型和请求路由。有效文字摘要优先复用；只有在**原模型、原请求路由**显式 `/compact`，才可从保存的 canonical 原文重建。重建仍经过 Goal/Condense 投影及容量检查；失败可通过 `/tree` 选择更早位置，原分支保留。

不要同时启用另一套接管 `/compact` 的扩展。检查点是 provider 私有数据；停用此入口前，先在其他 provider 上执行 `/compact` 将可迁移内容写成普通文字摘要，或保留回放入口。
