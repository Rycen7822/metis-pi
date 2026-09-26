# 开发与验证

需要 Node.js >=22.19.0；完整开发检查需要 `npm install --ignore-scripts --no-audit --no-fund` 安装 devDependencies。Pi 的生产安装不提供所有测试所需的宿主依赖。

## 检查入口

| 命令 | 范围 |
| --- | --- |
| `npm run verify` | 先重建并核对 vendor 产物，再做源码/测试/vendor 类型检查、全部 Node 测试（含 vendor 激活与真实 Pi 宿主契约）和包内容 dry-run；PTY 单独运行。 |
| `npm run check:core` | `src/` 类型检查。 |
| `npm run check:test` | 全部 `test/**/*.mts` 的 TypeScript 语义检查。 |
| `npm test` | `scripts/test.mjs all` 稳定发现全部 `.test.mjs/.test.mts`；排除 support，Node 逐文件隔离。 |
| `npm run test:fast` | 只运行 `test/core/`：规则、受控状态机及纯渲染原语；不创建临时仓库、任务 store 或技能目录。 |
| `npm run test:host` | `test/contract/` 的宿主/扩展入口契约，加 package 静态交付检查。 |
| `npm run test:protocol` | `test/protocol/` 的请求准备、转录、compaction/replay 与 context operation 协议；直接使用构建后的 provider。 |
| `npm run test:io` | `test/io/` 的 Git/文件读取、todo store、patch 前镜像及 vendor 补丁交付。 |
| `npm run test:resource` | `test/resource/` 的进程、缓存/heap、clipboard、受控 Git tracker、warning 租约与 vendor 状态/传输资源测试。 |
| `npm run test:chrome` | 跨执行层的 chrome 专题：展示规则、editor/appearance/copy/layout 宿主契约及复制缓存、heap、Windows clipboard 资源契约。 |
| `npm run test:pty` | 隔离 HOME、真实 tmux/Pi、本地离线 provider；完整验证所选 journey，缺依赖或跳过滚轮均失败。 |
| `npm run test:pty:strict` | 保留的发布门禁命令，与 `test:pty` 采用相同的必执行规则。 |
| `npm run preview` | 从生产渲染器生成 `docs/preview.html`、`docs/transcript.ansi`、`docs/transcript.txt`。 |
| `node scripts/copy-perf.mjs` | 三组成对、隔离进程的原生/来源包装帧耗时，以及包装开启时的复制耗时；不含系统剪贴板。 |

先跑改动附近的测试；跨模块改动完成后运行 `verify`。渲染/交互变动还应运行 PTY；`test:pty` 与 `test:pty:strict` 均要求 Pi/tmux，E1另要求Git；设置 `PCX_PTY_SKIP_WHEEL=1` 会失败，不存在跳过手势后成功的模式。PTY 的 E1–E6 各用新 Pi 进程和工作目录；可用 `npm run test:pty:strict -- --journey=E3` 单跑某段。驱动使用独立 tmux socket、关闭 clipboard passthrough，并在隔离的 Pi 进程中把真实 Ctrl+C 文本写入本地 sink 做逐字比较，不写系统剪贴板。真实宿主入口契约在独立测试进程强制 truecolor，避免继承的 `NO_COLOR` 弱化颜色断言。

PTY provider 统一负责 SSE chunk、usage 和结束帧；文本与 thinking 只声明各自的分块节奏，工具调用保留独立结束原因。终端驱动通过同一 capture 路径取得普通或 ANSI 帧，各 journey 持有本地截图；单次输入、剪贴板精确文本和真实 todo 重启状态继续独立断言。

每条 PTY journey 声明自己的响应序列；provider 只记录实际 HTTP 请求并发送这些数据，不解析提示词、不依据 tool-call 历史推进场景。预定错误可重复响应宿主重试；意外请求或未消费的响应使验证失败。journey 直接检查收到的提示词和草稿，E2 核对真实 bash 结果，E6 核对两个 skill 块、正文、尾部文本和未展开触发词。固定确认消息不能替代实际请求与执行结果；E5 等待最后一轮完成后再重启。

