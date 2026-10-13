# 架构与所有权

根 `package.json` 统一依赖、版本、入口和发布载荷；加载 `extensions/*.ts` 与 `themes/metis-pi.json`。Pi 入口直接使用 TS；子代理核心使用 Python daemon 和 JS SDK runner。

## 入口和模块

| 入口 | 所有者与职责 |
| --- | --- |
| `appearance.ts` | `src/extension.ts` 装配显示、宿主适配、转录、chrome、复制和诊断。 |
| `skill-mux.ts` / `skill-entry.ts` | Pi 持有 skill 来源和优先级；metis 负责多输入展开、补全、标签和折叠。 |
| `goal.ts` | 入口负责宿主 I/O、提示和工具；`src/goal-state.ts` 负责状态、计时、分支恢复和用量。 |
| `dynamic-agents.ts` | 每个 run 的全局指令快照、来源恢复与 Pi 原生请求投影。 |
| `condense.ts` | 重复安装检测和摘要用量显示；`src/condense` 负责原文、精简、摘要、恢复和 OCC。 |
| `action-fusion.ts` | Pi edit/write 的 then_run 增强；`src/execution/action-fusion.ts` 负责路径排队、快照、取消和回执。 |
| `execution.ts` | deferred PTY 进程工具、执行设置、后台 shell 和资源清理。 |
| `mcp.ts` | 默认关闭；`src/mcp` 持有目录缓存、连接租约和工具装配，协议/OAuth/CLI/codemode/权限由 Pi 提供。 |
| `subagents.ts` | `src/subagents` 持有父会话租约、接收票据和轻量交互；`core` 原生持有子代理 Runtime、账本、任务队列和进程管理。 |
| `web-access.ts` | `src/pi-web-access` 管理搜索、提取、内容存储和 Curator；聚合工具沿 Pi deferred/codemode 发现与调用。 |
| `session-recall.ts` | `src/pi-session-recall` 管理会话检索与回读；辅助模型请求使用当前 Pi ModelRuntime。 |

全局 `metis-pi.toml` 的 `appearance.enabled` 只控制 appearance，独立入口由 Pi 包过滤控制，见 [配置](configuration.md)。配置写入在跨进程锁内读取最新内容、合并并原子发布；参数说明文档不占用配置临界区。

## 显示数据流

宿主事件 → 状态/度量 → 快照 → 组件；宿主 updateContent → AssistantView → 阶段策略 → 子树装饰。

| 领域 | 主要模块和边界 |
| --- | --- |
| 适配 | `host-data.ts` 归一化公开数据；`adapter.ts` 校验工具来源和 renderer 所有权，每次行渲染共用一次工具查询；`config.ts` 校验显示设置。 |
| 工具输出与修改 | `renderers.ts` 装配，`shell.ts` / `diff.ts` / `write-preview.ts` 布局；`write-tracker.ts` 保存真实前后镜像，与 Fusion 共用路径规则。 |
| 转录与思考 | `transcript-state.ts` 持有消息身份、语义 run 和计时；仅用已观察的响应身份恢复计时，内容相同不合并，身份冲突不推断时长；AssistantView 解析一次，`thinking-view.ts` 持有交互形态。原生 codemode 的 nested 工具事件不参与顶层探索分组。 |
| chrome | `chrome/install.ts` 捕获宿主；editor/header/footer/working 各自持有组件；`fullscreen-layout.ts` 统一留白和 history-window，只安装一个布局根拦截器。 |
| 度量与摘要 | metrics/outcome/usage/speed 模块分别采样与去重；`git-changes.ts` 只读 Git；`turn-summary.ts` 是显示层唯一追加会话记录的模块。 |
| 复制与呈现 | `selection-copy/` 读取当前已提交帧的来源映射，不额外渲染；缓存校验原生渲染行，未知区域原生回退。渲染映射和计数随进程保留，选区序列化按真实 TUI 租用并释放，支持宿主代理切换接收者。颜色/控制序列在显示层处理，glyph 转换在布局之后。 |

chrome 通过结构类型和注入能力访问宿主。动画帧不扫描会话、读磁盘或查询额度。显示适配保留原执行、结果和模型正文。
宿主事件类型及终端字符宽度、grapheme 截断复用 Pi 的公开接口。

`src` 包含领域逻辑和宿主适配模块；纯领域模块保持宿主无关，适配模块可以导入 Pi 公共 API。扩展间的 Metis 事件名称和 payload 合同归 `collaboration.ts`；监听方先检查事实字段，压缩所有权查询和压缩前等待请求保留同步响应合同。

## 执行与上下文

