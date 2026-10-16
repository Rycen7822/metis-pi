# metis-pi 配置参数

## 唯一配置文件与初始化

所有 **metis-pi 自有偏好**集中在 `<agentDir>/metis-pi.toml`；通常是 `~/.pi/agent/metis-pi.toml`，跟随 Pi 的 `PI_CODING_AGENT_DIR`。不再读取项目 `.pi/metis-pi.json` / `.pi/metis-pi.toml`，也不再使用显示层单独的 `PI_AGENT_DIR` 覆盖。

包内同目录的 `metis-pi.toml` 是默认值来源；网页选项不预填，继续采用各功能的原有默认值，见下文 `[webAccess]`。不要直接用默认模板覆盖已有个性配置。尚无全局 TOML 时运行 **`/metis-config init`**：导入旧全局 `metis-pi.json`、Pi `settings.json.contextPrune`、`dynamic-agents.json`、`pi-codex-conversion.json` 的 tools/ui、`subagents.json` 的可映射项、`subagent-pi/config.toml`、`session-recall.json` 的查询模型及 `web-search.json` 的普通选项，写出完整 TOML，并把本说明放到同一目录。已有 TOML/说明文件不覆盖，外部旧文件不删除；同目录网页混合 JSON 拆分前备份，便于回退旧版代码。

已有 TOML 直接编辑需要修改的字段；未填写的选项沿用包内默认值。
`/metis-config` 显示配置和说明路径，`/metis-config init` 保留已有 TOML。

读取本身不写文件。提供兼容桥的模块在 TOML 不存在时兼容读取旧全局配置；LSP 与结构化提问除外，始终只读 TOML 与内置默认值。TOML 一旦存在，旧 JSON 的普通偏好不再叠加，未填字段只取默认值；网页凭据仍从同目录 JSON 或环境变量读取。新命令只写 TOML；首次保存也会导入其他旧全局 section。损坏或无权限的文件不会被保存覆盖。后端仅在全局 TOML 不存在时兼容旧 state-home `config.toml`；一旦存在即只取 `[subagents]` 与包内默认值，不再叠加旧文件。迁移桥仅用于旧配置升级，不支持新旧配置双向同步；确认新版工作正常后可手动移除旧的 metis 配置，**不要删除 Pi 的整个 settings.json**。

Pi 的模型、主题、compaction reserve、包/扩展加载、MCP 服务器定义与凭据仍由 Pi 管理，留在 `settings.json`、`mcp.json`、`mcp-auth.json` 等原位置。MCP 服务器的可信项目覆盖仍由 Pi 契约决定；这不是 metis 的项目配置覆盖。会话 goal、摘要、归档、缓存和策略 Markdown 属于状态/数据，不塞进配置文件。本包子代理后端的偏好也属于 Metis，统一在 `[subagents]`；`subagent-pi/` 只保存账本、日志和会话。内置 LSP 的偏好也属于 Metis，统一在 `[lsp]`；全局/项目 LSP JSON 不再读取，旧值须手动复制。另行安装的 Codex 插件及 `@ff-labs/pi-fff` 等其他插件配置不归本包所有，不迁移；`.codex/config.toml` 是可选的外部继承来源，不是 Metis 参数文件。

修改显示、快捷键、入口开关后重启 Pi；condense 可用 `/reload` 重读；执行配置在 run 边界刷新，MCP 用 `/mcp reload`，LSP 在每次工具或 `/lsp` 调用时重读，动态指令用 `/dynamic-agents reload` 在下一正式 run 更新。`/execution`、`/pruner settings`、`/websearch`、`/curator` 写全局 TOML；`/execution project` 不再支持。模板按功能分区，将枚举、单位、特殊值和可选示例放在对应选项旁。初始化和命令保存也会回填包内分区/参数注释，保留未知字段/其他 section；个人自定义注释不保留，可放在本说明或独立笔记。临时文件 + 原子 rename 避免半文件，同一进程写操作串行；多个 Pi 进程同时保存仍是最后写入者胜出。

