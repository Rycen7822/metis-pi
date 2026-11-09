# OpenAI / Codex 远端压缩

`extensions/codex-compaction.ts` 处理 provider 为 `openai` / `openai-codex`、API 为 `openai-responses` / `openai-codex-responses` 的 `/compact`、阈值压缩和 context-overflow 恢复。其他 API 走 Pi/Condense/OCC；切带检查点的会话时按下文迁移。

登录、退出、device ID、刷新、凭据存储归 Pi。Metis 只消费解析好的认证；Codex CLI 兼容路径只读 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）的 ChatGPT 登录。OAuth 流程和个人认证文件保持 Pi 原生。

## 协议与会话

| 请求路径 | 压缩方式 |
| --- | --- |
| `openai` + ChatGPT OAuth | 日常推理走 Responses API，压缩走 Codex Remote V2，再把检查点接回推理路径。优先 Pi `openai-codex` OAuth，否则只读上表的 Codex CLI 登录；凭据只发官方 Codex 后端。两边登录须同一账户和工作区，缺失时运行 `codex login`。 |
| `openai-responses` + API key | 调 [`POST /responses/compact`](https://developers.openai.com/api/docs/guides/compaction)，按序保存并回放完整 `output` 窗口。 |
| `openai-codex-responses` | SSE `/responses` 请求带 `compaction_trigger` 和 `remote_compaction_v2` beta header；要求成功终止事件和恰好一个完整加密 item，保留约 64k token 预算的最新真实用户消息。 |

所有路径先用 Goal/Condense 的有效投影，只压缩 canonical prefix，保留 Pi 的 `firstKeptEntryId` 和近期尾部。system/tool 增量、模型、thinking、session cache key 用原生编码；自定义压缩指令附在历史尾。

检查点存 `CompactionEntry.details.metisCodexRemoteCompaction`。界面只打标记，请求准备好后在 provider payload 阶段恢复原生结构，普通正文中的相同字符串按原文处理。重载、分支、再压缩都从会话记录恢复，原始条目保留。

压缩卡片的 `estimated context` 是本地估计；有有效用量时另显示 `Summary request input (provider-reported)`，即 `input + cacheRead + cacheWrite`。后续普通响应继续更新 provider 用量；密文字节数与 token 数之间没有换算关系。

## 认证范围与跨模型使用

检查点记录模型、provider、地址、凭据类型、可见账户。API key 用单向摘要隔离不同 key，OAuth 与当前 token 解耦。已知账户不匹配或账户证据可见性变化时拒绝回放；信息始终不透明的，由原后端用 Pi 当前认证验密文。

**不透明账户在本地没有跨账户隔离。** 检查点带保留的明文用户消息，Responses 窗口也可能含明文，它们和会话尾部一起发给当前账户，后端验证只覆盖密文。换账户且需隔离历史时请使用新会话。

同一路由、账户范围未变的 OAuth 检查点，Pi 刷新或重登后继续使用。压缩或文字摘要执行中遇到刷新：同一已知账户、其他范围未变则发布；账户不透明且 token 变化时丢弃本次过期结果，用当前认证重试。API key 执行中变化同样取消。

首次跨模型/provider 使用时，经原模型和范围检查，用 Pi 当前认证把加密 prefix 压成文字摘要交给目标模型，目标 provider 只收到明文摘要。这一步额外产生一次 low-reasoning、最多 8,192 输出 token 的请求，结果存 `metisCodexPortableSummary`。有效摘要在重启、分支、丢失原登录后可复用；编辑覆盖源会使摘要失效，目标模型仍需有效认证。

## 失败与边界

- 模型不可用、范围验不过、摘要生成失败、源被编辑：暂停请求并保留账本，原文保留，密文标记单独保存。
- 生成、发布、发送前检查会话、分支、模型、认证、provider 和取消状态。目录包装对象重建属于正常恢复；压缩所有权由 Condense maintenance 协商。
- 本地容量只检查投影后的可见输入（含自定义指令）；模型最大输出上限由 Pi/provider 管。加密内容的实际 token 数未知，本地通过只是必要条件，后端仍可能拒绝。
- 远端拒绝、断流、无效结果、过期源：取消本次压缩并保留历史，摘要走显式的文字总结路径。压缩沿用原生 HTTP 重试，最多两次；后端必须支持对应协议。
- 压缩卡片和失败记录区分本地估计与 provider 用量；`projectedInputTokensEstimate`、`inputWindow`、`outputReserve`、`hasOpaqueCheckpoint` 是准备状态，后端拒绝原因以实际响应为准。

## 恢复与停用

先检查 Pi 当前认证、原模型和请求路由。有效文字摘要优先复用；只有**原模型、原请求路由**显式 `/compact` 时才从保存的 canonical 原文重建。重建同样经过 Goal/Condense 投影和容量检查；失败时用 `/tree` 回更早位置，原分支保留。

接管 `/compact` 的扩展同时只能启用一个。检查点是 provider 私有数据；停用此入口前，先在其他 provider 上 `/compact` 一次，把可迁移内容写成普通文字摘要，或保留回放入口。