E3只在终端验证单击、滚轮、双击的单向链路，状态往返归组件测试。E6在同一草稿验证第二个`/`与`￥`，再提交一次真实双技能请求；Tab之前必须等待过滤后的目标候选，旧菜单的通用文字不足以证明已经就绪。`verify`会重建dist，不能与使用同一工作树产物的PTY并行运行。

E1独占真实Git运行中更新到footer的绿红显示；E4独占滚动inset选区的完整Ctrl+C、精确sink文本、草稿保留/提交与无选区清空；清空后必须实际提交并核对provider请求，shell回显不能证明Pi存活。PTY子进程显式清除NO_COLOR并启用truecolor；全屏视口外内容不能用tmux scrollback存在性来证明，应检查当前可见窗口和实际输出。

测试按执行依赖归入 `test/core/`、`test/contract/`、`test/protocol/`、`test/io/` 和 `test/resource/`；根目录只保留 package 静态交付检查。上游更新禁令检查源码；生成物由 `vendor:fresh` 清理重建并检查一致性，注册接线由真实宿主契约负责。原 chrome、transcript、host 与 vendor 专题已分配执行归属，专题命令可跨层选取。`vendor:smoke` 是注册契约的便利入口，不在 `verify` 中重复运行。测试应核对最终行为或真实宿主形状，避免只证明内部假设。

已拆开的职责边界：

