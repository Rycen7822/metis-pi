# metis-pi 配置参数

## 唯一配置文件与初始化

Metis 偏好只存全局 `<agentDir>/metis-pi.toml`（默认 `~/.pi/agent`，跟随 `PI_CODING_AGENT_DIR`），项目级覆盖请改用全局文件。包内 `metis-pi.toml` 提供缺省值，Web 未填项沿用原默认；个人配置请直接编辑已有文件。

- `/metis-config` 查看路径；`init` 创建缺失的 TOML 和同目录本说明，已有文件与其他配置原样保留。读取只进内存，命令首次保存同样从默认值合并。
- 保存按模板重建注释，未知字段/section 原样保留，个人注释另存。跨进程锁串行读取、合并、临时文件原子 rename；重叠字段以最后一次写入为准，手工写入自担时序，损坏或无权限的文件保持原状。
- Pi 的模型/主题/reserve/packages/trust/MCP 定义及认证留在 settings.json/mcp.json/mcp-auth.json；goal/摘要/blobs/缓存/策略 Markdown 属于状态数据，与偏好文件分开。settings.json 请按字段修改。
- 旧 LSP JSON、pi-fff.json、项目 Metis 偏好已退出读取范围，所需值手工迁入。子代理偏好归 `[subagents]`，账本/会话仍在 `<agentDir>/metis/subagent/`。
- 显示/快捷键/入口变更重载或重启；执行在 run 边界、LSP 每次调用、MCP `/mcp reload`、动态指令下一正式 run 生效，后端设置须安全重启 daemon。`/execution`、`/pruner settings`、`/websearch`、`/curator` 保存同一个全局文件。
- TOML 没有 null；autoBudgetThreshold/budgetTurnDelta/frontierGapThresholdTokens 用布尔 false 表示关闭，maxImagesPerRequest=false 表示采用 API 默认。其他类型错误由各模块回退或报错，配置文件保持原样。

## `[appearance]` 及其子表

