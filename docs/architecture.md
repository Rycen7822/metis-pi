# 架构与模块职责

## 入口与边界

`package.json` 的 `pi.extensions` 加载 `extensions/*.ts` 和 `vendor/pi-codex-conversion/dist/index.js`；主题为 `themes/metis-pi.json`。

| 入口 | 职责 |
| --- | --- |
| `extensions/appearance.ts` → `src/extension.ts` | 连接宿主与显示模块，安装工具行、chrome、复制和诊断。 |
| `extensions/skill-mux.ts` / `skill-entry.ts` | skill 输入展开/补全、标签和点击折叠。 |
| `extensions/todo.ts` → `src/todo/` | todo 工具、命令、持久化和面板。 |
| `extensions/goal.ts` → `src/goal-state.ts` | 入口拥有宿主 I/O、命令、提示与工具；状态核心拥有目标、时钟、分支恢复和回合用量。 |
| `extensions/dynamic-agents.ts` → `src/dynamic-agents.ts` | 入口拥有每次运行的全局策略快照、来源恢复和诊断；核心拥有匹配、只读配置和请求投影。conversion 通过会话事件总线复用准备/投影/预热门禁。 |
| `extensions/condense.ts` → `vendor/pi-condense/dist/index.js` | 单一加载入口、重复安装检测和摘要用量展示；vendor 拥有归档、最终回复精简/摘要决策与分页恢复。 |
| `extensions/action-fusion.ts` | 统一拥有所有 Action Fusion 入口的启用状态；包装 Pi 内建 edit/write，扩展 `then_run`，冻结 write 修改快照并管理关闭时的取消。 |
| vendor `src/extension/register.ts` | Codex 转换层组合根，通过构建后的 `dist/index.js` 加载。 |

显示适配保留 Pi 原生执行与结果；工具注册和模型上下文处理由独立 goal/todo/vendor 功能承担。`test/package.test.mjs` 检查自有源码的注册、持久化与上下文边界。chrome 仅依赖结构类型和注入的宿主能力。

## 自有源码

| 领域 | 模块与所有权 |
| --- | --- |
| 装配/宿主 | `extension.ts` 装配；`host-data.ts` 收敛公开数据；`adapter.ts` 守卫工具行 selector；`config.ts` 统一字段校验和默认值。 |
| 工具显示 | `tool-names.ts` 定义契约；`renderers.ts` 装配 call/result 两槽；`shell.ts` 按物理行预算；`diff.ts`/`diff-component.ts` 共享 diff；`apply-patch-view.ts` 只读取执行前快照；`explore.ts` 管探索显示。self-shell 不再安装无效的 stock 子树 spacer 补丁。 |
| 写入预览 | `native-tool-path.ts` 与 Action Fusion 共用 Pi 原生路径规则；`write-tracker.ts` 记录真实 pre/post image；`write-preview.ts` 展示状态；不能从新内容臆造删除行数。 |
| 转录/思考 | `transcript-state.ts` 拥有稳定消息身份、语义 run、计时和控制器；adapter 每次更新解析一次 `AssistantView`，供阶段策略和组件装饰共用。`thinking-view.ts` 拥有交互形态。 |
| 颜色/文字 | `palette.ts` 解析颜色能力；`sgr.ts` 只解析有序命令并跳过颜色参数，`output-style.ts` 与 `surface.ts` 各自决定 DIM/背景策略；`glyph-presentation.ts` 处理字形。 |
| chrome | `chrome/install.ts` 捕获宿主；editor、header、footer、working 和 transcript-components 拥有各自组件；`fullscreen-layout.ts` 唯一拦截布局根、协调留白与 history-window 的安装/释放，不相互叠加 prototype 包装。 |
| 度量 | `ui-metrics.ts` 管交互计时，`interaction-outcome.ts` 管终止证据，`usage-ledger.ts` 管用量去重，`output-speed.ts` 管采样；`git-changes.ts` 采样工作树 vs HEAD 的未提交改动。 |
| 摘要 | `turn-summary.ts` 是显示层唯一写会话条目的模块；仅依据终止证据生成结果，不把工具错误直接判为整个交互失败。 |
| 精确复制 | `selection-copy/` 直接生成携带文本的 span，无全文偏移往返；`adapter.ts` 补齐原生 self-shell 的外层组合关系。映射按已提交渲染数组身份绑定，不重新渲染；未验证区域原生回退。 |
| todo | model 验证领域规则，直接生成层级任务行，不构建第二棵派生状态树；store 拥有锁与磁盘，tools 拥有路径解析/通知，widget 拥有可见状态。参数类型由 TypeBox schema 推导。 |
| goal | `GoalState` 不做宿主 I/O；快照读取不累计时间，状态切换/回合结算才记账。回合用量只记到开始该回合的目标，持久化沿用 session custom entry v2。 |
| skill | tokens 解析、mux 展开、fold/label 装饰共用宿主补丁守卫；模型仍接收完整 skill 正文。 |

## vendor 的责任边界