| Owner | 负责的行为与依赖 |
| --- | --- |
| `core/chrome.test.mjs` | footer 布局、未知/零值、header 身份；直接输入快照，使用真实列宽原语，不启动会话或 editor。 |
| `contract/history-window`、`contract/fullscreen` | history 直接挂载既有 history system，独占分页、缓存、锚点、pin 和原生导航；复制用例自行安装必需包装器。fullscreen 保留真实双侧 gutter、鼠标命中及原生/外来 wrapper 租约；滚动inset下的完整复制流程归PTY E4。 |
| `core/ui-metrics` | 一条带独立中间预期的 interaction 轨迹保护重试时钟、thinking 暂停、usage 去重、结算与下一轮清零；fresh writing、closed thinking和retry合入同一时间线，实际 ticker 回调独立保留。 |
| `core/transcript.test.mjs` | identity、finalize、thinking run 时钟；同一读取追加轨迹检查分组、刷新与 renderer 投影，尾项预期独立于生产 plan；无宿主组件和主题初始化。 |
| `core/todo-model`、`contract/todo-tools` | model保留独立三级路径和领域规则；tools拥有complete/skipped列表轮换、reopen后追加及complete→skip拒绝。仅按生产工具使用的转换保护契约，不穷举未使用的内部transition组合。 |
| `core/turn-summary.test.mts` | 摘要纯格式、token顺序与v1/v2历史渲染。注册和持久化由appearance实际事件链承担，不直接构造已被上游排除的record状态。 |
| `contract/appearance.test.mjs` | 真实 Pi 独立子类上的 activation：启用/禁用/非交互、重复会话与 API 边界，以及 UI slots、Working、summary、安装/失败/取消/恢复；同一interaction核对摘要schema、墙钟、重复settled幂等与已注册renderer；projection缓存、模型切换、事件与会话刷新共用同一footer轨迹，每次退出核对完整原型恢复。真实Git更新到终端footer及颜色归PTY E1。 |
| `contract/host-entry.test.mjs` | shipped appearance 入口负责分组 read、原生图片/子树、foreign self-shell、关闭恢复及 exec/write/edit/apply_patch 接线；真实 bash 执行到 provider 的完整链路归 PTY E2。动态 enabled 开关由 adapter 套件独立负责。write 的四阶段参数、真实工具执行、磁盘内容和完成展示共用一条入口轨迹。入口在 session_start 前登记 shutdown 和原型恢复检查，覆盖部分启动失败。 |
| `contract/editor.test.mjs` | 真实 CustomEditor 的 surface、硬件光标、IME原字符、第二skill trigger；共用原生editor构造。Ctrl+C复制/草稿保留和无选区原生清空归PTY E4。 |
| `contract/adapter.test.mjs` | 真实 ToolExecutionComponent 的选择器、工具归属、包装器安装/恢复和历史行刷新；不再装配 activation。与 appearance 仅共享原生子类隔离能力，不复刻宿主容器或渲染算法。 |
| `contract/clipboard-facade`、`resource/windows-clipboard` | facade 使用隔离的真实 TuiAltScreen 子类，仅替换后端并记录原生反馈；Windows worker独占进程协议、FIFO、deadline和close/exit清理。PTY E4的真实Ctrl+C走原生复制方法和隔离sink。 |
| `contract/copy-mirror`、`contract/copy-text` | 真实 Text/Markdown 的复制语义、精确空白和原型重复安装；每例显式创建 session，退出释放实例资源。进程持有渲染包装器，后续 session 接管时不叠加包装。 |
| `resource/copy-cache`、`resource/copy-heap` | 重建/对齐预算及独立子进程中的保留堆上限；用真实 Text 子类制造新数组返回值，保留 throttle、映射和行身份断言。 |
| `io/exec-output` | buffer 存储、surrogate/字符预算、按需读取、spool IO 故障与恢复；不导入进程管理器。 |
| `resource/exec-session` | native exec/wait 生命周期；fixture 持有 manager 与命令启动，仅与 IO 共用 spool 目录观察函数。执行取消/poll 取消及读失败/清理失败分别断言。 |
| `resource/exec-output-memory` | 独立进程中的 heap 预算；不加载 native bridge，不共享业务预期。 |
| `contract/vendor-background-bash-widget` | 同一真实 Pi widget 注册表和 above-editor 容器贯穿折叠、快捷键、刷新、切换和关闭；组件从宿主注册表读取，不再维护平行的手写 factory 状态。同一宿主先在两个会话存在时验证 RPC 不注册，再进入 TUI，最后验证空会话清除真实槽位。 |
| `contract/thinking.test.mjs` | 真实 AssistantMessageComponent 与实际 rail/peek/clickable 组件验证折叠、可见内容复制、手动选择及全局展开；peek 通过 MouseRegion 手势路由并观察实际截断正文，不手写包装对象或直接驱动控制器。多 run 与原生历史独立，原型按用例清理。 |
| `contract/host-surface.test.mjs` | 包主题经真实 loader 到 UserMessageComponent 的逐行 #292929 真彩色卡片、软折行和背景 reset；独占主题目录与颜色环境。 |
| `core/git.test.mts` | numstat/NUL parser 和 HEAD 错误判定；literal 预期，不创建目录或执行 Git。 |
| `resource/git-tracker.test.mts` | 采样命令协议、timer、合并刷新、dispose 晚到结果；同一命令夹具提供立即结果和明确的 diff 进入/释放通知。定时器测试不能主动 refresh；晚到测试先确认读取挂起再销毁。`.git` 标记与未跟踪文件使用真实临时磁盘和 line-count cache，Git 命令响应受控。 |
| `io/git-changes.test.mts` | 同一真实仓库验证 WIP→暂存/未暂存→局部提交→清零；unborn→首次提交、rename、损坏 HEAD、文件读取与缓存各保留独立见证。 |
| `core/todo-model`、`core/todo-rows` | model 使用独立三级路径/顺序预期；实际转换归工具入口，退役未使用的全矩阵与120排列；widget 行和纯文本列表直接消费合法快照，不经过工具或磁盘准备数据。 |
| `contract/todo-widget` | 受控快照上的注册、显隐、手势、缓存与恢复；旧完成任务在真实重启后自动隐藏由严格 PTY E5 拥有，并有时间戳故障见证。 |
| `contract/todo-tools` | 参数/路径映射、错误与通知、force 的真实 handler 接线；依赖仅 read/mutate，直接提供合法任务快照，不打开磁盘 store。 |
| `contract/todo-entry` | 用同一个 context 调用实际注册的工具、input/steer、widget 工厂及 `/todos` 命令；独占外部文件更新和隐藏设置持久化的 UI 桥接。 |
| `io/todo-store` | 持久化、锁、队列、GC、缓存指纹及读失败；独占工具 evidenceFiles 的磁盘存在性检查与重新打开后的完成记录，独立于 UI 手势和行投影。 |
| `contract/skill-host-label` | 每例独立的真实 Pi 子类；以未补丁原生组件的完整 ANSI/正文为基准，验证 trim、去重、token、重复安装与展开/折叠；真实鼠标路由、单次缓存失效、全部转交事件及原接收者/返回对象均直接断言。 |
| `core/skill-input`、`io/skill-discovery` | 输入/补全只接收显式正文和目录列表；发现 owner 用一次真实目录生命周期验证 loader、文件正文、首次扩展扫描、miss 缓存和 Pi parser。 |
| `core/write-diff`、`io/write-tracker` | diff 使用独立最小编辑数示例、同源文本的单/双窗口字面行号及 4,000 行成功/预算拒绝边界；真实前后镜像、归属、失败和并发隔离由同一交错写入IO生命周期验证。 |

