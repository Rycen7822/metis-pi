# OpenAI / Codex 远端压缩

`extensions/codex-compaction.ts` 为下列模型提供 `/compact`、阈值压缩与上下文溢出恢复：provider 为 `openai` 或 `openai-codex`，API 为 `openai-responses` 或 `openai-codex-responses`。其他 API 使用 Pi 的普通文字压缩。Condense 的工具历史整理可以与这些路径配合，但由独立的模块负责。

## 认证

登录、退出、device ID、OAuth 刷新与凭据存储由 Pi 负责。Metis 复用 Pi 已解析的认证。认证文件保持原有的格式与位置。

Codex CLI 兼容路径从 `$CODEX_HOME/auth.json` 读取 ChatGPT 登录信息。默认位置为 `~/.codex/auth.json`。

## 请求路径

| 路径 | 压缩协议 |
| --- | --- |
| `openai` + ChatGPT OAuth | 推理使用 Responses API，压缩使用 Codex Remote V2。优先采用 Pi 的 `openai-codex` OAuth，其次读取 Codex CLI 的登录信息。凭据只发送给官方 Codex 后端。两端须登录同一账户和工作区。缺少 CLI 登录时，执行 `codex login`。 |
| `openai-responses` + API key | 调用 [`POST /responses/compact`](https://developers.openai.com/api/docs/guides/compaction)。按原顺序保存并回放完整的 `output` 窗口。 |
| `openai-codex-responses` | 向 SSE 的 `/responses` 发送 `compaction_trigger`，并携带 `remote_compaction_v2` beta header。成功的结果包含终止事件和恰好一个完整的加密 item。同时保留约 64k token 预算内最新的真实用户消息。 |

请求先应用 Goal 与 Condense 的有效上下文，然后压缩 Pi 选定的历史前缀。`firstKeptEntryId` 之后的近期尾部保留。system 与 tool 的增量、thinking 和 session cache key 使用原生编码。自定义压缩指令附加在历史尾部。

本地容量预算涵盖可见输入与压缩指令。普通生成输出的 reserve 为 0。加密 token 数由 provider 计算。最终以后端接受的结果为准。Condense 的 `compactionSummaryMaxTokens` 只用于普通文字摘要。远端加密检查点遵循对应协议的输出约束。

## 检查点与用量

结果写入 `CompactionEntry.details.metisCodexRemoteCompaction`。界面显示该标记。发送请求时，恢复 provider 原生的结构。只有这个结构化字段会被解释为检查点。正文中出现相同的字符串，按普通文本处理。重载、切换分支和再次压缩，都从会话记录中恢复。原始条目保留。

压缩卡片区分两种用量：

- `estimated context`：本地的上下文估计。
- `Summary request input (provider-reported)`：有效回执中的 `input + cacheRead + cacheWrite`。

token 用量来自 provider 的回执。加密内容的长度只用于存储与传输。后续的普通响应会继续更新用量。准备记录中的 `projectedInputTokensEstimate`、`inputWindow`、`outputReserve`、`hasOpaqueCheckpoint` 描述的是本地状态。后端是否接受，以实际响应为准。

## OAuth 刷新与账户范围

检查点记录原模型、provider、地址、凭据类型，以及可见的账户。API key 经单向摘要区分。OAuth 使用登录范围，而不是轮换中的 access token。已知账户不匹配，或账户信息的可见性发生变化时，系统拒绝回放。账户信息对本地不可见时，原后端使用 Pi 当前的认证来验证加密内容。

**更换账户且历史需要隔离时，请新建会话。** 本地账户信息不可见时，跨账户隔离依赖服务端的验证。检查点保留的用户消息、Responses 窗口与会话尾部可能含有明文，并会发送给当前账户。服务端的解密检查只覆盖加密部分。

同一路由、账户范围未变的 OAuth 检查点，在刷新或重新登录之后仍可使用。正在执行的压缩与迁移摘要，还会核对当前登录：

- [Pi OAuth 连续性补丁](../../sdk-patches/pi-1.5.2/README.md)在正常刷新时保留登录标识。账户信息不可见时，也能确认是同一次登录。其他进程通过同一补丁刷新时，连续性依然保持。
- 重新登录、外部替换凭据、API key 或账户范围变化，都会取消正在执行的请求，并保留历史。
- 原版 Pi 1.5.2 依据可见的账户证据判断。证据不足时，取消并说明原因。

官方的 managed Pi 1.5.2 在正常安装或更新 Metis 时，会交付补丁版 SDK。磁盘安装完成后需要重启 Pi。`/reload` 只更新 Metis 扩展。当前进程已加载的 SDK，要在重启后才会更新。

## 跨模型或 provider 迁移

迁移先通过原模型与账户范围的检查，然后用 Pi 当前的认证，把加密前缀转换为普通文字摘要。目标 provider 接收这份明文摘要。

迁移会额外发起一次低推理强度的请求，输出最多 8,192 token。结果保存为 `metisCodexPortableSummary`。有效的摘要可在重启、切换分支或原登录失效后复用。来源编辑会使摘要失效。目标 provider 使用它自己的有效认证。

## 失败处理与恢复

生成、发布和发送前，都会检查会话、分支、来源、模型、认证、provider 与取消状态。目录包装对象的重建属于正常的恢复。Condense 的后台维护与远端路径，通过请求所有权协调。同一时刻只有一个压缩发布者。

模型不可用、认证范围不符、来源被编辑、流中断或结果不合格时，系统会暂停相应请求，或取消本次压缩，并保留历史与检查点。远端协议的错误按原样报告。普通文字摘要只用于显式的跨模型迁移。HTTP 沿用原生重试，最多重试 2 次。后端需要支持对应的协议。

恢复按以下顺序进行：

1. 检查 Pi 当前认证、原模型与请求路由。已有有效的迁移摘要时，优先复用。
2. 需要从原文重建时，回到**原模型、原请求路由**，显式执行 `/compact`。重建会再次应用 Goal 与 Condense 的投影和容量检查。
3. 当前位置恢复失败时，用 `/tree` 回到更早的位置。原分支保留。

同一时间，只能启用一个接管 `/compact` 的扩展。计划停用远端压缩入口时，先在其他 provider 上执行 `/compact`，把需要迁移的内容保存为普通文字摘要。也可以保留当前入口，用于回放 provider 私有的检查点。
