# OpenAI / Codex 远端压缩

Pi 决定何时压缩和保留哪些近期消息。Metis 为 `openai` 与 `openai-codex` 上支持的 Responses 路由处理 `/compact`、自动压缩和溢出恢复。其他路由使用 Pi 的普通文字压缩。自动触发线见[配置参考](../configuration.md#自动压缩上限)。

## 请求路径

| 当前路由 | 压缩请求 |
| --- | --- |
| `openai` + ChatGPT OAuth | Codex Remote V2。优先使用 Pi 的 `openai-codex` 登录，否则读取 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）。两端应登录同一账户和工作区。 |
| `openai-responses` + API key | [`POST /responses/compact`](https://developers.openai.com/api/docs/guides/compaction)。后续请求按原顺序回放返回的 `output`。 |
| `openai-codex-responses` | SSE `/responses` 的 `compaction_trigger`。保存后端返回的加密检查点，并保留约 64k token 预算内最近的真实用户消息。 |

OAuth 的登录、续期和存储由 Pi 管理。兼容路径的 ChatGPT 凭据只发给官方 Codex 后端。远端请求使用 Goal 与 Condense 的有效历史；Pi 选中的近期尾部原样保留。`compactionSummaryMaxTokens` 仅约束普通文字摘要；加密检查点由后端格式决定。

## 检查点、账户与数据

检查点和原始条目都从会话记录恢复。压缩卡片里的 `estimated context` 是本地估算；`Summary request input (provider-reported)` 来自提供商回执。卡片分别显示加密字节数与 token 估算，两者采用各自单位。

Metis 核对模型路由、凭据类型与可见的账户范围。账户不匹配或账户可见性发生变化时，拒绝回放。账户信息隐藏时，由原后端验证加密内容。OAuth 刷新保留账户绑定；重新登录、替换凭据或变更账户可能取消进行中的压缩或迁移。

**如需隔离不同账户的历史，请新建会话。** 用户消息、Responses 返回窗口及近期尾部可能包含明文；后端解密校验仅覆盖加密检查点。

## 跨模型或提供商迁移

跨路由迁移需要先把提供商私有的检查点转换为普通文字摘要。Metis 验证原路由和账户，用原路由的认证为前缀生成摘要，再把明文交给目标模型。此操作额外调用一次原路由，最多生成 8,192 token。有效的迁移摘要可复用；编辑来源会使它失效。

## 失败处理与恢复

1. 检查原模型、提供商地址和登录。如果已有有效的迁移摘要，可以复用。
2. 要从原文重建时，切回 **原模型和原请求路由**，运行 `/compact`。远端请求失败时保留历史；文字压缩需显式选择支持的提供商后执行。
3. 当前位置无法恢复时，用 `/tree` 回到更早的位置。原分支仍保留。

同一会话只启用一个接管压缩的扩展。停用 Metis 远端压缩前，先切到支持普通文字压缩的提供商，在扩展仍启用时执行 `/compact`，保存所需的迁移摘要。需要在原路由继续回放时，保持扩展启用。更换 SDK 后需[重启 Pi](../compatibility.md#安装与重启)。