compaction 的正常请求、checkpoint replay 和最终出站请求由 `protocol/vendor-codex-compaction` 中的同一会话场景贯穿验证；最终工具表、窗口顺序及唯一 trigger 在边界处完整比较。`protocol/vendor-codex-transcript` 独占工具声明 schema、tool-search 配对和 defer-loading 的独立预期。context-edit 的七种 checkpoint 边界、native/portable 次数和窗口失效继续由独立套件保护。待消费窗口也由该套件拥有：真实 compaction handler 产生窗口，同一轨迹验证两种 native 开关下预热不消费、普通请求保留、最终摘要消费和错会话拒绝。portable摘要的preparation来自当前Pi可见会话，最终native和portable请求都独立检查编辑后正文存在与旧正文消失。transport先写独立字面预期，再克隆为可变请求body；发送后不能用该body重建预期。provider-preparation 只负责模式矩阵、真实bridge/window最终结果与异常短路，不再另建 checkpoint。context handler 的宿主 runtime 只提供显式能力，不以 Proxy 为未知调用伪造成功。

协议捕获 fixture 只注册构建后的 provider，不启动整个 vendor 扩展。`contract/vendor-codex-registration` 中，目录继承、刷新、Reserve 与重复注册直接验证 provider 的公开注册接口；入口接线使用真实 `DefaultResourceLoader`、`AgentSession` 和宿主事件分发，验证 native provider、工具 schema 及最终请求。删除手写 Pi API/上下文与按私有函数名选择回调的夹具；临时 agent 目录、内存会话和 session_shutdown/dispose 由该入口用例拥有，宿主报告的生命周期异常直接使测试失败。需要禁止网络的文件显式使用 `test.beforeEach(disableNetwork)`，导入模型或凭证数据不会安装 fetch 钩子；用例退出自动恢复。compaction 的真实 SessionManager、独立 wire 预期及 native/portable 请求次数仍保留。

工具展示组件由 `src/chrome/tool-components.ts` 负责：shell/diff 使用同一显示行与复制元数据缓存，shell 工厂直接实现既有 `ShellFactories` 接口，只接收既有 `LayoutOps` 能力，不直接导入宿主包。appearance 入口传入真实列宽/换行函数并负责接线；`contract/shell-scroll` 直接使用这些工厂、真实 Pi 独立子类、adapter 和复制系统，验证滚动、缓存、stream/expand/theme 与整行复制，不启动扩展或会话。`contract/host-entry` 保留完整入口的实际接线验证。

