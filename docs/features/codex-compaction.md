# OpenAI / Codex 远端压缩

`extensions/codex-compaction.ts` 默认接管 **provider 为 `openai` 或 `openai-codex`，且 API 为 `openai-responses` 或 `openai-codex-responses`** 的 Pi `/compact`、自动阈值压缩及 context-overflow 恢复。其他 API/provider 没有远端 checkpoint 时继续使用原来的 Pi/Condense/OCC 路径。无需新增配置，不改变模型、thinking 或登录账号；原生 OAuth 刷新时会保存非秘密的检查点连续性字段。

## 协议与会话

压缩按登录方式选择协议，固定日常请求与压缩请求各自的凭据快照：

- `openai` 的 ChatGPT OAuth 登录：日常推理继续走公开 Responses API，压缩改走旧 Codex Remote V2，再把加密 checkpoint 接回原来的新路径。优先使用 Pi 中 `openai-codex` 的 OAuth；缺失时只读 `$CODEX_HOME/auth.json`，默认 `~/.codex/auth.json`，使用其中的 ChatGPT 登录。CLI 凭据只发往官方 Codex 后端，不使用其中的 API key，也不刷新或改写该文件。两套登录应使用同一账号和工作区；缺失旧登录时先运行 `codex login`。
- `openai-responses` 的 API key：继续使用官方 [`POST /responses/compact`](https://developers.openai.com/api/docs/guides/compaction) 接口，只发送 `model`、`input` 和可选 `instructions`。完整保存并按原顺序回放返回的 `output` 窗口，包括消息、工具条目及带非空 `encrypted_content` 的 compaction item；不裁剪返回内容，也不假定 compaction item 必须位于末尾。
- `openai-codex-responses`：参考 [Oh My Pi](https://github.com/can1357/oh-my-pi/blob/4b5e4fb7ea8ec2d37b8b6b138ea01125fe0a17dc/packages/agent/src/compaction/compaction-v2-streaming.ts) 的 Codex Remote V2，以 SSE 发送普通 `/responses` 请求，末尾追加 `compaction_trigger`，使用 `remote_compaction_v2` beta header。必须收到成功终止事件及恰好一个已完成的加密 compaction item；保留最新真实用户消息的约 64k token 预算，生成的 custom/summary 消息不会提升成用户原话。
- Pi 适配只压缩被丢弃的 canonical prefix，保留原 `firstKeptEntryId` 和近期尾部，避免压缩后重复回放尾部。
- checkpoint 保存在 `CompactionEntry.details.metisCodexRemoteCompaction`；普通 Responses 记录增加 `protocol: "responses"`，既有 Codex 记录继续兼容。界面显示简短标记，后续请求在 provider payload 阶段恢复原生结构。重载、分支和再次压缩都从会话记录恢复。
- 请求钩子只识别从真实、有效 checkpoint 准备的精确用户摘要载体。源码、工具输出、工具参数和普通用户文本中出现标记字符串，不会触发 checkpoint 替换或路由保护。
- system/tool 增量通过 Pi 的公开 transcript helper 编码；原生用量记入 compaction result。压缩后的本地 token 数仍是估计，后续普通响应以 provider 用量刷新。

新 OAuth 的双路径压缩保留原历史中 system/tool 增量的顺序，使用新 provider 编码的请求前缀、当前模型与 thinking 设置、同一 session cache key；旧 provider 负责传输、SSE 解析和重试。自定义压缩指令加在历史尾部，不重写前面的系统提示。这为缓存复用保留条件，不保证每次命中。checkpoint 绑定原来的日常路径，同时记录压缩路径身份；旧 Codex 账号改变后，再次压缩会恢复原始历史，避免把前一个账号的 checkpoint 发送给新账号。

原始 session 条目不删除。新检查点记录模型、API、请求地址和已知账号范围的摘要；确认这些范围改变、checkpoint 无效或覆盖的源内容被编辑时，恢复原始 canonical 历史（保留已有 plaintext compaction 与 context edits），不向不兼容账户发送密文，也不只发送占位摘要。请求地址末尾斜杠不改变新检查点的路由身份。换到其他 provider 后的下一次 `/compact` 可以生成其原生文本摘要。

认证暂时失败或无法证明旧检查点与当前 opaque OAuth grant 的连续性时，仅取消当前请求、保留检查点，并报告验证原因；不会自动展开所有原文。检查认证后可以重试；重新登录、未加载 Metis 的其他实例刷新共享凭据，或既有连续性字段已丢失时，可以手动 `/compact` 重新压缩原文。重建先经过现有 Condense 投影并补齐所需有效摘要，只向已认证的压缩路径发送容量范围内的输入，成功后才发布新检查点。超过输入窗口时仍取消并保留历史。

OAuth 追踪挂在 Pi 公开的注册配置或原生 provider 来源上，目录刷新重新组合包装对象时仍保持有效；保留已有模型、API、header 和登录提示行为。成功观察到原凭据刷新后，会保存稳定 grant 摘要及按模型、路由、已知账号限定的旧 binding 摘要，支持旧 token-bound 检查点迁移。不能验证的外部凭据替换不会被自动当作同一个 grant。

## 失败与边界

- 在请求与发布之间检查会话、分支、模型、两条路径的认证与 provider、system/tool 权限状态和取消信号；先等待 Condense maintenance，OCC 不会再花一次文本摘要请求覆盖远端结果。
- 历史在请求准备后发生变化时，取消过期请求；重试会重新验证检查点，不会因此强制恢复全部原文。仅目录重建 provider 包装对象不会使压缩结果失效，注册来源、认证路由或权限发生变化仍取消。
- 普通恢复请求在各 context 投影之后计算输入与输出预留；远端压缩检查其输入窗口，不沿用普通推理的最大输出预留。这些容量数字是本地估算，服务端拒绝仍按失败保留历史。
- 远端拒绝、断流、无效结果或过期源会明确取消本次压缩并保留历史，**不会降级为本地文本总结**。用户取消只取消压缩操作；安全拒绝不会伪装成用户取消而清除 Goal 的续跑债务。
- 后端必须支持所选 API 对应的 `/responses/compact` 或 Codex Remote V2。已有登录不保证账号/代理支持相应操作；失败通知会要求检查认证/权限或重试。压缩请求复用原生 provider 的 HTTP 重试，最多重试两次。
- 不替换第三方 compaction 插件；不要同时启用第二套接管 `/compact` 的扩展。未知组合不在支持保证内。
- checkpoint 是 provider 私有数据，并非通用 Markdown。不要在含 checkpoint 的会话中直接停用此扩展；先通过其他 provider 的 `/compact` 生成文本摘要，或继续保留回放扩展。

合约测试使用真实 Pi 1.2.0 AgentSession/SessionManager 与内置 OpenAI/Codex provider，并以本地 HTTP/SSE 替身验证协议，覆盖手动压缩、重载回放、再次压缩、自动压缩、溢出恢复、普通文本标记、HTTP 重试、取消、两套旧登录来源及状态变化保护。

2026-10-13 已用隔离的合成会话和当前账号实测 `gpt-6.1-sol` 的新路径开发、旧路径压缩、新路径继续、重载后回放：五次请求均返回 200，压缩请求命中 3,200 / 3,325 个输入 tokens 的缓存。此结果不保证其他账号、模型或任意长会话都可用。
