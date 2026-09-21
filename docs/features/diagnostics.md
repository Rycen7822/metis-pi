# 诊断命令：`/codex-ui` 与 `/todos-doctor`

> 两个只读命令。显示出问题时先看它们——它们报告的是**真实结果**（组件是否真的装上、数值取自哪个范围），不是"应该可以"。

| | |
| --- | --- |
| `/codex-ui` | `src/diagnostics.ts` 的 `registerDiagnosticsCommand`（缺宿主 API 时静默 no-op） |
| `/todos-doctor` | `src/todo/commands.ts` |
| 参数 | `/codex-ui refresh-quota` 顺带手动刷一次额度 |

## `/codex-ui` 输出逐行含义

所有行都以两个空格缩进、`键: 值` 形式给出。未知值显示 `—`（`fmt` 辅助），**从不伪造 0**。

| 行 | 回答什么 |
| --- | --- |
| 首行 | 版本三元组：本插件版本、`mode`（tui/print/json/rpc…）、宿主 pi 版本、`revision`（宿主上下文快照修订号） |
| `composer:` | surface / prefix / metadata 三块**是否真的装上** |
| `working:` | Working 行状态与动画开关；并说明中断提示用的是 `esc`（宿主未暴露重映射信息） |
| `footer:` | **数据来源清单**：model 取 live ctx、context 取 `ctx.getContextUsage()`、session 取 `UsageLedger`（会话条目）、cwd 取 `ctx.cwd` |
| `model:` | 真实 model id / 推理等级 / provider / context 窗口（来自 live ctx，附 `revision`） |
| `context:` | 当前占用 token / 容量 / 百分比，并标注 `scope=live ctx` |
| `session:` | 本 session 累计 usage（属于 `Σ` 范围） |
| `cache:` | `cache(last)` 口径与 session 加权比率 |
| `speed:` | `tok/s` 的 token 数、观测窗口长度、`scope`（流式中实时值 vs `message_end` 确认值） |
| `interaction:` | 当前交互时钟状态（是否进行中、已耗时、思考耗时） |
| `outcome:` | 终止证据判定结果（`Worked`/`Failed`/`Interrupted`/`Ended …`）及其依据 |
| `quota:` | 额度状态、上次成功时间、是否 stale、**错误类别**（不显示原始响应体） |
| `chrome:` | editor / footer / header / working 四个 widget 的安装状态（对应 `ChromeState`） |
| `transcript:` | 紧凑转录是否接管（未接管时给出退避原因） |
| `decorations:` | 各装饰能力的 `applied` / `failed: <原因>` 明细 |
| `thinking:` | 当前策略（`streaming`/`completed`/`peekLines`）与自动可见性 |
| `fullscreen-margin:` | 留白是否生效 / `disabled(config)` / 退避原因（含实际 margin 与 minWidth） |
| `glyphs:` | 是否应用、标记数量与字符集、已处理帧数、改写次数、`include` 追加项 |
| `config:` | 生效配置全量（用于确认文件里的值真的进来了） |
| `resources:` | 定时器与资源占用：ticker、working 定时器（仅 active）、quota 定时器、git 定时器、widget |
| `git-changes:` | churn 总量、读取次数、**工作区 vs HEAD 的原始值**（可直接用 `git diff --numstat` 对账）、基线引用、轮询/去抖参数 |
| `selection-copy:` | serializer 状态、镜像 built/degraded/throttled 计数、`other-wrapper=`（是否有外来包装）、最近失败原因 |
| `copy-stats:` | 复制调用次数、各模式计数（exact/mixed/native/empty-decoration/failed）、最近模式/字符数/耗时/缓存命中 |
| `history-window:` | 历史窗口状态 JSON（已装载页、是否还有更早/更晚、行预算） |

**用法建议**：先看 `transcript` / `chrome` 判断功能有没有装上；再看 `config` 判断配置有没有生效；数字对不上时看对应行的 `scope` 与来源说明。

## `/todos-doctor`

只读诊断，做三件事：

1. **坏档归档**：`tasks.json` 解析失败/结构非法 → 归档成 `tasks.json.bak-<ts>` 并空载（正常路径下也不会让会话崩溃）。
2. **过期锁**：`tasks.lock` 超过 TTL（30 分钟）→ 归档成 `stale-lock-<session>-<at>.json`。
3. **GC**：按 `gcDays`（默认 7）清理已完成的旧列表。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| `/codex-ui` 注册与行拼装 | `src/diagnostics.ts`（`registerDiagnosticsCommand` 及各 `*Line` 构造器） |
| 诊断依赖注入 | 同文件 `DiagnosticsDeps`（chrome 状态、metrics、quota、selection copy、history window 等） |
| `/todos-doctor` | `src/todo/commands.ts`；存储侧实现在 `src/todo/store.ts` |

## 不变量与已知限制

- 两个命令都**只读**：不改配置、不写用户仓库、不触发除"刷新额度"之外的任何副作用。
- `/codex-ui` 在**没有活动会话**时只回报 `no active session`；宿主缺少 `registerCommand` 时静默不注册（不报错）。
- 诊断报告的是**当前进程内的真实状态**；它不会去验证外部工具（如另一个插件的存在）。
- 错误类别是有界枚举；原始错误体不进界面（避免把凭据/大块响应贴到屏幕）。

## 验证

`test/host/host-surface.test.mjs`、`test/chrome/chrome.test.mjs`（组件状态）、`test/todo/todo-store.test.mts`（坏档/锁/GC）、`scripts/pty-verify.mjs`（真实会话中执行命令并断言输出行）。