write的交错开始/逆序完成、后续磁盘状态与失败属于同一IO轨迹；单/多文件patch view政策留IO，真正执行与pre-image归host，125行号×12列的独立输出归真实core renderer。goal 的 shutdown/reload 同时核对旧 UI 不再更新、替换 UI 单次刷新和实际 timer 句柄全部清理，静默回调不能替代资源释放。Working 与 UiMetrics 使用生产默认定时器和 Node mock timers；UiMetrics 在同一 interaction 中检查 timer 回调与全部句柄清理；IME字素预期直接书写，不从另一套分词算法推导。

replay、compaction request 和 context-edit 共用 `helpers/vendor-codex-sessions` 的 Pi 内存会话。Pi 负责 ID、父子链、当前分支和 checkpoint 快照；fixture 只追加测试声明的消息并返回定位 ID，不另存一份 entries/leaf 状态。历史 checkpoint 的 `systemMessage` 可作为显式兼容性输入覆盖；wire 预期仍独立书写，不能由会话或被测实现自动生成。

`helpers/git.mts` 只提供临时已提交仓库、Git执行和带清理的tracker；`refreshAndExpectSample`明确包含主动刷新，只用于显式采样场景；定时器测试直接观察snapshot。每条测试显式提供初始文件、后续修改与预期计数。PTY E1使用已有隔离工作目录验证真实Git footer，appearance不再重复建仓。parser不依赖资源fixture。

Shell核心用最小语法示例、物理预算边界、独立content/hard-soft预期验证布局，不自行重建复制器；copy contract直接观察实际serializer的完整和部分选择。资源场景共享调度流程，同时明确观察活跃读取发布与销毁后丢弃。

Git tracker 的采样轨迹统一覆盖缓存、失败恢复、HEAD 变化和离开仓库；首次 HEAD 失败单独运行。定时器、活动刷新、并发合并与 dispose 晚到结果在同一个已启动实例上验证。受控 exec 分别回答 HEAD 查询与对象格式查询，避免两个命令同时失败掩盖错误回退。

工具的 system.store 只要求 `read/mutate`；命令诊断另外要求 `read/status/collect`。工具映射测试直接运行真实模型函数，受控存储只保存成功结果，不模拟磁盘锁、队列或 GC。

widget 的 system 接口只要求 `snapshot/settings/saveSettings` 与 `turn`，不依赖完整工具系统或可变 store。测试中的 `helpers/todo.mts` 只构造数据，状态转换、并发与持久化仍由对应生产实现和 owner 验证。

todo 入口拥有完整会话生命周期：切换会话前先从旧 UI 撤下面板并释放 store，关闭时使用同一释放路径。入口契约在同一个扩展实例上验证磁盘变化、隐藏设置、UI 交接、重复关闭和再次启动；组件测试只负责局部展示与交互，不模拟会话分发。

`activate().whenReady()` 返回调用时当前会话的安装 Promise，成功、退避或取消后均结束；测试在 `session_start` 后取得它，再观察 UI。测试不依赖 Working 的显示副作用或固定延时。各契约仍运行于 Node 独立文件进程，组件原型租约在用例清理时恢复。

UiMetrics 核心用例显式拥有 mock interval，并在退出时 reset；单调时钟输入与定时回调触发分别可控。状态/时间表使用手写 expected，重试和跨响应轨迹保留明确调用顺序。

appearance 配置在 activation 时读取，因此配置分区各自激活；readiness、footer 能力缺失/恢复、安装失败和提前 shutdown 则在同一 activation 的连续会话上验证。session_start 先失效化旧 generation，再恢复旧 UI，最后绑定新 context，避免旧安装标记或轮询器污染新会话。

