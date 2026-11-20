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

## `[compactionPolicy]`（Pi 自动压缩）

| 字段 | 默认值 | 含义 / 单位 |
| --- | --- | --- |
| `contextWindowAbove` | `400000` | 模型上下文窗口严格大于此值时，应用压缩线的上限（token）。 |
| `autoCompactTokenLimit` | `400000` | 自动压缩触发线的上限（token）。 |

两个值均为正整数。对匹配的模型，触发线为 `min(autoCompactTokenLimit, contextWindow - reserveTokens)`。
保留 Pi 更早的阈值（包括模型单独设置的预留量）和自动压缩开关。触发线不是单次请求的硬上限；模型窗口、手动 `/compact` 和压缩协议不变。
修改全局 TOML 后执行 `/reload`。首次使用需重启到含此接口的 Metis 受管 SDK。

## `[contextPrune]`（Condense / OCC）

自动历史整理与空闲整段压缩的初始状态均为关闭。使用方式、分组和费用规则见 [Condense 指南](docs/features/condense.md)。

| 字段 | 默认值 | 含义 / 单位 |
| --- | --- | --- |
| `enabled` | `false` | 本地历史整理开关；归档查询独立可用。 |
| `opportunisticCompaction` | `false` | 空闲时使用 Pi 文字摘要提前整段压缩，与 `enabled=true` 共同生效。 |
| `showPruneStatusLine` / `showOccStatusLine` | 均 `true` | 整理、OCC 状态栏和通知的显示开关。 |
| `compactionSummaryMaxTokens` | `0` | 普通文字压缩的额外输出硬上限，单位为 provider tokens；0 沿用 Pi/模型限制。触发线由 Pi 管理，远端加密检查点由对应协议管理。 |
| `summarizerModel` | `"default"` | 跟随会话模型；也可填已注册的 `provider/model-id`。 |
| `summarizerFallbackModels` | `[]` | 备用模型按列表顺序尝试；候选链去重后，补充会话模型作为最后保障。 |
| `summarizerThinking` | `"default"` | `default` / `off` / `minimal` / `low` / `medium` / `high` / `xhigh`。 |
| `pruneOn` | `"agent-message"` | 在完整可见文本回复后评估；`"on-demand"` 在工具轮次按压力、增长或积压设置评估，同时支持手动执行。 |
| `batchingMode` | `"turn"` | 保持主请求独立；`"agent-message"` 合并同一文本小 chain 内的相邻请求。两种模式都按摘要输入预算拆分。 |
| `quietOversizedSkips` | `false` | 控制字符门槛和过大跳过通知的显示。 |
| `minBatchChars` | `5000` | 待付费摘要内容低于此字符数时保留原文；0 表示直接进入后续预算检查。 |
| `recoveryGraceTurns` | `3` | 原文回读后的保护期，按用户输入或 Goal 续推的大任务边界计数；0 关闭。 |
| `summarizerIdleTimeoutMs` | `20000` | 摘要请求事件间无进展超时，含首 token 等待，单位毫秒；0 关闭。 |
| `summarizerMaxTimeoutMs` | `180000` | 单次摘要请求总超时，单位毫秒；0 关闭。 |
| `protectedTools` | `[]` | 结果原样保留的精确工具名。 |
| `protectedPaths` | `["**/skills/**/*.md", "**/gauntlet-overrides.md"]` | 匹配工具参数 `path` 的 glob；空数组关闭。shell 命令文本不参与路径匹配。 |
| `dedupByContentHash` | `true` | 对工具名、结果正文完全相同的记录去重；每次执行保留独立参数、状态和恢复引用，替换结果必须更小。 |
| `autoBudgetThreshold` | `0.7` | 自动付费摘要的窗口比例，范围 (0,1]；`false` 关闭此入口。手动整理、本地规则和 Pi 原生压缩分别由各自设置控制。 |
| `spillThreshold` | `65536` | 单结果归档并留下预览的字符门槛，正整数。 |
| `spillPreviewBytes` | `2048` | 大结果落盘后保留的头部预览字节数，整数 ≥0。 |
| `budgetTurnDelta` | `false` | 可选的单轮增长触发，范围 (0,1]；`false` 关闭。触发后进入付费压力与收益检查。 |
| `frontierGapThresholdTokens` | `false` | 可选的尾部待整理内容触发量，正整数 tokens；`false` 关闭。触发后进入付费压力与收益检查。 |
| `maxImagesPerRequest` | `false` | 保留最新 N 张图片，整数 ≥1；`false` 使用 API 默认（Anthropic 100，其他 API 使用自身限制）。图片限制独立于历史整理开关。 |