TOML **没有 null**。`autoBudgetThreshold`、`budgetTurnDelta`、`frontierGapThresholdTokens` 用 `false` 关闭；`maxImagesPerRequest = false` 表示采用 API 默认。这是配置语法，不是字符串 `"false"`。其他字段用正确的 boolean/string/number/array/table；错误值按所属模块的校验回退或报错，不会修复你的文件。

## `[appearance]` 及其子表

| 字段（相对 appearance） | 默认值 | 含义 / 合法值 |
| --- | --- | --- |
| `enabled` | `true` | 仅控制显示层，不关闭执行、condense 等模块。 |
| `thinking.streaming` | `"peek"` | 流式思考：`peek` / `full` / `collapsed`。 |
| `thinking.completed` | `"collapsed"` | 结束思考：`collapsed` / `full`。 |
| `thinking.rail` | `true` | 思考内容左侧 rail。 |
| `thinking.peekLines` | `6` | peek 窗口行数，1–40；越界钳制。 |
| `writePreview.enabled` | `true` | 显示流式 write 参数预览。 |
| `writePreview.rows` | `8` | 屏幕行预算，0–64；0 只留标题/阶段，非法值回退。 |
| `composer.surface` / `promptPrefix` / `metadata` | 均 `true` | 输入面、首行 `>`、模型/推理/provider/上下文元信息。 |
| `working.elapsed` / `thought` / `tool` | 均 `true` | 时长、思考阶段、当前工具；各自独立。 |
| `working.tokens` | `false` | 运行中 token 段。 |
| `working.animation` | `true` | 真彩终端的工作动画。 |
| `working.animationIntervalMs` | `32` | 帧间隔毫秒，32–1000；越界钳制。 |
| `footer.enabled` / `details` | 均 `true` | Footer、累计 I/O/cache 明细。 |
| `footer.showCache` / `showChanges` / `showSpeed` | 均 `true` | 缓存命中率、Git 改动、已完成响应均速 `… tok/s`（含等待/TTFT 与推理；生成中保留上次完成样本）。 |
| `footer.locationExpanded` / `pruneExpanded` | 均 `false` | 目录/分支、prune 详情的默认展开状态；重载/重启后生效，界面点击不写回 TOML。 |
| `summary.enabled` / `persist` | 均 `true` | 结束摘要、会话持久化；关闭 persist 时仅临时显示。 |
| `selectionCopy.enabled` / `ctrlC` | 均 `true` | fullscreen 精确复制、Ctrl+C 复制选区；无选区保留原行为。 |
| `fullscreen.marginX` | `2` | 水平留白，0–8；0 关闭，非法值回退。 |
| `fullscreen.minWidth` | `72` | 40–400；窄于此值不留白。 |
| `glyphs.textPresentation` | `true` | 指定符号请求文字字形，不修改语义文本。 |
| `glyphs.include` | `[]` | 额外单个非 ASCII 字符；去重后最多 32 项。 |

## `[execution.tools]` / `[execution.ui]`

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `tools.autoReasoning` | `false` | 可选 run 内推理等级调整。 |
| `tools.customRustBinariesDir` | `""` | 自定义 PTY helper 目录；空字符串使用包内路径。 |
| `ui.toolRenaming` | `true` | 执行工具的自定义显示。 |
| `ui.backgroundShellWidget` | `true` | 后台 shell 面板。 |
| `ui.backgroundShellToggleShortcut` | `"alt+w"` | 展开面板。 |
| `ui.backgroundShellPrevShortcut` | `"alt+q"` | 上一项；与宿主冲突时可改 `"alt+u"`。 |
| `ui.backgroundShellNextShortcut` | `"alt+e"` | 下一项。 |
| `ui.backgroundShellCloseShortcut` | `"alt+r"` | 关闭面板。 |

## `[mcp]`

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 启用 Metis MCP 会话 owner；先禁用原生 mcp 扩展/其他 adapter，不能同时拥有连接。 |
| `idleTimeoutSeconds` | `600` | 正数秒；请求结束且 agent 空闲后回收连接，忙碌/等待操作不回收。 |
| `keepAliveServers` | `[]` | 需长期保留连接的服务器名数组，仍按需连接。 |