todo store 的基本持久化、单次/并发队列、重开和损坏归档共用同一真实目录；GC、snapshot 指纹、IO 失败与读文件竞态各有独立场景，不复写模型转换矩阵。

UsageLedger 的实时确认、重复回放、修正与 session rebuild 使用同一个实例，重建检查已有账目被替换；不能只在空 ledger 上验证重建。无效 usage 与零分母规则保持独立。

HostData 的 core 测试只提供 model、session 标识和 getContextUsage 能力；同一生命周期验证接收者、模型替换、各类缓存失效与解除/重新绑定，不另造包含 UI/cwd 的宿主夹具。字段校验、unknown 与异常重试各自保留；appearance 继续验证实际 footer 接线。

一个行为只在最靠近规则的测试里保留完整判定表：速率在 `test/core/`，Git 按上表三个 owner 分配，todo 状态转换在 `test/core/todo-model.test.mts`，shell 行预算及截断窗口复制在 `test/core/shell-layout.test.mjs`，预期上限独立于生产常量，vendor 最终请求在 `test/protocol/`。`test/contract/host-entry.test.mjs` 检查真实入口、工具槽和补丁执行；PTY 只验证真实终端输入、布局、复制字节和本地 provider 回调。跨层测试保留接线见证，不重复业务矩阵。

新增或保留测试应有具体产品风险：优先用户可见结果、真实接线、持久化和资源生命周期。不要固定无契约要求的对象身份、内部重建次数或动画逐帧数值；不要用被测实现生成预期值。跨层重复和不可达输入可删除，不必为每个旧断言新建替代测试。随机或穷举输入需要清楚的失败含义和独立预期，数量本身不是保留理由。

## vendor 维护

修改 `vendor/pi-codex-conversion/src/`，再运行：

```bash
npm run vendor:build
npm run vendor:patch
npm run verify
```

`dist/` 和 `changelog.js` 随包分发，必须由源码生成。`vendor:patch` 需要 `references/howaboua-pi-stuff/` 的 pristine 基线；只接受 git diff 的正常退出或差异退出码，启动失败、信号、输出超限及其它错误必须失败并保留旧补丁，不能发布截断输出。升级上游及载荷范围只在 [UPSTREAM.md](../vendor/pi-codex-conversion/UPSTREAM.md)维护；本地差异只在 [PATCHES.md](../vendor/pi-codex-conversion/PATCHES.md)维护。

`vendor:fresh` 重建后检查 tracked 改动和新生成的 untracked 文件是否与 Git 基线一致；未提交的合法源码/产物修改也会导致它失败，因此工作区修改期间需比较重复构建结果，并在隔离上游副本验证补丁重放，不能把该退出码直接当作构建漂移。

## 代码与文档约定

- 显示模块不注册工具或改写模型上下文；`src/todo/` 是独立工具子系统，goal 状态核心只做内存计算，宿主副作用留在 `extensions/goal.ts`。范围由 `test/package.test.mjs` 检查。
- chrome 只消费结构类型与注入能力，不直接导入宿主包。未知宿主契约按现有规则退避；恢复原型时不得覆盖后来安装的补丁。
- 保留错误、锁、提交顺序及回放边界。性能结论需要测量，离线替身不等于真实服务端证明。
- 文档按职责修改原页：README 是入口，features 是用法，configuration 是配置契约，architecture 是职责，VALIDATION 是当前证据，CHANGELOG 是版本摘要。不要逐轮追加过程、复制同一契约或新增审查报告。
- 验证失败和未覆盖项必须保留；旧记录由 Git 历史检索，不另建归档副本。引用代码用文件与符号，避免易失效行号。
- 使用 ESM 与显式 `.ts` 路径；自有源码 2 空格，vendored 文件按原风格维护并保留许可归属。

安装到本地 Pi 用 `pi install .`，重启后加载新进程。发布、推送或修改用户的实际安装配置是独立动作，开发测试不自动执行这些操作。
