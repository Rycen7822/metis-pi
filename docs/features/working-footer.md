# Working 行 / Header / Footer

> 三块常驻 chrome：输入框上方的 Working 行、启动头、底部状态行。全部经宿主公开 widget/status 接口安装，可整体卸载。

| | |
| --- | --- |
| 入口 | `extensions/appearance.ts` |
| 实现 | `src/chrome/working.ts`、`src/chrome/header.ts`、`src/chrome/footer.ts`、`src/segments.ts` |
| 数据快照 | `src/chrome/snapshots.ts`、`src/ui-metrics.ts`、`src/usage-ledger.ts`、`src/output-speed.ts`、`src/git-changes.ts` |
| 安装 | `src/chrome/install.ts` |
| 配置 | `working.*`、`footer.*` |
| 诊断 | `/codex-ui` |

## Working 行

```
• Working (3m 36s · thinking 24s · esc to interrupt) · read
```

- **相位**：`Working` / `Writing`（写作中）/ `Waiting for input`（等用户输入）；思考结束后细节里出现一次 `thought for Ns`。
- **只在一次交互期间显示**：`agent_start` 打开、`agent_settled` 关闭（`setWidgetVisible(active)`）。
- **安装方式**：公开的 above-editor widget（`ui.setWidget(WORKING_WIDGET_KEY, factory, { placement: "aboveEditor" })`）。装成功后**才**隐藏宿主原生 loader 行（`ui.setWorkingVisible(false)`）；如果 widget 安装失败，则退回 `ui.setWorkingIndicator`，**绝不出现两行 Working**。
- **彗尾 shimmer**：亮头 + 连续渐隐尾，扫描速度 `SHIMMER_CELLS_PER_FRAME = 0.25`（32ms 一帧 → 每格 128ms）。
- **两个定时器**：计时由交互时钟（1 秒）驱动，动画由自己的 `working.animation` 定时器（`animationIntervalMs`，默认 32，钳制 32..1000）驱动；settle 后都归零。
- **动画门槛**：`truecolor` 与 `ansi256` 开启动画；`ansi16` / `none` 静态。
- 动画帧不扫会话、不读盘、不查额度（实测约 0.003ms/帧）。

## Header

1–2 行极简身份行，显示**运行时读到的真实版本号**（本插件版本 + 宿主 Pi 版本），不是硬编码。

## Footer

```
目录 (分支) +A -D          N tok/s · ↑input ↓output · cache 命中率 · Codex 5h 82% · week 64%
```

- **布局**：左侧 = 目录 + 分支 + 变更量；右侧 = 速度、会话 I/O、cache、额度，按**优先级**排序。
- **优先级**：**P0** = cwd/分支、变更量、输出速度、会话 I/O；**P1** = cache、额度。窄屏降级顺序是"先缩短目录 → 再拆成两行"，**P0/P1 永不整块消失**（右侧按优先级头保留）。
- **不重复**：metadata 行已显示 model/context 时，footer 不再重复。
- **未知值显示 `—`**，从不伪造为 0。
- 刷新节奏：**2 秒轮询**（`GIT_CHANGES_INTERVAL_MS`）+ agent/tool 活动触发的 **250ms 去抖**（`GIT_CHANGES_DEBOUNCE_MS`）。

## 统计口径（三个范围不混淆）

| 显示 | 口径 | 来源 |
| --- | --- | --- |
| `ctx …` | **当前上下文占用**（宿主实时接口） | `ctx.getContextUsage()` |
| `Σ` | **本 session 已记录的标准 usage 累计**（assistant 消息 + compaction / branch_summary；本插件自己的摘要 CustomEntry 不计回） | `src/usage-ledger.ts` |
| `cache(last)` | 活动分支**最近一条已确认请求**的命中率 `cacheRead / (input + cacheRead + cacheWrite)`；session 加权比率在 `/codex-ui` | 同上 |
| `↑` / `↓` | 沿用 Pi 归一化口径的 `usage.input` / `usage.output`（input **不含**缓存） | 同上 |
| `N tok/s` | **当前或最近一次 assistant 回复**的 `usage.output ÷ 观测输出窗口`（首个→末个流式 delta，**排除 TTFT**；无非流式 delta 时退回 `message_start`→`message_end`） | `src/output-speed.ts` |

