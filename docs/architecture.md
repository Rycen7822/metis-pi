# 架构与模块职责

## 入口与边界

`package.json` 的 `pi.extensions` 加载 `extensions/*.ts` 和 `vendor/pi-codex-conversion/dist/index.js`；主题为 `themes/metis-pi.json`。

| 入口 | 职责 |
| --- | --- |
| `extensions/appearance.ts` → `src/extension.ts` | 连接宿主与显示模块，安装工具行、chrome、复制和诊断。 |
| `extensions/skill-mux.ts` / `skill-entry.ts` | skill 输入展开/补全、标签和点击折叠。 |
| `extensions/todo.ts` → `src/todo/` | todo 工具、命令、持久化和面板。 |
| `extensions/goal.ts` → `src/goal-state.ts` | 入口拥有宿主 I/O、命令、提示与工具；状态核心拥有目标、时钟、分支恢复和回合用量。 |
| vendor `src/extension/register.ts` | Codex 转换层组合根，通过构建后的 `dist/index.js` 加载。 |

显示适配保留 Pi 原生执行与结果；工具注册和模型上下文处理由独立 goal/todo/vendor 功能承担。`test/package.test.mjs` 检查自有源码的注册、持久化与上下文边界。chrome 仅依赖结构类型和注入的宿主能力。

## 自有源码

| 领域 | 模块与所有权 |
| --- | --- |
| 装配/宿主 | `extension.ts` 装配；`host-data.ts` 收敛公开数据；`adapter.ts` 守卫工具行 selector；`config.ts` 统一字段校验和默认值。 |
| 工具显示 | `tool-names.ts` 定义契约；`renderers.ts` 装配 call/result 两槽；`shell.ts` 按物理行预算；`diff.ts`/`diff-component.ts` 共享 diff；`explore.ts` 管理探索显示。 |
| 写入预览 | `write-tracker.ts` 记录真实 pre/post image；`write-preview.ts` 展示状态；不能从新内容臆造删除行数。 |
| 转录/思考 | `transcript-state.ts` 拥有稳定消息身份、语义 run、计时和控制器；adapter 每次更新解析一次 `AssistantView`，供阶段策略和组件装饰共用。`thinking-view.ts` 拥有交互形态。 |
| 颜色/文字 | `palette.ts` 解析颜色能力；`sgr.ts` 只解析有序命令并跳过颜色参数，`output-style.ts` 与 `surface.ts` 各自决定 DIM/背景策略；`glyph-presentation.ts` 处理字形。 |
| chrome | `chrome/install.ts` 管理安装/撤销；editor、header、footer、working、metadata 和 transcript-components 拥有各自组件；history-window/fullscreen-margin 管理窗口与留白。 |
| 度量 | `ui-metrics.ts` 管交互计时，`interaction-outcome.ts` 管终止证据，`usage-ledger.ts` 管用量去重，`output-speed.ts` 管采样；`git-changes.ts` 采样工作树 vs HEAD 的未提交改动，`quota/` 只读 Codex app-server。 |
| 摘要 | `turn-summary.ts` 是显示层唯一写会话条目的模块；仅依据终止证据生成结果，不把工具错误直接判为整个交互失败。 |
| 精确复制 | `selection-copy/` 从渲染行建立来源映射，序列化所选内容；与真实宿主行不一致时回退。映射/缓存按已提交渲染数组身份绑定，不重新渲染猜测位置。 |
| todo | model 验证领域规则，store 拥有锁与磁盘，tools 拥有路径解析/通知，widget 拥有可见状态。参数类型由 TypeBox schema 推导。 |
| goal | `GoalState` 不做宿主 I/O；快照读取不累计时间，状态切换/回合结算才记账。回合用量只记到开始该回合的目标，持久化沿用 session custom entry v2。 |
| skill | tokens 解析、mux 展开、fold/label 装饰共用宿主补丁守卫；模型仍接收完整 skill 正文。 |

## vendor 的责任边界

| 领域 | 所有权 |
| --- | --- |
| activation/config | `runtime-plan` 决定模式；普通布尔字段从默认契约读取，字段依赖在规范化后计算一次。UI 的简单开关共用字段绑定，写入保留最新草稿与未知字段；信任范围、原子写入和自定义关联控件各自独立。 |
| providers | `prepareResponsesTranscript` 统一 Context 规范化、模型能力、system 折叠和工具放置；内部转换只消费已准备数据。最终调用/结果配对由 `normalizeResponsesToolHistory` 负责。 |
| compaction/replay | 全量头部与切片显式区分；切片沿用完整历史的工具决策；重建压缩 input 与顶层 tools 一起更新，canonical 请求保留基线。 |
| context-management | Local/Tree/Remote/Hybrid 的持久化和窗口语义不同，不能用同一个重放策略抹平。 |
| Notebook | `capture-bindings-source.ts` 共享内核捕获；调用方拥有清单/事务。project/profile 共用哈希载荷读取，checkpoint/metadata 共用布局检查；布局校验不能替代哈希验证。 |
| code-mode/exec/native | 保留惰性加载、delegate 生命周期、PTY 字节解析、会话保留与原生 ABI；公开 facade 和运行时载荷并非静态导入图中的死代码。 |
| voice/LAN/diagnostics/settings | 保留世代与取消、peer 所有权、HTTP 读体前后状态检查、诊断停止顺序及显式设置写入。 |

宿主 render fallback、第三方所有权守卫、锁/提交顺序和原生资源布局承担真实兼容职责；不为缩短文件而删除这些边界。上游差异及同步只在 [PATCHES](../vendor/pi-codex-conversion/PATCHES.md) / [UPSTREAM](../vendor/pi-codex-conversion/UPSTREAM.md) 维护。

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
