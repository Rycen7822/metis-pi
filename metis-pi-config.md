# metis-pi 配置参数

## 唯一配置文件与迁移

所有 **metis-pi 自有偏好**集中在 `<agentDir>/metis-pi.toml`；通常是 `~/.pi/agent/metis-pi.toml`，跟随 Pi 的 `PI_CODING_AGENT_DIR`。不再读取项目 `.pi/metis-pi.json` / `.pi/metis-pi.toml`，也不再使用显示层单独的 `PI_AGENT_DIR` 覆盖。

包内同目录的 `metis-pi.toml` 列出全部默认值，且是运行时默认值来源。不要直接用默认模板覆盖已有个性配置。首次安装新版后运行 **`/metis-config init`**：导入旧全局 `metis-pi.json`、Pi `settings.json.contextPrune`、`dynamic-agents.json`，写出完整 TOML，并把本说明放到同一目录。已有 TOML/说明文件不覆盖，旧 JSON 不删除，便于回退旧版代码。

读取本身不写文件。TOML 不存在时兼容读取旧全局配置；TOML 一旦存在，旧 JSON 不再叠加，未填字段只取包内默认值。新命令只写 TOML；首次保存也会导入其他旧全局 section。损坏或无权限的文件不会被保存覆盖。迁移桥仅用于旧配置升级，不支持新旧配置双向同步；确认新版工作正常后可手动移除旧的 metis 配置，**不要删除 Pi 的整个 settings.json**。

Pi 的模型、主题、compaction reserve、包/扩展加载、MCP 服务器定义与凭据仍由 Pi 管理，留在 `settings.json`、`mcp.json`、`mcp-auth.json` 等原位置。MCP 服务器的可信项目覆盖仍由 Pi 契约决定；这不是 metis 的项目配置覆盖。会话 goal、摘要、归档、缓存和策略 Markdown 属于状态/数据，不塞进配置文件。独立 subagent 服务的 `config.toml` 也不属于本包偏好。

修改显示、快捷键、入口开关后重启 Pi；condense 可用 `/reload` 重读；执行配置在 run 边界刷新，MCP 用 `/mcp reload`，动态指令用 `/dynamic-agents reload` 在下一正式 run 更新。`/execution`、`/pruner settings` 写全局 TOML；`/execution project` 不再支持。模板按功能分区，将枚举、单位、特殊值和可选示例放在对应选项旁。初始化和命令保存也会回填包内分区/参数注释，保留未知字段/其他 section；个人自定义注释不保留，可放在本说明或独立笔记。临时文件 + 原子 rename 避免半文件，同一进程写操作串行；多个 Pi 进程同时保存仍是最后写入者胜出。

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
| `footer.showCache` / `showChanges` / `showSpeed` | 均 `true` | 缓存命中率、Git 改动、tok/s。 |
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
| `tools.customRustBinariesDir` | `""` | 自定义原生 helper 目录；空字符串使用包内路径。 |
| `tools.viewImageFallback` | `false` | 文本模型借助已认证图片模型描述图片。 |
| `ui.toolRenaming` | `true` | 执行/图片工具的自定义显示。 |
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

`enabled=true` 开启旧闭合任务链整理；`rollingWindow=3` 保留最近 3 条，0 不保留最近链；`stripFinalAssistantThinking=true` 去除保留最终回复的 thinking；`fuseRangeSummary=true` 允许 **手动 compact** 额外付费融合，自动维护不请求二次融合。融合失败/预算不足复用机械拼接，缺口不跨 frontier。

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