| 领域 | 所有权 |
| --- | --- |
| activation/config | `runtime-plan` 决定模式；普通布尔字段从默认契约读取，字段依赖在规范化后计算一次。UI 的简单开关共用字段绑定，写入保留最新草稿与未知字段；信任范围、原子写入和自定义关联控件各自独立。 |
| providers | `prepareResponsesTranscript` 统一 Context、system 和工具放置；`provider-request.ts` 统一 live/prewarm 的公共准备，仅最终请求执行窗口注入和 prompt 捕获。最终调用/结果配对由 `normalizeResponsesToolHistory` 负责。 |
| compaction/replay | 全量头部与切片显式区分；切片沿用完整历史的工具决策；重建压缩 input 与顶层 tools 一起更新，canonical 请求保留基线。 |
| context-management | `tool-contract.ts` 统一 history/notes 操作字段、必填与加密规则，声明与执行各自消费；`adapter/history-insertion.ts` 只负责稳定插入重建消息，各调用方保留筛选策略。Local/Tree/Remote/Hybrid 的持久化、窗口和 wire schema 差异仍显式保留。 |
| Code Mode / Notebook | `code-mode/directory-lock.ts` 提供安装/持久化路径的跨进程 lease，`notebook-state-lock.ts` 提供 notebook 状态存储的同一策略。V8 host client 独占 framed connection、`session/open` 协议和 delegate 回应。Notebook 保持惰性加载：`session-runtime.ts` 拥有 kernel/startup/身份/checkpoint 并构造 execution runtime；生命周期、恢复和 profile 使用接收该 owner 的操作函数，避免独立 controller 与重复 host 接口；`candidate-transaction.ts` 共享候选捕获与原子发布，调用方保留 generation/merge、pin、profile 命名与 checkpoint 身份。`capture-bindings-source.ts` 共享内核捕获；project/profile 共用哈希载荷读取，checkpoint/metadata 共用布局检查；布局校验不能替代哈希验证。 |
| code-mode/exec/native | 保留惰性加载、delegate 生命周期、PTY 字节解析、会话保留与原生 ABI；公开 facade 和运行时载荷并非静态导入图中的死代码。 |
| diagnostics/settings | 保留诊断停止顺序及显式设置写入；语音/LAN 功能已移除。 |

宿主 render fallback、第三方所有权守卫、锁/提交顺序和原生资源布局承担真实兼容职责；不为缩短文件而删除这些边界。实现分歧由源码和 Git 历史持有，[PATCHES](../vendor/pi-codex-conversion/PATCHES.md) / [UPSTREAM](../vendor/pi-codex-conversion/UPSTREAM.md) 解释差异与选择性移植流程；累计 patch 和整树覆盖式同步已撤销。运行 JS 保持原路径并提交，声明由开发检查生成且不入 Git。

condense 将新工具结果的原文、确定性候选和发布后的表示分开管理。批次记录统一携带去重结果、准备结果与摘要结果，串行/并行调度和提交直接消费同一记录；去重仍先于准备完成，保留失败恢复顺序和原始回调索引。标量设置的字段表、解析、显示与平层/嵌套写回由 `setting-fields.ts` 单点拥有，overlay 与 `/pruner` 命令保留各自的非法值处理；`session_start`/`session_tree` 共用同一套分支恢复函数，配置加载、fallback 重置和 boot 提示仍只在 `session_start`。执行层负责截断前日志捕获，condense 的 `spill.ts` 统一批次归档与 backfill，调用方仍决定何时允许隐藏；会话 blobs 不属于显示环形缓冲的清理范围。预热运行时通过同步事件请求同一份已完成投影，flush 期间不发起预热。goal 的动态预算作为追加消息，不再改变系统指令前缀。

Action Fusion 的共享流程与按路径排队由 vendor `tools/action-fusion.ts` 拥有；`action-fusion-command.ts` 分别适配 Pi bash operations 和现有 exec session manager。原生入口与普通/嵌套 patch 消费同一版本回执。`extensions/action-fusion.ts` 通过会话事件总线提供启用状态，转换层在所有扩展初始化后的 session_start 同步普通 patch 声明，Code/Notebook 构造工具时读取同一状态；关闭入口时两条路径都撤去融合声明，重载时注销监听，不共享进程级开关。`src/fusion-view.ts` 组合既有修改和 shell renderer，分别判断两个阶段，不重新执行工具。Code/Notebook delegate 将完整回执写入独立 journal，condense 按固定字节范围导入子调用，显示 trace 淘汰不会影响证据。

## 数据流

```text
宿主事件 → 状态/度量 → snapshot → chrome 与转录组件
宿主 updateContent → AssistantView → 阶段策略 → 子树装饰
渲染数组 → 来源映射 → 当前帧选区 → 逻辑文本或原生回退

Context / transcript → 统一准备 + 工具放置 → Responses input
回放切片 ────────────沿用完整历史决策───────────┘
```

状态与渲染分离：消息结束只原位关闭计时，不改身份；会话重置清空身份索引和交互控制。动画帧不扫描 session、不读磁盘或查询额度；provider/runtime 的 I/O 不进入显示组件。

## 验证

全仓检查通过模块/声明/静态及字面量动态导入索引定位重复，再沿各领域的消费者核对；原生 Rust 检查入口与集成边界，不声称逐行审计全部上游实现。实际检查结果与局限统一放在 [VALIDATION](../VALIDATION.md)，测试命令放在 [开发说明](development.md)。


受控 OCC 由 condense 的单一维护状态管理，持久化等待、实际工作计数、改写保持与每请求尝试额度。conversion 继续独占 before_compact 钩子，以 promise broker 等待受保护候选，任何失败显式取消；goal 暂存既有续跑，维护后通过一次性命令在执行时复查。归档记录与发布的 pruning 记录分开；有效投影的内容采用宿主 context_edit，而 frontier 保持原始来源的 assistant 序号。主动 OCC 的后端范围与限制见 [condense](features/condense.md)。