`tok/s` 的隐藏条件：观测窗口 < 300ms、没有已确认的 output token、或速率越界时**整段不显示**（不是显示 0）。`/codex-ui` 会同时给出 token 数与窗口长度，并用 `scope` 区分流式中的实时值与 `message_end` 的确认值。

### `+A -D`：当前工作树相对 HEAD 的未提交改动

**是当前样本，不是累计量**；加过又删掉的按最终状态显示，不累计 churn。

- 每次读取重新采样：`git diff --numstat HEAD`（暂存 + 未暂存从工作树侧计一次，不重复叠加）加上未跟踪、未忽略的文本文件行数。
- 启动时已存在的 WIP **立即显示**；commit / 撤销后下一次读取数字随之下降，干净时归零；反复刷新同一状态不会累积。
- additions 与 deletions 分开显示绝对行数，绝不压成净变化；数字不做 k/M 缩写（`formatExactCount`）。
- rename 由 git 的 diff 判定（按新路径计入），删除按整文件行数计入。
- 未跟踪文件按 ≤200 个、单个 ≤256 KiB 流式计数（按 size+mtime 缓存，未变不重读；二进制跳过）；git 调用 5 秒超时 + `--no-ext-diff --no-textconv --no-optional-locks`；读取失败**保留上一次正确数字**而不是清零。
- 无 HEAD（尚未 commit，HEAD 仍是指向不存在分支的活跃 symbolic ref）时与空树比较，已 `git add` 的新文件按工作树内容计入；空树 OID 按 `git rev-parse --show-object-format` 查询，查询失败按读取失败处理，**不猜测** SHA-1/SHA-256。HEAD 查询超时、一般 git 错误或损坏的 ref 均保留上次数字，不会退回空树造成数字暴涨。
- 只读：不写用户的 index / 工作区 / 对象库，不创建临时目录，不触发 diff 驱动或 smudge 过滤器。

对账方法：`/codex-ui` 的 `git-changes` 行给出同口径总量、文件数、读取次数与基线（HEAD 或空树）；也可直接用 `git diff --numstat HEAD` 核对。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| Working 组件与相位 | `src/chrome/working.ts`（`INTERRUPT_HINT`、`SHIMMER_CELLS_PER_FRAME`、`createWorkingComponent`） |
| Header | `src/chrome/header.ts` 的 `createHeaderComponent` |
| Footer 布局与优先级 | `src/chrome/footer.ts`（左/右分组、`formatExactCount`） |
| 通用分段排版 | `src/segments.ts`（`Segment`、`formatCount`、`clipLine`、窄屏降级） |
| 快照装配 | `src/chrome/snapshots.ts` |
| 交互时钟 | `src/ui-metrics.ts` |
| usage 账本 | `src/usage-ledger.ts` |
| 输出速度 | `src/output-speed.ts` |
| 工作树改动量 | `src/git-changes.ts` |
| 安装/卸载 | `src/chrome/install.ts` |

## 不变量与已知限制

- footer 数字**只读**：不写 git 状态、不读额度凭据（见 [commands.md](../commands.md) §只读保证）。
- 三个 usage 范围（ctx / Σ / last）**永不混用**，`/codex-ui` 逐一标注来源。
- 未跟踪文件与 git 的 diff 不同：超过 200 个或单文件超过 256 KiB 的未跟踪文件、以及未跟踪的二进制文件不计入（跟踪文件的 diff 不设此上限）。
- 额度失败绝不影响 agent 交互与终止判定；失败只显示 `—` 或在有上次好值时继续用上次值。
- 窄屏只降级不整块消失；`footer.details: false` 会关掉右侧细节块（P0 的会话 I/O 与速度也在其中）。

## 验证

`test/unit/ui-metrics.test.mts`、`test/unit/usage-ledger.test.mts`、`test/unit/output-speed.test.mts`、`test/unit/git-changes.test.mts`、`test/chrome/working.test.mts`、`test/chrome/chrome.test.mjs`、`test/host/host-surface.test.mjs`、`scripts/pty-verify.mjs`（真实 TUI 的 Working 行/时序/摘要）。