### `[contextPrune.chainCompression]`

整理已经闭合的文本小 chain，包括进行中的大任务内的旧段。自动整理复用现成摘要。分组按消息边界定义，见[三层分组](docs/features/condense.md#三层分组)。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 自动 chain 整理开关，与总开关 `contextPrune.enabled=true` 共同生效。 |
| `rollingWindow` | `3` | 近期闭合小 chain 的参考数量，整数 ≥0；选择同时受 `minRecentTokens` 预算约束。 |
| `minWorkTurns` | `4` | 自动工具摘要和 chain 共同保留的最近有效工具工作轮数，整数 ≥0。有效轮次要求成功的主请求和有效工具结果；设为 0 关闭此项保护，否则不足时保留已有有效轮，尚无有效轮时保护整个窗口。 |
| `minRecentTokens` | `32768` | 保留的近期原文尾部，按 Pi 估算 tokens 计，与工作轮次保护取并集；整数 ≥0。 |
| `minGainTokens` | `8192` | 大候选/共享 chain 的最低净节省量，也是发布后所需的新工作增长下限；正安全整数。 |
| `minGainFraction` | `0.1` | 大候选/共享 chain 按总上下文检查的净节省比例，有界独立候选按自身大小检查；范围 [0,1]。工具摘要另受 `summaryBudget` 约束。 |
| `stripFinalAssistantThinking` | `true` | 去掉已整理边界的 thinking，保留可见文本；右边界文本属于下一组。 |
| `fuseRangeSummary` | `true` | 手动 `now` / `compact` 可额外付费融合已有摘要；失败或预算不足时使用拼接结果。 |

开放组与近期闭合组共用 `minRecentTokens` 作为引用预算，`rollingWindow` 控制参考组数。选择从近到远进行，以完整组为单位；下一组超出预算时结束。`rollingWindow=0` 关闭链数参考，其他保护继续生效。显式 `minRecentTokens=0` 同时取消原文最低量和引用组 token 限额。手动 `now` 使用配置的引用窗口，`compact` 覆盖全部安全闭合组。

2,048–65,536 个估算 tokens 的闭合独立候选使用局部费用评估，绝对收益底线为 `min(2048, minGainTokens)`，比例按候选自身计算，最多预测后续 32 次请求；自动大 chain/共享机械整理预测 24 次，普通 batch 聚合预测 3 次。总输入取本地投影与 Pi 用量估计的较大值。两侧每次新增 2,000 tokens、目标缓存命中 98%，分别选择对应报价阶梯；含远端检查点时，首轮缓存由同作用域的请求和真实回执估算，扣除整个受影响后缀；证据缺失时采用全冷预算。冷请求和摘要费计入后，压缩侧须严格更便宜。首个回执会校正冷请求债务，后续复用和工作增长要求见[缓存与费用](docs/features/condense.md#缓存与费用)。旧 `maxCostOverhead` 已由当前收益与费用策略取代。

上下文超过 256,000 个估算 tokens 后，有界独立候选的修改范围限定在最后 192,000 内的旧内容，近期保护规则保持一致。Pi 自动压缩容量可解析时，达到其有效容量的 90% 后，新增改写交由原生压缩接管；手动操作与已发布结果的重验继续可用。

### `[contextPrune.purgeErrors]`

清理失败工具调用的过长参数，失败结果正文与恢复证据继续保留。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 失败调用参数清理开关。 |
| `cooldownTurns` | `2` | 失败后等待的轮数，整数 ≥0。 |
| `minArgChars` | `500` | 参数达到此字符数才允许清理，整数 ≥0。 |

### `[contextPrune.summaryBudget]`（摘要预算）

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxBudgetWindowTokens` | `300000` | 付费摘要压力线的绝对上限，也是单轮增长比例的窗口上限；正安全整数。 |
| `minGainTokens` | `2048` | 单次付费替换最低本地净节省量，正安全整数。 |
| `minGainFraction` | `0.4` | 最低节省占被替换结果的比例，范围 [0,1]；与绝对门槛取较大值。 |
| `maxProxyTokens` | `6144` | 每个 batch 完整摘要的本地 token 上限，含恢复引用和包装；正安全整数。 |
| `targetBaseTokens` | `512` | 摘要软目标的基数，安全整数 ≥0。 |
| `targetPerCallTokens` | `96` | 每个调用增加的软目标量，安全整数 ≥0。 |
| `growthHeadroomTokens` | `16384` | 计算付费压力线时在 Pi 有效容量前预留的增长量，整数 ≥0；0 表示直接使用有效容量。 |
| `nativeTargetTokens` | `16384` | OCC 文字摘要的软目标，整数 ≥0；0 省略目标指令。Pi/provider 硬上限与普通原生压缩请求保持各自设置。 |

设模型窗口为 `W`，Pi 自动压缩有效容量为 `T`。付费压力线为 `min(autoBudgetThreshold × W, maxBudgetWindowTokens, max(0, T − growthHeadroomTokens))`；`T` 有解析结果时纳入计算。单轮增长触发使用 `budgetTurnDelta × min(W, maxBudgetWindowTokens)`，比较相邻两轮。

摘要预算按本地 o200k 计数：B 为实际被替换结果，K 为保留的引用、预览和路径，N 为本批工具调用数。

```text
最低净节省 G = max(minGainTokens, ceil(minGainFraction × B))
完整消息限额 R = min(maxProxyTokens, floor(B − K − G))
软目标基数 Q = min(R, targetBaseTokens + targetPerCallTokens × N)
```

软目标在 R 内收缩，并至少覆盖必要包装和 256 tokens 正文空间。R 无法容纳这一下限时保留原文，pending 留待后续处理；最终完整消息仍须满足 R。手动请求跳过自动时机和费用预测，继续执行摘要输入输出预算、指定保护和实际缩小检查。

provider 请求按 `max(1024, ceil(2 × R))` 预留文本输出空间；思考模型额外预留 minimal 1,024、low 2,048、medium/default 8,192、high/xhigh 16,384 token。预留只分配响应空间，不改变实际思考档位；`off` 或非思考模型不加这一项。总上限不超过模型能力及原有窗口四分之一的限制。该上限同时约束请求和费用预留，包含原生适配器追加的思考空间。两倍余量不是分词器换算，完整摘要仍按 o200k 检查，截断或超限时保留原文。

有界成组兜底仍按每个 batch 独立执行以上预算；一条组记录可容纳三份摘要成员，整体再按最终组合视图验收收益与费用。详见[有界成组兜底](docs/features/condense.md#有界成组兜底)。

本地计数用于比较替换前后的大小，provider `maxTokens` 限制输出，Pi 容量线决定原生压缩，实际费用以 provider 账单为准。

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
例如 `deepseekApiKey` / `DEEPSEEK_API_KEY` 用于显式 `deepseek` 搜索；不会自动加入默认 `auto` 或 `all`，
详见 [DeepSeek Search API](src/pi-web-access/README.md#deepseek-search-api)。
密钥仍支持原字符串、`$ENV`、`!command` 及 provider 环境变量；Google ADC、
Pi 登录和浏览器 Cookie 值由原认证系统保存。TOML 中误写密钥字段会报错。
JSON 仅提供凭据，普通字段始终不参与偏好解析；凭据 JSON 中的认证代理优先于 TOML proxy。

尚无 TOML 时用 `/metis-config init` 创建默认设置，已有 TOML 直接编辑。
只读取 agentDir 内的 `web-search.json`；凭据文件由用户或原认证系统管理，初始化与偏好保存不会改写它。读取不写文件、不执行密钥命令。
`/websearch` 和 `/curator` 保存到现有 TOML。手动修改后的工具注册、快捷键、
provider 缓存用 `/reload` 刷新；独立 MCP 需重启。普通环境变量覆盖继续有效。

需要沿用已有缓存父目录时显式设置 `webAccess.cacheRoot`；不会搬动或删除缓存数据。
