# OpenAI / Codex 远端压缩

`extensions/codex-compaction.ts` 接管以下模型的 `/compact`、阈值压缩和上下文溢出恢复：provider 为 `openai` / `openai-codex`，API 为 `openai-responses` / `openai-codex-responses`。其他 API 使用 Pi 的普通文字压缩；Condense 的工具历史整理是独立功能。

## 认证由谁负责

登录、退出、device ID、OAuth 刷新和凭据存储都由 Pi 管理。Metis 使用 Pi 解析好的认证，不另建登录流程，也不修改个人认证文件。

需要兼容 Codex CLI 登录时，只读 `$CODEX_HOME/auth.json`，默认 `~/.codex/auth.json`，且只使用其中的 ChatGPT 登录。

## 三种请求路径

| 路径 | 压缩协议 |
| --- | --- |
| `openai` + ChatGPT OAuth | 推理使用 Responses API，压缩使用 Codex Remote V2。优先取 Pi 的 `openai-codex` OAuth，否则读取 Codex CLI 登录；凭据只发官方 Codex 后端。两边必须登录同一账户、工作区，缺少 CLI 登录时执行 `codex login`。 |
| `openai-responses` + API key | 调用 [`POST /responses/compact`](https://developers.openai.com/api/docs/guides/compaction)，按原顺序保存、回放完整 `output` 窗口。 |
| `openai-codex-responses` | 向 SSE `/responses` 发送 `compaction_trigger`，带 `remote_compaction_v2` beta header。只接受成功终止且恰好包含一个完整加密 item 的结果，并保留约 64k token 预算的最新真实用户消息。 |

请求先应用 Goal、Condense 的有效上下文，再压缩 Pi 选定的历史前缀。`firstKeptEntryId` 之后的近期尾部保留；system/tool 增量、thinking 和 session cache key 使用原生编码，自定义压缩指令附在历史尾。

本地只检查可见输入及压缩指令是否放得下，不按普通生成请求预留模型最大输出。密文的实际 token 数未知，后端仍可能拒绝。Condense 的 `compactionSummaryMaxTokens` 不为远端加密检查点设置输出 token 上限。

## 检查点的保存与显示

结果写入 `CompactionEntry.details.metisCodexRemoteCompaction`。界面显示标记，真正发送请求时恢复 provider 原生结构；普通正文里恰好相同的标记字符串不会被当成检查点。重载、分支和再次压缩都从会话记录恢复，原始条目保留。

压缩卡片有两种数值，不能混用：

- `estimated context`：本地上下文估计。
- `Summary request input (provider-reported)`：有有效回执时，显示 `input + cacheRead + cacheWrite`。

密文字节数不能换算成 token 数。后续普通响应继续提供实际用量；本地准备记录中的 `projectedInputTokensEstimate`、`inputWindow`、`outputReserve`、`hasOpaqueCheckpoint` 也不代表后端已接受请求。

## OAuth 刷新与账户范围

检查点记录原模型、provider、地址、凭据类型和可见账户。API key 用单向摘要区分，OAuth 不绑定会轮换的 access token。已知账户不匹配、或账户信息的可见性发生变化时拒绝回放；账户始终不透明时，由原后端用 Pi 当前认证验证密文。

**账户不透明时，本地无法保证跨账户隔离。** 检查点保留的用户消息、Responses 窗口和会话尾部可能含明文，会发给当前账户；后端的解密检查只保护密文。换账户且需要隔离历史时，应另开会话。

同一路由、账户范围未变的 OAuth 检查点可以在刷新或重新登录后继续使用。但执行中的压缩和迁移摘要还要核对这一次登录：

- [Pi OAuth 连续性补丁](../../sdk-patches/pi-1.5.2/README.md)让正常刷新保留登录标识，账户信息不透明时也能确认同一次登录。其他进程经相同补丁刷新也可保持连续。
- 重新登录、外部替换凭据、API key 或账户范围变化，会取消正在执行的请求并保留历史。
- 未安装补丁的 Pi 1.5.2 只能使用可见账户证据；证据不足时取消并说明原因。

官方 managed Pi 1.5.2 的正常 Metis 安装、更新会交付补丁版 SDK。磁盘安装后需重启 Pi；扩展 `/reload` 只更新 Metis，不能替换当前进程已加载的 SDK。

## 跨模型或 provider 使用

加密检查点不能直接交给其他 provider。首次迁移时，经原模型及账户范围检查，用 Pi 当前认证生成一份普通文字摘要，目标 provider 只收到这份明文摘要。

迁移额外产生一次 low-reasoning 请求，输出最多 8,192 tokens，结果保存为 `metisCodexPortableSummary`。有效摘要可在重启、分支或丢失原登录后复用；编辑其来源会使它失效，目标 provider 仍需要自己的有效认证。

## 取消、失败与恢复

生成、发布和发送前都会检查会话、分支、来源、模型、认证、provider 与取消状态。目录包装对象重建不算来源变化；与 Condense 的后台维护通过同一请求的所有权协调。

模型不可用、认证范围不符、源被编辑、断流或结果不合格时，暂停相应请求或取消本次压缩，保留历史和检查点。不会悄悄把失败的远端结果换成另一份普通摘要。HTTP 沿用原生重试，最多重试 2 次；后端必须支持对应协议。

恢复顺序：

1. 检查 Pi 当前认证、原模型与请求路由，已有有效迁移摘要时优先复用。
2. 需要从原文重建时，回到**原模型、原请求路由**，显式执行 `/compact`。重建仍经过 Goal/Condense 投影和容量检查。
3. 仍无法恢复时，用 `/tree` 回到更早位置；原分支保留。

接管 `/compact` 的扩展同时只能启用一个。停用远端压缩入口前，应先在其他 provider 上执行 `/compact`，把可迁移内容保存为普通文字摘要；否则需保留能回放私有检查点的入口。