```mermaid
flowchart LR
    Pi[Pi provider / OAuth / 工具与 compaction] --> UI[显示与独立功能]
    Pi --> Native[原生 codemode]
    Native --> Tools[PTY / edit-write Fusion]
    Tools --> Archive[输出与 nested 归档 / 完整性]
    Archive --> Condense[condense 投影 / OCC / 回读]
    Condense --> Pi
```

Pi 持有工具选择、权限、JS 编排和普通上下文管理。metis 的执行补充只提供 PTY 进程工具，不维护第二套 provider 或 JS 引擎。普通图片使用 Pi 1.2 原生 `read` 与 codemode `image()`。

显式启用 MCP 后，每个服务器由一个 session owner 共享连接；每个工具独立注册，调用经过 Pi 原执行链。目录缓存不授权执行，实时 schema/身份变化会拒绝旧调用；空闲回收、取消和关闭属于该 owner。MCP 协议与 OAuth 复用 Pi 公共包；服务器配置、凭据及 CLI 保持原生格式。切换步骤见 [配置](configuration.md#mcp)。

condense 分开持有原文、候选和已发布表示；父子引用、保护、错误和归档失败参与发布门禁。错误清理按 occurrence 配对，程序派生身份不由用户正文推断。配置模块拥有默认值和领域合法值，设置预设拥有 UI 标签；保存负责持久化，运行时应用配置并按相关政策决定失效范围。显示设置不会取消领域工作。Pi 发起压缩并提供边界；普通模型由 condense 的 OCC 准备候选，Codex 远端检查点及其原文恢复由 `codex-compaction.ts` 发布，OCC 查询该所有权后让出同一次请求。执行模块只提供忙状态，goal 暂存续跑并在完成后复核。

执行 bridge 持有每个进程的字节解码、序号、退出和串行轮询；manager 组合 process handle，独立持有等待、交付、保留与展示状态。输出流尚未关闭或缓冲已淘汰未读数据时，归档记录不完整及其原因，并保留真实进程退出码。查询分页共享字节来源，不把历史条目或证据目录伪装成工具执行。

Web 搜索的公共结果归 `search-types.ts`，provider 身份与标签归 `search-providers.ts`，选择与回退归 `search-router.ts`；具体 adapter 保留各服务的协议、鉴权、能力与计费差异。`search-response-policy.ts` 保证筛选后答案、来源和内联正文一致，底层域名匹配与答案格式化各自保持纯粹。`search-error-redaction.ts` 统一诊断脱敏，保留 HTTP 状态、错误名称和无需脱敏时的原始异常；活动结算仍归具体 adapter。HTTP 失败事实与展示文案分开，非空正文不代替完整传输或模型完成。

网页请求使用显式 transport，不改写进程全局 fetch；代理和 SSRF 校验使用同一实际路由，默认将已验证的 DNS 地址固定到连接。Curator 的资源与 Cookie 诊断归具体实例或操作；页面使用固定版本和完整性校验的 Markdown parser/sanitizer，结果正文不能提供 UI 身份属性，选择操作只读取页面自身创建的卡片与控件。

子代理核心由 metis 完全维护并随包交付，不依赖独立 subagent-pi 仓库或运行包。每个父 Pi session 有独立 scope；前端断开不默认关闭 child。已确认的 wait 接收阻止重复唤醒，未观察事件使用 custom message；接收证明校验 session、scope、receipt 和正文 digest。不确定交付保留账本，wait、结果读取和状态检查按已交付票据消费终态通知；列表保留 attention，结果文件支持重复读取。Worker 的进程状态与每次 run 的投影分开，Runtime 仍是任务推进者。生命周期与运行要求见 [子代理](subagents/lifecycle.md)和[管理入口](subagents/cli.md)。

## 生命周期与交付

- 会话切换先失效化旧 generation，再恢复 UI、释放资源、绑定新上下文；晚到结果不得重新安装旧组件。
- 组件租约仅恢复自己仍拥有的方法；部分安装失败和重复关闭也清理。
- GoalState 读取不累计时间，用量归属于启动该回合的目标，持久化为 session custom entry v2。
- 原文 blobs、Fusion 日志与显示缓冲寿命不同；显示淘汰不授权删除恢复证据。锁、取消和提交顺序由各功能 owner 持有。

`native/tools` 保存 PTY 源码与锁文件，`assets/native-tools` 保存随包可执行资产；shell parser WASM 位于 `vendor/tree-sitter-bash`。安装不编译 Rust，发布包不携带 native 开发源码。来源见 [执行模块来源](provenance/execution/README.md)与 condense 自身目录；交付流程见 [开发说明](development.md)。
