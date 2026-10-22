# OpenAI / Codex 远端压缩

`extensions/codex-compaction.ts` 默认接管 **provider 为 `openai` 或 `openai-codex`，且 API 为 `openai-responses` 或 `openai-codex-responses`** 的 Pi `/compact`、自动阈值压缩及 context-overflow 恢复。其他 API/provider 没有远端 checkpoint 时继续使用原来的 Pi/Condense/OCC 路径。无需新增配置，不改变模型、thinking 或登录账号。登录、退出、device ID、凭据刷新与存储完全由 Pi 管理；Metis 只消费 Pi 解析好的请求认证，不注册、替换或包装内置 OAuth，也不向凭据写入私有字段。

## 协议与会话

压缩按登录方式选择协议，固定日常请求与压缩请求各自的凭据快照：

- `openai` 的 ChatGPT OAuth 登录：日常推理继续走公开 Responses API，压缩改走旧 Codex Remote V2，再把加密 checkpoint 接回原来的新路径。优先使用 Pi 中 `openai-codex` 的 OAuth；缺失时只读 `$CODEX_HOME/auth.json`，默认 `~/.codex/auth.json`，使用其中的 ChatGPT 登录。CLI 凭据只发往官方 Codex 后端，不使用其中的 API key，也不刷新或改写该文件。两套登录应使用同一账号和工作区；缺失旧登录时先运行 `codex login`。
- `openai-responses` 的 API key：继续使用官方 [`POST /responses/compact`](https://developers.openai.com/api/docs/guides/compaction) 接口，只发送 `model`、`input` 和可选 `instructions`。完整保存并按原顺序回放返回的 `output` 窗口，包括消息、工具条目及带非空 `encrypted_content` 的 compaction item；不裁剪返回内容，也不假定 compaction item 必须位于末尾。
- `openai-codex-responses`：参考 [Oh My Pi](https://github.com/can1357/oh-my-pi/blob/4b5e4fb7ea8ec2d37b8b6b138ea01125fe0a17dc/packages/agent/src/compaction/compaction-v2-streaming.ts) 的 Codex Remote V2，以 SSE 发送普通 `/responses` 请求，末尾追加 `compaction_trigger`，使用 `remote_compaction_v2` beta header。必须收到成功终止事件及恰好一个已完成的加密 compaction item；保留最新真实用户消息的约 64k token 预算，生成的 custom/summary 消息不会提升成用户原话。
- Pi 适配只压缩被丢弃的 canonical prefix，保留原 `firstKeptEntryId` 和近期尾部，避免压缩后重复回放尾部。首次压缩、复用 checkpoint、迁移和重建都先应用 Goal/Condense 的有效证据投影，不会在日常请求已使用摘要时重新把工具原文塞进远端压缩。
- checkpoint 保存在 `CompactionEntry.details.metisCodexRemoteCompaction`；普通 Responses 记录增加 `protocol: "responses"`，既有 Codex 记录继续兼容。界面显示简短标记，后续请求在 provider payload 阶段恢复原生结构。重载、分支和再次压缩都从会话记录恢复。
- 请求钩子只识别从真实、有效 checkpoint 准备的精确用户摘要载体。源码、工具输出、工具参数和普通用户文本中出现标记字符串，不会触发 checkpoint 替换或路由保护。
- system/tool 增量通过 Pi 的公开 transcript helper 编码；原生用量记入 compaction result。压缩后的本地 token 数仍是估计，后续普通响应以 provider 用量刷新。

启用 appearance 时，压缩卡片将 `tokensBefore` 明确显示为 `estimated context`，不把它当作压缩请求的实测输入。匹配的压缩条目包含有效用量时，另显示 `Summary request input (provider-reported)`，按 `usage.input + cacheRead + cacheWrite` 计算，不混入输出 tokens。旧条目、缺失/全零用量或条目匹配不明确时省略实测行，不捏造数字；展示不会改写历史、摘要或模型输入。

新 OAuth 的双路径压缩保留原历史中 system/tool 增量的顺序，使用新 provider 编码的请求前缀、当前模型与 thinking 设置、同一 session cache key；旧 provider 负责传输、SSE 解析和重试。自定义压缩指令加在历史尾部，不重写前面的系统提示。这为缓存复用保留条件，不保证每次命中。checkpoint 记录原来的日常路径与压缩路径范围；已知旧 Codex 账号改变后，再次压缩会先使用文字摘要，避免把前一个账号的 checkpoint 发送给新账号。

原始 session 条目不删除。v2 检查点记录原模型、provider、API、请求地址、凭据类型及可见的已知账号，不保存 token/grant 绑定；普通请求不会因切换这些字段、损坏 metadata、覆盖源被编辑或认证失败而恢复整段原文。Pi 正常刷新或重新登录后，同一路由不会仅因 token 变化而被 Metis 拒绝；OAuth 账号信息不透明时，Metis 不猜测账户身份，由原后端使用 Pi 当前认证验证密文。已知账号不匹配或原有账号信息缺失时仍不回放；后端拒绝也不会自动展开原始历史。

首次跨模型或 provider 使用检查点时，会通过**原模型和已验证的原认证路径**，将加密 prefix 转成可跨模型使用的文字摘要；不会把密文发送给目标 provider。这会额外产生一次摘要请求，使用 low reasoning，最多输出 8,192 tokens。摘要以 `metisCodexPortableSummary` custom entry 持久化，绑定检查点 ID 和内容指纹，同时记录用量；后续切换和重启复用它，无需重复生成。近期尾部保留一次，切回原路由仍可继续回放原密文。新检查点额外保存原模型定位信息，旧记录使用原生 `model_change` 恢复来源。

没有可用文字摘要且无法验证原检查点、原模型不可用、摘要生成失败或源内容被编辑时，明确暂停请求并保留账本，不展开原文、不只发送占位符。已持久化的有效文字摘要不依赖原登录继续可用；目标模型本身仍需有效认证。源编辑会使对应摘要失效。生成、发布和请求发送前都会检查会话、分支、模型、认证和取消状态，过期结果不会发布。

手动与自动压缩优先沿用有效密文或文字摘要。只有用户在**原模型和原请求路由**显式执行 `/compact` 修复损坏检查点、源编辑或不再适用的账户/凭据范围时，才允许从 canonical 原文重建；经过 Goal 隐藏消息过滤、Condense 投影和容量检查，成功后发布新检查点。换模型后的 `/compact` 或摘要生成失败不会自动转成原文重建。认证暂时失败应先恢复登录；无法安全重建时可以通过 `/tree` 选择更早的恢复位置，原分支始终保留。

已有 v1 检查点保持只读兼容：带路由和凭据类型 scope 的记录沿用该范围，不再要求恢复旧 token/grant；没有完整 scope 的更早记录，仅在当前认证仍能匹配原绑定时复用，否则需在原模型/路由显式 `/compact` 重建，或使用已有 portable 摘要、`/tree` 恢复。Metis 不清理或迁移个人认证文件，也不再维护旧的 `metisCodexCheckpointIdentity` / `metisCodexCheckpointLegacyBindings` 字段。

## 失败与边界

- 在请求与发布之间检查会话、分支、模型、两条路径的认证与 provider、system/tool 权限状态和取消信号；先等待 Condense maintenance，OCC 不会再花一次文本摘要请求覆盖远端结果。
- 历史在请求准备后发生变化时，取消过期请求；重试会重新验证检查点，不会因此强制恢复全部原文。仅目录重建 provider 包装对象不会使压缩结果失效，注册来源、认证路由或权限发生变化仍取消。
- 本扩展接管的所有压缩路径都在 Goal/Condense 投影之后做本地容量检查，并计入自定义压缩指令。普通文字摘要请求还计算输出预留；远端压缩只检查当前模型配置的输入窗口，不沿用普通推理的最大输出预留，也不改写模型配置。估算针对可见投影，不能从加密 checkpoint 的字节数反推出其 token 数；本地通过不保证服务端接受，服务端拒绝仍按失败保留历史。失败记录包含 `projectedInputTokensEstimate`、`inputWindow`、`outputReserve` 和 `hasOpaqueCheckpoint`，这些字段不是服务端实测的拒绝输入大小或窗口上限。
- 远端拒绝、断流、无效结果或过期源会明确取消本次压缩并保留历史，**不会降级为本地文本总结**。用户取消只取消压缩操作；安全拒绝不会伪装成用户取消而清除 Goal 的续跑债务。
- 后端必须支持所选 API 对应的 `/responses/compact` 或 Codex Remote V2。已有登录不保证账号/代理支持相应操作；失败通知会要求检查认证/权限或重试。压缩请求复用原生 provider 的 HTTP 重试，最多重试两次。
- 不替换第三方 compaction 插件；不要同时启用第二套接管 `/compact` 的扩展。未知组合不在支持保证内。
- checkpoint 是 provider 私有数据，并非通用 Markdown。不要在含 checkpoint 的会话中直接停用此扩展；先通过其他 provider 的 `/compact` 将可迁移摘要写成原生文本压缩，或继续保留回放扩展。

合约测试使用真实 Pi 1.4.0 AgentSession/SessionManager 与内置 OpenAI/Codex provider，并以本地 HTTP/SSE 替身验证协议，覆盖手动压缩、重载回放、再次压缩、自动压缩、溢出恢复、普通文本标记、HTTP 重试、取消、两套旧登录来源及状态变化保护，以及模型迁移、文字摘要重载/分支复用、生成失败、取消和源编辑保护。

2026-10-13 已用隔离的合成会话和当前账号实测 `gpt-6.1-sol` 的新路径开发、旧路径压缩、新路径继续、重载后回放：五次请求均返回 200，压缩请求命中 3,200 / 3,325 个输入 tokens 的缓存。此结果不保证其他账号、模型或任意长会话都可用。