这三个字段仅从全局 TOML 读取。服务器定义、exposure、认证仍沿用 Pi 的 mcp.json；详见包内 `docs/configuration.md` 的 MCP 部分。

## `[askUserQuestion]`

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 有 UI 时提供 deferred 问卷工具；关闭或无 UI 时隐藏。 |
| `collapseKey` | `"ctrl+]"` | 折叠／展开问卷的 Pi 键位；`"off"` 禁用，非法键位回退默认值。 |
| `guidance.description` / `promptSnippet` / `promptGuidelines` | 内置说明 | 非空字段完整替换，guidelines 为非空字符串数组。 |

只读取全局 TOML，不读取项目或旧 rpiv JSON；已有快捷键/说明须手动复制。工具所有权与发现行为见 [结构化提问](https://github.com/Rycen7822/metis-pi/blob/main/docs/features/ask-user-question.md)。

## `[lsp]`

LSP 只读取全局 TOML，没有项目覆盖。没有 TOML 或没有 `[lsp]` 时取默认值；
损坏 TOML 或非法 LSP 参数明确报错，不回退 JSON，读取不修改配置。

| 字段（相对 lsp） | 默认值 | 含义 / 合法值 |
| --- | --- | --- |
| `timeout` | `20000` | 请求超时，毫秒；有限正数。 |
| `servers` | 不填写 | 省略时使用内置服务器 catalog；显式 map 完整替换 catalog，不合并。`servers = {}` 关闭全部路由。 |

每个 `[lsp.servers.<name>]` 支持以下字段：

| 服务器字段 | 默认值 | 含义 / 合法值 |
| --- | --- | --- |
| `command` | 必填 | 非空 argv 字符串数组，第一个为可执行命令，后续为参数；不解析 shell 命令字符串。 |
| `extensions` | 必填 | 文件扩展名字符串数组，如 `[".py", ".pyi"]`；省略前导点时自动补齐。 |
| `env` | 不填写 | 字符串值的环境变量表；子进程继承 Pi 环境后覆写，`env.PATH` 也用于解析启动命令。 |
| `initialization` | 不填写 | LSP 初始化选项和 workspace 配置表。 |
| `skipDirectories` | `[]` | 递归发现额外跳过的目录名，不含路径分隔符；与内置排除项叠加，显式请求仍可检查。 |
| `diagnosticsSettleMs` | `800` | 最新 push 诊断后等待无新发布的安静期，正数毫秒；内置 intelephense 为 `4000`，全局 timeout 仍为上界。 |
| `pushDiagnosticsGraceMs` | 不填写 | push-only 服务器首次发布的等待期，正数毫秒；未填时无发布则等待 timeout，部分内置服务器使用较短值。 |
| `pullDiagnosticsGraceMs` | 不填写 | 空 pull 结果后等待更新 push 发布的时间，正数毫秒；内置 rust-analyzer 为 `5000`。 |

例如仅启用 Ruff，并添加子进程环境与额外排除目录：

```toml
[lsp]
timeout = 20000

[lsp.servers.ruff]
command = ["ruff", "server"]
extensions = [".py", ".pyi"]
skipDirectories = ["generated"]

[lsp.servers.ruff.env]
LSP_LOG = "debug"
```

语言服务器由用户自行安装，Metis 不下载；使用内置 catalog 的诊断会报告并跳过缺失的
默认命令，显式选择或自定义配置的缺失命令会报错。`/lsp` 查看配置与命令可用状态。

旧全局和项目 `pi-lsp.json` / `lsp.json` 均被忽略，即使全局 TOML 不存在也不读取。
其他机器须把旧 wrapper 的 `timeout` / `servers` 手动写到 `[lsp]` 下；
裸服务器映射转为 `lsp.servers`，原 argv/env/初始化/排除/等待选项保持原值。
`/metis-config init` 不导入 LSP JSON；不要覆盖已有个性化 TOML，原 JSON 可保留作回退。
激活前停用独立 `npm:@narumitw/pi-lsp`，否则会重复 `/lsp` 命令并保留旧工具。

模型侧只有一个 direct `lsp`（`action: diagnostics/fix`），fix 默认不写入。
只按工具名的只读 allowlist 须排除它，或由权限策略检查 `action` / `write`；
配置命令仍使用 Pi 的进程权限，预览不是沙箱。完整用法与边界见包内 `docs/features/lsp.md`。

## `[dynamicAgents]` 与 `[[dynamicAgents.groups]]`

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `version` | `1` | 当前策略 schema 版本，必须为 1。 |
| `enabled` | `false` | 是否根据模型选择动态全局指令；迁移旧配置时保留其原有效开关。 |
| `notify` | `true` | 正式 run 提示选中策略；错误始终提示。 |
| `groups` | `[]` | 顺序匹配，首个 include 匹配且 exclude 不匹配的组生效。 |
| 组内 `id` / `file` / `include` / `exclude` | 用户填写 / 用户填写 / 非空数组 / `[]` | 唯一组名、相对配置目录的策略 Markdown 路径、模型 glob、排除 glob；`provider/model-id` 限定 provider，裸模式匹配模型名。 |

添加组时移除 `groups = []`，然后使用 TOML array-of-tables。例如：

```toml
[dynamicAgents]
version = 1
enabled = true
notify = true
[[dynamicAgents.groups]]
id = "codex"
file = "AGENTS-codex.md"
include = ["openai-codex/*"]
exclude = []
```

只替换已知全局指令来源，不修改项目指令、会话消息、认证或 provider 路由。

## `[contextPrune]`（condense / OCC）

| 字段 | 默认值 | 含义 / 单位 |
| --- | --- | --- |
| `enabled` | `false` | 自动工具结果精简总开关；历史回读仍可用。 |
| `opportunisticCompaction` | `false` | OCC 提前整段压缩；复用 Pi 模型/认证与容量恢复。 |
| `showPruneStatusLine` / `showOccStatusLine` | 均 `true` | 精简、OCC 状态栏和通知。 |
| `compactionSummaryMaxTokens` | `0` | 原生压缩额外输出硬上限，0 使用 Pi 默认；安全整数 ≥0，不更改 reserve/触发线。 |
| `summarizerModel` | `"default"` | 当前模型；或已注册的 `provider/model-id`。 |
| `summarizerFallbackModels` | `[]` | 有序故障备用模型，去重；当前会话模型总在最后。 |
| `summarizerThinking` | `"default"` | `default` / `off` / `minimal` / `low` / `medium` / `high` / `xhigh`。 |
| `pruneOn` | `"agent-message"` | 最终回复评估；`"on-demand"` 在工具轮次触发评估。 |
| `batchingMode` | `"turn"` | `turn` 分轮次；`agent-message` 同任务合并，均按输入预算拆分。 |
| `quietOversizedSkips` | `false` | 静默字符门槛/过大跳过通知，不改变处理与保护。 |
| `minBatchChars` | `5000` | 剩余语义候选字符保护；0 只关闭此保护，仍须压力与净收益准入。 |
| `recoveryGraceTurns` | `3` | 回读结果保留原文的用户任务组数；0 立即允许恢复成 stub。 |
| `summarizerIdleTimeoutMs` | `20000` | 事件间无进展超时，含首 token；0 关闭。 |
| `summarizerMaxTimeoutMs` | `180000` | 单次请求总时长上限；0 关闭。 |
| `protectedTools` | `[]` | 精确工具名；结果原样保留，拼错不会匹配。 |
| `protectedPaths` | `["**/skills/**/*.md", "**/gauntlet-overrides.md"]` | 对 args.path 的 glob；空数组关闭路径保护。 |
| `dedupByContentHash` | `true` | 精确正文哈希去重，每次执行仍保留独立参数/状态/恢复 ref；实际 stub 必须缩小。 |
| `autoBudgetThreshold` | `0.7` | (0,1] 窗口占比准入；`false` 禁用自动付费摘要，不禁用手动/机械/原生容量恢复。 |
| `spillThreshold` | `65536` | 单结果落 sidecar 的字符门槛，正数。 |
| `spillPreviewBytes` | `2048` | 落盘后头部预览字节数，≥0。 |
| `budgetTurnDelta` | `false` | 可选 (0,1] 轮次增长触发，仍受压力/收益约束；false 关闭。 |
| `frontierGapThresholdTokens` | `false` | 可选正数尾部 token-gap 触发，仍受压力/收益约束；false 关闭。 |
| `maxImagesPerRequest` | `false` | 保留最新 N 张，整数 ≥1；false 使用 API 默认（Anthropic 100，其他不额外限制）。精简关闭时仍生效。 |

### `[contextPrune.chainCompression]`

`enabled=true` 开启旧闭合任务链整理；`rollingWindow=3` 保留最近 3 条，0 不保留最近链；`stripFinalAssistantThinking=true` 去除保留最终回复的 thinking；`fuseRangeSummary=true` 允许 **手动 now / compact** 额外付费融合，自动维护不请求二次融合。融合失败/预算不足复用机械拼接，缺口不跨 frontier。

### `[contextPrune.purgeErrors]`

`enabled=true`；`cooldownTurns=2` 是失败后等待轮次数；`minArgChars=500` 是允许精简失败调用参数的字符门槛。数值 ≥0；正文与恢复证据另行保护。

### `[contextPrune.summaryBudget]`（高级校准参数）

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxBudgetWindowTokens` | `300000` | 压力绝对 ceiling，同时是 delta 窗口分母 ceiling；正安全整数。 |
| `minGainTokens` | `2048` | 单次付费替换最低本地 proxy 净收益；正安全整数。 |
| `minGainFraction` | `0.4` | 最低收益占被替换结果 B 的比例，[0,1]；与绝对门槛取较大值。 |
| `maxProxyTokens` | `6144` | **整个渲染摘要消息**的本地 proxy 上限，含引用/包装；正安全整数。 |
| `targetBaseTokens` | `512` | 软目标基数，安全整数 ≥0。 |
| `targetPerCallTokens` | `96` | 每个本批调用增加的目标量，安全整数 ≥0。 |
| `growthHeadroomTokens` | `16384` | 可解析原生容量线前的增长余量，≥0；0 不额外预留。 |
| `nativeTargetTokens` | `16384` | **仅 OCC** 的原生摘要输出文本软目标，≥0；0 不附加目标。不改变 Pi/provider 硬 cap，不自动注入普通原生路径。 |

`G=max(minGainTokens,ceil(minGainFraction×B))`，`R=min(maxProxyTokens,B-K-G)`，`Q=min(maxProxyTokens,targetBaseTokens+targetPerCallTokens×N)`。B 仅为实际被替换结果，K 为真实 stub/预览/路径；目标至少保留空包装加 256 tokens 的正文余地。不足时保留原文/pending，frontier 不跨缺口。手动请求只绕过压力，不绕过输出/收益预算。机械去重/packing 只需实测正收益。

这些是用户可调策略，不是所有算法内部常量的配置化。局部 o200k proxy 不等同 provider `maxTokens`、native 容量信用或账单，不能保证语义质量或经济回本；所有备用模型受同一最终消息校验，输出预算拒绝不继续换模型。完整行为与恢复边界见包内 `docs/features/condense.md`。

## `[subagents]`（native Pi / 本包 CLI 后端）

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 是否注册 native Pi 子代理入口；关闭不终止已运行任务，CLI 仍可管理状态。 |
| `maxResidentAgents` | `4` | 每个 daemon 同时驻留的 worker 上限，含前/后台任务。 |
| `maxAgentsPerScope` | `16` | 每个父会话 scope 的活跃/清理未验证 worker 上限；历史不占容量。 |
| `rpcTimeoutSeconds` | `20` | worker RPC 请求秒数。 |
| `startupTimeoutSeconds` | `30` | SDK 启动握手秒数。 |
| `defaultIdleTimeoutSeconds` | `1800` | 无进展超时，任务参数可覆写；不是任务总时长上限。 |
| `maxWaitSeconds` | `3600` | 后端 wait 轮询上限秒数；不扩大工具 schema 本身的上限。 |
| `residentIdleTimeoutSeconds` | `1800` | 已结束/空闲的驻留 worker 回收时间秒数。 |
| `eventMaxCountPerAgent` | `20000` | 单代理最多保留的事件数。 |
| `piCommand` | `["pi"]` | 本包 CLI 的启动 argv；native Pi 使用父进程 SDK/Node，此值不覆写父模型或 Pi 安装。 |

容量、超时和事件数均为整数 1–10000000，不接受 0/false/文本。后端在启动时载入配置；更改后先等待工作结束、关闭驻留 children，再用管理 CLI 正常停止 daemon，重新连接。`/reload` 不终止旧 daemon，也不会修改它已加载的参数。不要强停后台工作；源码指纹不一致会明确报 `version_mismatch`。`--home` / `PI_AGENTS_HOME` 选择状态目录，**不选择另一份偏好文件**；本包 CLI 仍使用 Pi 全局 agentDir 的 TOML。

### `[subagents.inheritance]`

`enabled=true`、`skills=true`、`mcp=true`、`codexHome=""`、`mcpProtocolMode="auto"` 是本包 Codex CLI/MCP 兼容入口的继承设置；`codexHome` 非空时须为存在目录，空字符串自动选择；协议模式为 `auto` / `legacy_2025_06_18` / `modern_2026_07_28`。**native Pi 不使用这些 Codex 开关**，ambient skills/扩展使用 profile/Pi 设置，MCP 及凭据仍由 Pi 管理。

`childEnv=[]` 是额外允许传给子代理的环境变量名（native Pi 也使用），凭据值来自父环境，不应直接写入 TOML。基本进程环境及 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 和对应小写名自动继承；代理值仅绑定在 scope 内存中，不落盘，daemon 重启后需父会话重新绑定。profile 的 `env` 可覆写代理变量。子代理 SDK 初始化代理感知的 HTTP/WebSocket，沿用 Pi 全局 `httpProxy` 和 HTTP 空闲超时；运行绑定、租约、bootstrap FD 等内部环境变量是协议状态，不是另一份用户配置。

### `[subagents.profiles.<name>]`

默认 `default`/`reader` 都使用 `extensions=[]`、`skills=[]`、`ambientExtensions=true`、`ambientSkills=true`。default 的 `tools=["read","bash","edit","write","grep","find","ls"]`；reader 为 `["read","grep","find","ls"]`。自定义 profile 继承 default，再覆写自己的字段；可添加 `model`、`provider`、`thinking`（不写表示继承现有模型/思考设置），或非秘密字符串 `env` 表。`tools` 只能填 Pi 内置名称，read access 仍额外禁止写入、shell 和递归子代理，不是操作系统沙箱。

### 旧插件字段不是当前 native 配置

`subagents.json.maxConcurrent` 迁为 `maxResidentAgents`；原生后端 `subagent-pi/config.toml` 的已有值更优先。其他旧字段明确提示、保留于备份，但不生成无效开关：

- `maxConcurrentForeground`：native 无前/后台容量分池，统一受驻留上限约束。
- `maxSubagentDepth`：managed child 固定禁止递归，不能通过配置放开。
- `workflowsEnabled`、`toolDescriptionMode`、`joinMode`、`outputTranscript`、`widgetMode`：旧独立 provider 的工作流/描述/汇总/输出/widget 选项不适用于 native 的工具、交付回执、历史读取和活跃树契约。

移入备份不等于删去功能数据：策略 Markdown、子代理 SQLite/WAL/SHM、日志、session、归档、MCP cache/auth 仍留原处。不要删除 `subagent-pi/` 或整个 Pi `settings.json`。

## `[sessionRecall]`

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `queryModel` | `"default"` | `session_query` 跟随当前会话；可指定已注册的 `provider/model-id`，例如 `openai/gpt-6.1-sol`。 |

每次查询重读，无需重启；值无效或模型不在 Pi 注册表中时回退当前会话。
`session_search` 不调用模型。模型定义与认证仍由 Pi 管理。
尚无 TOML 时，`/metis-config init` 将旧 `session-recall.json` 的
`queryModel.provider` / `id` 合并为这个字段，并保留原文件。
已有 TOML 直接编辑本字段；旧 JSON 不再叠加。损坏 TOML 会返回查询配置错误。

## `[webAccess]`

普通字段沿用 Web Access 的名字和校验规则，统一加上 `webAccess` 表前缀。
未填写时保持原默认行为，模板不强行指定 provider 或 searchRouting，避免
改变当前模型的搜索路由。下面各行的嵌套字段可写成 TOML 子表。

| 普通字段（相对 webAccess） | 用法 |
| --- | --- |
| `provider` / `searchProvider` | provider 名称、名称数组或 `"auto"`；`searchProvider` 优先。 |
| `searchModel` | Gemini 搜索模型 ID；其他 provider 使用各自的模型字段。 |
| `searchRouting.providers` / `useCurrentModel` / `fallbackOn` | 显式 provider 顺序；当前模型搜索开关；允许回退的错误分类。 |
| `webSearch.enabled` / `allowedProviders` | 搜索总开关、允许的 provider 名称列表。 |
| `workflow` | `"none"` / `"summary-review"` / `"auto-summary"`；默认 none。 |
| `summaryModel` / `summaryInstructions` | 摘要模型完整 `provider/model-id` 选择器与额外指令；未指定时使用首个可用的首选模型。若同一模型有多个可用路由则提示歧义并要求明确选择，不按注册顺序默选；例如 `summaryModel = "openrouter/anthropic/claude-haiku-4-5"`。支持 `:low` 等 thinking 后缀，仍受 Pi 的模型范围及认证约束。 |
| `summaryGenerationDeadlineMs` | 摘要期限，毫秒；默认 30000，最大 600000。 |
| `curatorTimeoutSeconds` / `autoOpenBrowser` / `curatorRemote` | 等待秒数、是否自动打开浏览器、远程绑定开关或 `{ host, bind }`。 |
| `toolActivation` | `"auto"` / `"dynamic"` / `"eager"`；默认 auto。 |
| `tools.<name>.enabled` / `toolNames.<name>` | name 为 webSearch、sourceCheck、fetchContent、getSearchContent；启用开关与工具名称。 |
| `commands.<name>.enabled` | name 为 websearch、curator、search、google-account。 |
| `shortcuts.curate` / `shortcuts.activity` | Pi 快捷键字符串；默认 ctrl+shift+s / ctrl+shift+w。 |
| `fetch.defaultMode` / `allowedModes` | readable、raw、answer；模式必须在允许列表中，默认 readable。 |
| `fetch.timeout` | 正数秒，默认 30。 |
| `fetch.answerProvider` / `answerModel` | 必须同时填写；answer 模式的模型选择。 |
| `fetchRouting.providers` / `allowRemoteHostedProviders` | 抓取器顺序与远程托管抓取开关。 |
| `maxInlineContentChars` | 内联内容字符上限；保留原模块的默认和边界规则。 |
| `proxy` | 不含用户名密码的 HTTP(S)/SOCKS 代理；含认证信息时放 JSON。 |
| `cacheRoot` | 缓存父目录，始终另建 web-search-cache 子目录；PI_WEB_ACCESS_CACHE_ROOT 可覆盖。 |
| `ssrf.allowRanges` / `trustEnvProxy` | CIDR 例外；默认固定校验后的 DNS 地址，非信任 HTTP 代理须支持 CONNECT。true 将环境/已配置代理的远端 DNS 安全交给代理。 |
| `fetchContent.domainPolicy.allow` / `deny` | 抓取域名允许和拒绝列表。 |
| `allowBrowserCookies` / `browserCookies.browser` / `profile` | Cookie 读取许可、浏览器 preset 和 profile 目录名；不是 Cookie 值。 |
| `authFetch.<profile>.hosts` / `chromeProfile` / `redirects` / `cache` | 认证抓取的域名范围、profile、same-origin 重定向和 session/off 缓存策略。 |
| `pdf.enabled` / `maxSizeMB` / `maxPages` / `provider` | PDF 开关、大小/页数限制和提取器。 |
| `pdf.datalabMode` / `datalabTimeoutMs` | fast/balanced/accurate 与 Datalab 超时毫秒。 |
| `datalabApiBase` / `datalabProcessingLocation` | API 地址、us/eu；对应 DATALAB_API_BASE / DATALAB_PROCESSING_LOCATION 优先。 |
| `youtube.enabled` / `preferredModel` | YouTube 开关和模型选择。 |
| `video.enabled` / `preferredModel` / `maxSizeMB` / `image.enabled` | 视频开关、模型、大小限制与图片开关。 |
| `githubClone.enabled` / `maxRepoSizeMB` / `cloneTimeoutSeconds` / `clonePath` | 仓库提取开关、大小、超时秒数和 clone 目录。 |
| `githubPrIssue.enabled` | GitHub issue/PR 提取开关。 |
| `openaiResponsesUrl` / `openaiUseProviderBaseUrl` / `openaiUseAlphaSearch` | OpenAI Responses 地址、Pi provider 地址和 Alpha Search 开关。 |
| `openaiSearchModel` / `openaiSearchProviders` | OpenAI 搜索模型和搜索后端列表。 |
| `braveBaseUrl` / `exaBaseUrl` / `tavilyBaseUrl` / `searxngBaseUrl` / `crawl4aiBaseUrl` | 对应服务的 API 地址；原环境变量覆盖继续有效。 |
| `firecrawlBaseUrl` / `firecrawlApiVersion` / `firecrawlFreshScrape` / `firecrawlPdfMaxPages` | Firecrawl 地址、API 版本、fresh 抓取和 PDF 页数。 |
| `degoogBaseUrl` / `degoogEngines` | Degoog 地址和引擎。 |
| `geminiAuth` / `geminiProject` / `geminiLocation` / `geminiBaseUrl` | Gemini 认证模式、项目、地区和 API 地址；实际密钥不写 TOML。 |
| `serpdiveModel` / `xaiSearchModel` / `xaiSearchTools` / `mistralSearchModel` / `mistralSearchTool` | 对应 provider 的模型/工具选择。 |
| `brightdataSerpZone` / `brightdataUnlockerZone` / `zaiEndpoint` | Bright Data zone；Z.ai 的 global/china 站点。 |

API key/token 字段、自定义 `searxngHeaders` / `degoogHeaders`（可能含认证信息）
及带认证的 proxy 保存在 **`<agentDir>/web-search.json`**，与现有 TOML 同目录。
密钥仍支持原字符串、`$ENV`、`!command` 及 provider 环境变量；Google ADC、
Pi 登录和浏览器 Cookie 值由原认证系统保存。TOML 中误写密钥字段会报错。
JSON 中的普通字段在 TOML 存在后失效；凭据 JSON 中的认证代理优先于 TOML proxy。

尚无 TOML 时用 `/metis-config init` 导入旧设置，已有 TOML 直接编辑。
初始化优先 agent 目录 JSON，然后是旧 XDG/pi 和 ~/.pi；显式指定 agent 目录
时不读取别处的 JSON。外部旧文件原样保留；同目录混合
JSON 在备份后拆为仅凭据的 JSON，新写入文件的权限为 0600。读取不写文件、不执行密钥命令。
`/websearch` 和 `/curator` 保存到现有 TOML。手动修改后的工具注册、快捷键、
provider 缓存用 `/reload` 刷新；独立 MCP 需重启。普通环境变量覆盖继续有效。

从旧 ~/.pi 或 XDG 目录迁移时，原缓存父目录写入 `webAccess.cacheRoot`，
旧会话的缓存引用继续有效；不会搬动或删除缓存数据。
