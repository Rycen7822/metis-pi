# OpenAI / Codex 远端压缩

`extensions/codex-compaction.ts` 默认接管 **provider 为 `openai` 或 `openai-codex`，且 API 为 `openai-responses` 或 `openai-codex-responses`** 的 Pi `/compact`、自动阈值压缩及 context-overflow 恢复。其他 API/provider 没有远端 checkpoint 时继续使用原来的 Pi/Condense/OCC 路径。无需新增配置，不修改模型、thinking 或凭据。

## 协议与会话

两种 API 使用各自的压缩协议，均复用 Pi 已解析的认证、路由和原生请求编码，并固定本次凭据快照：

- `openai-responses`：使用官方 [`POST /responses/compact`](https://developers.openai.com/api/docs/guides/compaction) 接口，只发送 `model`、`input` 和可选 `instructions`。完整保存并按原顺序回放返回的 `output` 窗口，包括消息、工具条目及带非空 `encrypted_content` 的 compaction item；不裁剪返回内容，也不假定 compaction item 必须位于末尾。
- `openai-codex-responses`：参考 [Oh My Pi](https://github.com/can1357/oh-my-pi/blob/4b5e4fb7ea8ec2d37b8b6b138ea01125fe0a17dc/packages/agent/src/compaction/compaction-v2-streaming.ts) 的 Codex Remote V2，以 SSE 发送普通 `/responses` 请求，末尾追加 `compaction_trigger`，使用 `remote_compaction_v2` beta header。必须收到成功终止事件及恰好一个已完成的加密 compaction item；保留最新真实用户消息的约 64k token 预算，生成的 custom/summary 消息不会提升成用户原话。
- Pi 适配只压缩被丢弃的 canonical prefix，保留原 `firstKeptEntryId` 和近期尾部，避免压缩后重复回放尾部。
- checkpoint 保存在 `CompactionEntry.details.metisCodexRemoteCompaction`；普通 Responses 记录增加 `protocol: "responses"`，既有 Codex 记录继续兼容。界面显示简短标记，后续请求在 provider payload 阶段恢复原生结构。重载、分支和再次压缩都从会话记录恢复。
- 请求钩子只识别从真实、有效 checkpoint 准备的精确用户摘要载体。源码、工具输出、工具参数和普通用户文本中出现标记字符串，不会触发 checkpoint 替换或路由保护。
- system/tool 增量按 Pi 的公开 transcript helper 合并；原生用量记入 compaction result。压缩后的本地 token 数仍是估计，后续普通响应以 provider 用量刷新。

原始 session 条目不删除。模型/API/路由/账户改变、checkpoint 无效或覆盖的源内容被编辑时，恢复原始 canonical 历史（保留已有 plaintext compaction 与 context edits），不向不兼容账户发送密文，也不只发送占位摘要。换到其他 provider 后的下一次 `/compact` 可以生成其原生文本摘要。

## 失败与边界

- 在请求与发布之间检查会话、分支、模型、认证、system/tool 权限状态和取消信号；先等待 Condense maintenance，OCC 不会再花一次文本摘要请求覆盖远端结果。
- 远端拒绝、断流、无效结果或过期源会明确取消本次压缩并保留历史，**不会降级为本地文本总结**。用户取消只取消压缩操作；安全拒绝不会伪装成用户取消而清除 Goal 的续跑债务。
- 后端必须支持所选 API 对应的 `/responses/compact` 或 Codex Remote V2。已有登录不保证账号/代理支持相应操作；失败通知会要求检查认证/权限或重试。压缩请求复用原生 provider 的 HTTP 重试，最多重试两次。
- 不替换第三方 compaction 插件；不要同时启用第二套接管 `/compact` 的扩展。未知组合不在支持保证内。
- checkpoint 是 provider 私有数据，并非通用 Markdown。不要在含 checkpoint 的会话中直接停用此扩展；先通过其他 provider 的 `/compact` 生成文本摘要，或继续保留回放扩展。

开发验收使用真实 Pi 1.1.0 AgentSession/SessionManager 与内置 OpenAI/Codex provider，并以本地 HTTP/SSE 替身验证协议，覆盖手动压缩、重载回放、再次压缩、自动压缩、溢出恢复、普通文本标记、HTTP 重试、取消及状态变化保护。没有访问个人凭据、请求付费 API、实测远端耗时或声明任意账号权限可用。