| 字段（相对 appearance） | 默认值 | 含义 / 合法值 |
| --- | --- | --- |
| `enabled` | `true` | 只作用于显示层；执行、condense 等模块独立开关。 |
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
| `footer.showCache` / `showChanges` / `showSpeed` | 均 `true` | cache、Git、生成速率（tok/s）：流式 `gen≈(live)` 按字符÷4估算，每批（含工具调用）结束用可靠非推理用量校准 last/avg；明细缺失时沿用 est，思考/工具执行时间单独排除。详见 [统计口径](https://github.com/Rycen7822/metis-pi/blob/main/docs/features/interface.md#统计口径)。 |
| `footer.locationExpanded` / `pruneExpanded` | 均 `false` | 目录/分支、prune 详情的默认展开状态；重载/重启后生效，TOML 只由用户和保存命令改写。 |
| `summary.enabled` / `persist` | 均 `true` | 结束摘要、会话持久化；关闭 persist 时仅临时显示。 |
| `selectionCopy.enabled` / `ctrlC` | 均 `true` | fullscreen 精确复制、Ctrl+C 复制选区；无选区保留原行为。 |
| `fullscreen.marginX` | `2` | 水平留白，0–8；0 关闭，非法值回退。 |
| `fullscreen.minWidth` | `72` | 40–400；窄于此值保持满宽。 |
| `glyphs.textPresentation` | `true` | 为指定符号请求文字字形，语义文本保持原样。 |
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
| `enabled` | `false` | 启用 Metis MCP 会话 owner；先禁用原生 mcp 扩展/其他 adapter，连接只有一个 owner。 |
| `idleTimeoutSeconds` | `600` | 正数秒；请求结束且 agent 空闲后回收连接，忙碌和等待中的操作豁免。 |
| `keepAliveServers` | `[]` | 需长期保留连接的服务器名数组，仍按需连接。 |

这三个字段仅从全局 TOML 读取。服务器定义、exposure、认证仍沿用 Pi 的 mcp.json；详见包内 `docs/configuration.md` 的 MCP 部分。

## `[askUserQuestion]`

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 有 UI 时提供 deferred 问卷工具；关闭或无 UI 时隐藏。 |
| `collapseKey` | `"ctrl+]"` | 折叠／展开问卷的 Pi 键位；`"off"` 禁用，非法键位回退默认值。 |
| `guidance.description` / `promptSnippet` / `promptGuidelines` | 内置说明 | 非空字段完整替换，guidelines 为非空字符串数组。 |

只读全局 TOML；项目和旧 rpiv JSON 已退出范围，已有快捷键/说明须手动复制。工具所有权与发现行为见 [结构化提问](https://github.com/Rycen7822/metis-pi/blob/main/docs/features/ask-user-question.md)。

## `[neuralSearch]`

语义模式的完整索引缓存使用同一 HOME 共享的磁盘峰值预算：

```toml
[neuralSearch.semantic]
cacheBudgetMiB = 512
idleTimeoutSeconds = 300
```

`idleTimeoutSeconds` 为 1–86400 的 TOML 整数秒；共享服务最多 3×4 计算线程，跨仓库复用同代模型，排队/工作结束后计空闲，status 保持独立计时。两项都在下一 semantic 请求读取。磁盘预算只接受整数 `256`、`512`、`1024`，省略时默认 `512MiB`；`512.0`、字符串及其它档位会显式报错。所有缓存根共用一档，临时文件、新旧代和活跃读者责任都计入。降档未释放足够空间时保持 pending，升档、截断、RAM/线程/cgroup 限制各有独立规则。

semantic 两项下一请求生效；其他启动偏好仍需重载。另需可信 CPU 包，缺失报错，构建与回退走正式流程；TOML 与安装/激活是两个状态，见[语义搜索](https://github.com/Rycen7822/metis-pi/blob/main/docs/features/neural-search.md#语义搜索)。

启用时提供 deferred `neural_search`，tool_search 发现后可直接调用；codemode 可选，内置 find/grep 保持原样。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 启用本组件及简短发现目录。 |
| `mentions` | `true` | 为交互编辑器提供 `@` 文件/目录补全；工具参数定义由 `enabled` 控制。 |
| `enableFsRootScanning` | `false` | 允许索引文件系统根目录；默认拒绝，避免意外扫描整盘。 |
| `enableHomeDirScanning` | `true` | 允许索引用户主目录；大型主目录可设 `false`。 |
| `warnOnHomeDirScan` | `true` | 扫描覆盖主目录时警告。 |
| `followSymlinks` | `true` | 索引目录符号链接指向的文件；按需可关闭以缩小扫描范围。 |
| `frecencyDbPath` / `historyDbPath` | 不填写 | 可选数据库目录。缺省为 `<agentDir>/metis/neural-search/{frecency,history}`。 |

旧 JSON、`FFF_*` / `PI_FFF_*` 环境变量、旧命令行开关均已退出读取范围，编辑器数据库同样不参与。旧配置/数据库原样保留；如需继续使用原有排序数据，请明确填入对应数据库目录，并自行管理其他使用者的并发访问。切换时从 Pi packages 移除独立 `@ff-labs/pi-fff`，避免两套工具和索引同时运行。详见 [Neural Search](https://github.com/Rycen7822/metis-pi/blob/main/docs/features/neural-search.md)。

## `[lsp]`

LSP 只读取全局 TOML，没有项目覆盖。没有 TOML 或没有 `[lsp]` 时取默认值；
损坏 TOML 或非法 LSP 参数明确报错，JSON 回退已移除，配置文件保持用户手写内容。

| 字段（相对 lsp） | 默认值 | 含义 / 合法值 |
| --- | --- | --- |
| `timeout` | `20000` | 请求超时，毫秒；有限正数。 |
| `servers` | 省略 | 省略时使用内置服务器 catalog；显式 map 完整替换 catalog，二者不叠加。`servers = {}` 关闭全部路由。 |

每个 `[lsp.servers.<name>]` 支持以下字段：

| 服务器字段 | 默认值 | 含义 / 合法值 |
| --- | --- | --- |
| `command` | 必填 | 非空 argv 字符串数组，第一个为可执行命令，后续为参数；shell 语法请拆成 argv。 |
| `extensions` | 必填 | 文件扩展名字符串数组，如 `[".py", ".pyi"]`；省略前导点时自动补齐。 |
| `env` | 不填写 | 字符串值的环境变量表；子进程继承 Pi 环境后覆写，`env.PATH` 也用于解析启动命令。 |
| `initialization` | 不填写 | LSP 初始化选项和 workspace 配置表。 |
| `skipDirectories` | `[]` | 递归发现额外跳过的目录名，只写名字段；与内置排除项叠加，显式请求仍可检查。 |
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

服务器自行安装；catalog 默认缺命令报告并跳过，显式/自定义缺命令报错，`/lsp` 查看状态。旧全局/项目 pi-lsp.json/lsp.json 已退出读取范围，请手工将 timeout/servers（含原 argv/env/初始化/排除/等待值）迁入，裸映射放 lsp.servers；原 JSON 可留作独立版回退，激活前停用 npm:@narumitw/pi-lsp。

只有 direct `lsp`，action=diagnostics/fix，write 默认 false。只读策略须检查 action/write 或排除该工具；配置进程沿用 Pi 权限，预览阶段权限与普通工具一致。完整接口见包内 docs/features/lsp.md。

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

只替换已知全局指令来源，项目指令、会话消息、认证、provider 路由保持原样。

## `[contextPrune]`（condense / OCC）

| 字段 | 默认值 | 含义 / 单位 |
| --- | --- | --- |
| `enabled` | `false` | 自动工具结果精简总开关；历史回读仍可用。 |
| `opportunisticCompaction` | `false` | OCC 提前整段压缩；复用 Pi 模型/认证与容量恢复。 |
| `showPruneStatusLine` / `showOccStatusLine` | 均 `true` | 精简、OCC 状态栏和通知。 |
| `compactionSummaryMaxTokens` | `0` | 原生压缩额外输出硬上限，0 使用 Pi 默认；安全整数 ≥0，reserve/触发线另由 Pi 管。 |
| `summarizerModel` | `"default"` | 当前模型；或已注册的 `provider/model-id`。 |
| `summarizerFallbackModels` | `[]` | 有序故障备用模型，去重；当前会话模型总在最后。 |
| `summarizerThinking` | `"default"` | `default` / `off` / `minimal` / `low` / `medium` / `high` / `xhigh`。 |
| `pruneOn` | `"agent-message"` | 最终回复评估；`"on-demand"` 在工具轮次触发评估。 |
| `batchingMode` | `"turn"` | `turn` 分轮次；`agent-message` 同任务合并，均按输入预算拆分。 |
| `quietOversizedSkips` | `false` | 静默字符门槛/过大跳过通知；处理与保护逻辑保持原样。 |
| `minBatchChars` | `5000` | 剩余语义候选字符保护；0 只关闭此保护，仍须压力与净收益准入。 |
| `recoveryGraceTurns` | `3` | 回读结果保留原文的用户任务组数；0 立即允许恢复成 stub。 |
| `summarizerIdleTimeoutMs` | `20000` | 事件间无进展超时，含首 token；0 关闭。 |
| `summarizerMaxTimeoutMs` | `180000` | 单次请求总时长上限；0 关闭。 |
| `protectedTools` | `[]` | 精确工具名；结果原样保留，拼写以工具名为准。 |
| `protectedPaths` | `["**/skills/**/*.md", "**/gauntlet-overrides.md"]` | 对 args.path 的 glob；空数组关闭路径保护。 |
| `dedupByContentHash` | `true` | 精确正文哈希去重，每次执行仍保留独立参数/状态/恢复 ref；实际 stub 必须缩小。 |
| `autoBudgetThreshold` | `0.7` | (0,1] 窗口占比准入；`false` 禁用自动付费摘要，不禁用手动/机械/原生容量恢复。 |
| `spillThreshold` | `65536` | 单结果落 sidecar 的字符门槛，正数。 |
| `spillPreviewBytes` | `2048` | 落盘后头部预览字节数，≥0。 |
| `budgetTurnDelta` | `false` | 可选 (0,1] 轮次增长触发，仍受压力/收益约束；false 关闭。 |
| `frontierGapThresholdTokens` | `false` | 可选正数尾部 token-gap 触发，仍受压力/收益约束；false 关闭。 |
| `maxImagesPerRequest` | `false` | 保留最新 N 张，整数 ≥1；false 使用 API 默认（Anthropic 100，其他不额外限制）。精简关闭时仍生效。 |

### `[contextPrune.chainCompression]`

`enabled=true` 开启旧闭合任务链整理；`rollingWindow=3` 保留最近 3 条，0 表示跳过最近链；`stripFinalAssistantThinking=true` 去除保留最终回复的 thinking；`fuseRangeSummary=true` 允许 **手动 now / compact** 额外付费融合，自动维护只用现成材料。融合失败/预算不足复用机械拼接，frontier 两侧各自独立。

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

这些是用户可调策略，覆盖范围限于这里列出的参数。局部 o200k proxy、provider `maxTokens`、native 容量信用和账单是相互独立的口径；语义质量与经济回本以实际输出为准。所有备用模型受同一最终消息校验，输出预算拒绝后改用机械整理。完整行为与恢复边界见包内 `docs/features/condense.md`。

## `[subagents]`（native Pi）

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 启用 native Pi 子代理工具、调用说明及专属 `subagent-delegation` skill；修改后 reload/restart，关闭不终止已运行任务。 |
| `maxResidentAgents` | `4` | 每个 daemon 同时驻留的 worker 上限，含前/后台任务。 |
| `maxAgentsPerScope` | `16` | 每个父会话 scope 的活跃/清理未验证 worker 上限；历史不占容量。 |
| `rpcTimeoutSeconds` | `20` | worker RPC 请求秒数。 |
| `startupTimeoutSeconds` | `30` | SDK 启动握手秒数。 |
| `defaultIdleTimeoutSeconds` | `1800` | 模型无进展超时，任务参数可覆写；不是任务总时长上限。原生压缩/摘要重试使用独立有界维护窗口，见[生命周期](https://github.com/Rycen7822/metis-pi/blob/main/docs/subagents/lifecycle.md)。 |
| `maxWaitSeconds` | `3600` | 后端 wait 轮询上限秒数；不扩大工具 schema 本身的上限。 |
| `residentIdleTimeoutSeconds` | `1800` | 已结束/空闲的驻留 worker 回收时间秒数。 |
| `eventMaxCountPerAgent` | `20000` | 单代理最多保留的事件数。 |
| `childEnv` | `[]` | 额外允许传给子代理的环境变量名；凭据值来自父环境，不写入 TOML。 |

容量、超时和事件数均为整数 1–10000000，0/false/文本都会被拒绝。后端在启动时载入配置；更改后先等待工作结束、关闭驻留 children，再安全停止 daemon，重新连接。`/reload` 的范围限于前端，旧 daemon 的参数以启动时为准。后台工作请让它自然收尾；源码指纹不一致会明确报 `version_mismatch`。状态目录为 `<agentDir>/metis/subagent/`；偏好仍在全局 `metis-pi.toml`。

`subagents.childEnv=[]` 是额外允许传给子代理的环境变量名，凭据值来自父环境，不应直接写入 TOML。基本进程环境及 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 和对应小写名自动继承；代理值仅绑定在 scope 内存中，不落盘，daemon 重启后需父会话重新绑定。profile 的 `env` 可覆写代理变量。子代理 SDK 初始化代理感知的 HTTP/WebSocket，沿用 Pi 全局 `httpProxy` 和 HTTP 空闲超时；运行绑定、租约、bootstrap FD 等内部环境变量是协议状态，不是另一份用户配置。

### `[subagents.profiles.<name>]`

默认 `default`/`reader` 都使用 `extensions=[]`、`skills=[]`、`ambientExtensions=true`、`ambientSkills=true`。default 的 `tools=["read","bash","edit","write","grep","find","ls"]`；reader 为 `["read","grep","find","ls"]`。自定义 profile 继承 default，再覆写自己的字段；可添加 `model`、`provider`、`thinking`（不写表示继承现有模型/思考设置），或非秘密字符串 `env` 表。`tools` 只能填 Pi 内置名称，read access 仍额外禁止写入、shell 和递归子代理，不是操作系统沙箱。

## `[sessionRecall]`

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `queryModel` | `"default"` | `session_query` 跟随当前会话；可指定已注册的 `provider/model-id`，例如 `openai/gpt-6.1-sol`。 |

每次 query 重读，缺省/无效/未注册模型跟随会话，损坏 TOML 报错；search 不调用模型，模型与认证归 Pi。

## `[webAccess]`

普通字段沿用 Web Access 的名字和校验规则，统一加上 `webAccess` 表前缀。
未填写时保持原默认行为，模板不强行指定 provider 或 searchRouting，避免
改变当前模型的搜索路由。下面各行的嵌套字段可写成 TOML 子表。

| 普通字段（相对 webAccess） | 用法 |
| --- | --- |
| `provider` / `searchProvider` | provider 名称、名称数组或 `"auto"`；`searchProvider` 优先。显式设置任一字段（包括 `"auto"`）会优先使用旧式 provider 选择，不启用 `searchRouting`。 |
| `searchModel` | Gemini 搜索模型 ID；其他 provider 使用各自的模型字段。 |
| `searchRouting.providers` / `useCurrentModel` / `fallbackOn` | 显式 provider 顺序；当前模型搜索开关；允许回退的错误分类。仅在未设置 `provider` / `searchProvider` 时启用。 |
| `webSearch.enabled` / `allowedProviders` | search/source-check 的兼容开关、允许的 provider 名称列表；不关闭 fetch/content。单工具 `tools.<name>.enabled` 优先于此兼容开关。 |
| `workflow` | `"none"` / `"summary-review"` / `"auto-summary"`；默认 none。 |
| `summaryModel` / `summaryInstructions` | 摘要模型完整 `provider/model-id` 选择器与额外指令；未指定时使用首个可用的首选模型。若同一模型有多个可用路由则提示歧义并要求明确选择，不按注册顺序默选；例如 `summaryModel = "openrouter/anthropic/claude-haiku-4-5"`。支持 `:low` 等 thinking 后缀，仍受 Pi 的模型范围及认证约束。 |
| `summaryGenerationDeadlineMs` | 摘要期限，毫秒；默认 30000，最大 600000。 |
| `curatorTimeoutSeconds` / `autoOpenBrowser` / `curatorRemote` | 等待秒数、是否自动打开浏览器、远程绑定开关或 `{ host, bind }`。 |
| `toolActivation` | 上游独立入口的 `"auto"` / `"dynamic"` / `"eager"`，默认 auto；Metis 入口固定注册 deferred 分组工具 `web_access`，不以此字段改变暴露方式。 |
| `tools.<name>.enabled` / `toolNames.<name>` | name 为 webSearch、sourceCheck、fetchContent、getSearchContent；单工具启用开关在 Metis 与独立入口都有效，名称覆写用于独立入口；Metis 分组名称固定为 `web_access`。 |
| `commands.<name>.enabled` | name 为 websearch、curator、search、google-account。 |
| `shortcuts.curate` / `shortcuts.activity` | Pi 快捷键字符串；默认 ctrl+shift+s / ctrl+shift+w。 |
| `fetch.defaultMode` / `allowedModes` | readable、raw、answer；模式必须在允许列表中，默认 readable。 |
| `fetch.timeout` | 正数秒，默认 30。 |
| `fetch.answerProvider` / `answerModel` | 必须同时填写；answer 模式的模型选择。 |
| `fetchRouting.providers` / `allowRemoteHostedProviders` | 抓取器顺序与远程托管抓取开关。 |
| `maxInlineContentChars` | 内联内容字符上限；保留原模块的默认和边界规则。 |
| `proxy` | 纯地址形式的 HTTP(S)/SOCKS 代理；认证信息放 JSON。 |
| `cacheRoot` | 缓存父目录，始终另建 web-search-cache 子目录；PI_WEB_ACCESS_CACHE_ROOT 可覆盖。 |
| `ssrf.allowRanges` / `trustEnvProxy` | CIDR 例外；默认固定校验后的 DNS 地址，非信任 HTTP 代理须支持 CONNECT。true 将环境/已配置代理的远端 DNS 安全交给代理。 |
| `fetchContent.domainPolicy.allow` / `deny` | 抓取域名允许和拒绝列表。 |
| `allowBrowserCookies` / `browserCookies.browser` / `profile` | Cookie 读取许可、浏览器 preset 和 profile 目录名；不是 Cookie 值。环境变量 `PI_ALLOW_BROWSER_COOKIES=1` 也可授权读取。 |
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
JSON 仅提供凭据，普通字段始终不参与偏好解析；凭据 JSON 中的认证代理优先于 TOML proxy。

尚无 TOML 时用 `/metis-config init` 创建默认设置，已有 TOML 直接编辑。
只读取 agentDir 内的 `web-search.json`；凭据文件由用户或原认证系统管理，初始化与偏好保存不会改写它。读取不写文件、不执行密钥命令。
`/websearch` 和 `/curator` 保存到现有 TOML。手动修改后的工具注册、快捷键、
provider 缓存用 `/reload` 刷新；独立 MCP 需重启。普通环境变量覆盖继续有效。

需要沿用已有缓存父目录时显式设置 `webAccess.cacheRoot`；不会搬动或删除缓存数据。
