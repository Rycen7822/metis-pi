# 输入区、状态与全屏界面

[配置参考](../configuration.md)列出了各个按键与默认值。`/codex-ui` 显示有效状态。

## 输入区

输入区基于宿主的 CustomEditor，带灰色底面和 `> ` 提示符。它保留正文列、编辑与提交、光标和鼠标的几何关系。提示符与 `Ask anything...` 只是装饰，`getText()` 只返回正文。`composer.surface` 控制底色。`promptPrefix` 依赖 surface。`metadata` 控制 Footer 的模型、provider、推理与上下文信息。

聚焦时使用终端竖线光标，并保留输入法的定位。缺少硬件光标 API 时，回退为反色显示。卸载时恢复原状。宿主的 editor 被外部代码接管，或能力缺失时，保持原生行为。`￥` 与其后的 `/` 查询 skill 的方式，见 [skills](skills.md)。

## 探索工具显示

`read` 与本包的 `neural_search` 显示为 Exploring 和 Explored。只读的 `ast-grep run`、`ast-grep scan` 与 `rg` 显示为 Search。`fd` 显示为 Find。被识别的读取命令显示为 Read。改写、子命令执行、重定向或混合操作仍显示为 Ran。展开后保留原始命令与输出，见[转录显示](display.md#命令与探索)。

## Working、Header 与摘要

Header 显示实际的 Pi 与 Metis 版本。Working 从 `agent_start` 持续到 `agent_settled`，其间包括回复后的 condense 维护，显示为 Working、Writing 或 Waiting for input。只有 widget 安装成功，才会隐藏原始的 loader。失败时改用 `setWorkingIndicator`。

- 时长使用单调时钟计算。共享刷新对齐活动 thinking run 的秒界。没有 run 时，对齐整轮。主线程或终端停顿后，直接显示当前值。thinking run 与整轮分别计时。
- shimmer 仅在真彩色下生效。`working.elapsed`、`thought`、`tool`、`tokens` 控制各段显示。动画开关与 32 至 1000 ms 的间隔由 `animation`、`animationIntervalMs` 控制。settle、关闭和重载时清除 timer。
- 展开的流式思考显示灰色的 `thinking 12s`。它复用活动时钟，占位与 peek 正文的预算相互独立，复制时一并排除。完成后移除。折叠摘要仍显示 `Thought for …`。
- 只有纯 thinking 流并且实际在 peek 中、且超过 16 Ki 字符时，才按 100 ms 合并更新。静止时刷新最后一批。Markdown 使用完整的原生排版。点击、滚动、视图切换、文字或工具输出、完成事件都立即处理。卸载时取消待刷新的任务。
- codemode 运行时显示 Elapsed，完成后显示 Took。无子调用时也显示。历史与嵌套各自使用保存的时长。自有的参数、结果与账本引用共用 4 MiB 的估算 UI 缓存。淘汰较早的已完成项，保留运行中的参数与顺序。超大项走完整渲染。历史失效时释放派生组件。外部 renderer 自行管理。缺少参数、diff 或输出时如实说明。
- 原生的手动、自动与 overflow 压缩提示旁会显示 `· 12s` 或 `· 1m 03s`。计时从提示出现开始（包括重试），结束、失败或取消时清除。它使用 CustomEditor 公开的状态组件与原生 spinner。Esc 与压缩仍归宿主。窄屏下裁切。外部 editor 时回退原生。

| 终态 | 摘要 |
| --- | --- |
| `stop`、`error`、`aborted` | Worked、Failed、Interrupted。 |
| `length`、其他或未知 | Ended · output limit、Ended。 |

单个工具失败只标记该工具。整轮结果以终态为准。`summary.persist` 选择持久或临时的摘要。用户消息下显示发送时间。摘要下显示回复结束的时间。时区固定为 UTC+8，例如 `2026-10-03 02:20:09`。回复时间截至结算点。缺失时回退到结算时间。历史记录使用保存的值。时间戳只出现在界面中。

## 统计口径

Footer 显示模型、推理、provider、上下文、I/O、cache、速度，以及 Git 的 `+A -D`。按完整字段换行。`footer.enabled`、`details`、`showCache`、`showChanges`、`showSpeed` 分别控制各段。元数据独立于 composer。凭据与额度信息不在 footer 中显示。

目录或分支、prune 排队详情分别用三角符号独立展开。`+A -D`、prune 开关、上下文变化与累计用量常驻显示。点击只改变当前界面，不修改 TOML。新 Footer 的默认展开状态来自 `appearance.footer.locationExpanded` 与 `pruneExpanded`，两者默认均为 false。regular 模式同样适用。修改后需重载。普通的无操作或排队提示保持单行。实际操作、警告与错误则带正文。

| 字段 | 来源 |
| --- | --- |
| context | `getContextUsage()` 的持久分支投影。流式输出时复用有效样本。分支、模型或完成边界时刷新。 |
| `Σ` I/O | 当前 session 所有分支中，标准 assistant、compaction 与 branch summary 的总和。工具自报、condense 与摘要 custom entry 属于独立口径。input 已包含 cacheRead 时，按原值计。 |
| cache | 最近一次确认请求的 `cacheRead / (input + cacheRead + cacheWrite)`。诊断使用同一口径。 |
| `gen≈(live)`、`tok/s` | 流式文本或工具参数的计时 UTF-16 长度，除以 4，再除以观测秒数。4 是 UI 的近似值。 |
| `gen≈(last/avg2/avg3)`、`tok/s` | 每批 assistant 完成（包括 toolUse）后，以可靠的 `output-reasoning` 按计时字符份额校准。工具批单独报告。短正文取至多三个窗口。 |
| `gen≈(est)`、`tok/s` | 推理明细缺失时，沿用字符数除以 4 的估算。估算来源限于已观测的文本。 |

生成速率取自 SDK producer 的 `text_delta` 与 `toolcall_delta` 单调时钟，排除排队的界面时间。每段的首批字符与时间同时排除。思考或段切换时，拆分窗口。同一批的同步与微任务保持在同一窗口。计时须不少于 100 ms，并覆盖至少一半的输出。单批、短尾、终态补发时才报告数值。工具的 JSON 只计原始 delta 长度，以 `toolcall_end` 封口。混合输出需要每个块都完整。reasoning 为 0 时，按估算口径计算。

新的输出到来时，先隐藏旧值。观测足够之后显示 live 值。完成时立即校准。工具执行、返回值，以及没有新输出的失败，保持上一批次的值。工具批与正文分别平滑。正文不超过 64 个 token 时，使用至多三个窗口的 `Σ估算 tokens / Σ秒数`。provider、实际模型与推理级别分别记账。会话、模型或上下文变化后清空重来。这是受网络与字符密度影响的客户端估算。界面只用字符计数。token 统计以 provider 的用量为准。

诊断另报 `out(last)`，即 SDK 的总输出（含推理）除以完整的 `durationMs`。它包括首字等待、思考、传输。请求前的压缩、工具执行和界面延迟单独排除。没有可靠的正文速率时，仍可以看到这个口径。原始用量、历史和摘要保持原样。I/O、cache 与本轮摘要只统计主 assistant。condense 的额外用量单列。旧摘要保持不变。上下文缓存按生命周期失效。

Git 将工作树和 index 与 HEAD 比较，再加上未被忽略的未跟踪文本文件，输出 `+A -D` 两个数。未跟踪文件最多 200 个，每个最多 256 KiB。二进制文件跳过。已跟踪文件没有此上限。界面可见时，每 2 秒采样一次。工具完成和任务结束时，触发 250 ms 的防抖刷新。Working 的时钟只更新显示。Git 在专属的 worker 中执行。隐藏时停止采样，并退出 worker。超时为 5 秒。diff 使用内置逻辑。对象库保持只读。失败时沿用旧值。只有确认 HEAD 未出生（unborn）时，才使用对应哈希格式的空树。

## 全屏历史与留白

fullscreen 的留白、历史窗口与置顶输入共用一个布局生命周期。留白开关只控制留白。regular 模式保持终端原生滚动。`marginX` 的范围为 0 至 8，0 表示关闭。`minWidth` 的范围为 40 至 400。原有的 session 完整保留。

### 置顶输入与跳转

顶部预留一行。prompt 部分可见时，这一行留空。完全滚出上方后，显示与最近阅读位置对应的 `↑` 单行摘要。位置随当前阅读处更新。显示、脱敏、Markdown 转换与主题色取自原组件，并按列宽裁切。

左键点击跳回原 prompt（超出窗口时按需加载）。跳转后停留在阅读位置。拖选、右键和修饰键交给选区处理。滚轮照常工作。输入条独立于 session、模型与正文选区。选区固定阅读上下文。释放后再更新。关闭时恢复布局。

### 历史窗口

- 最多 5,000 个显示行（包含 Earlier 与 Later）。边缘继续滚动时翻页，并释放另一端的派生缓存，保留阅读锚点。顶部与底部键可以跨页。搜索覆盖已加载的窗口。
- 滚动条拖到底部会跳到真实历史的末尾，并跟随新输出。普通定位与提示则留在当前页。零边距与留白都会安装。`history-window.scrollbarFollow` 报告桥接情况。桥接缺失时，保留滚轮分页，以及显式的跳到顶部与底部。
- 活动秒钟只让缓存中的流式块失效，以更新思考标题。完成的历史复用缓存。有选区时，固定已提交的窗口，并保留待刷新的状态。选区解除后，第一帧追上当前时钟。提交输入会解除选区。resize 无法重新投影时，按[复制](selection-copy.md)回退。
- 预算限制的是显示行数，而内存占用取决于内容。超大组件可能被完整渲染一次，再裁切释放。

## 字形

布局之后，为 `✔ ✖ ✓ ✗ ⚠` 补充 U+FE0E，请求文字形态。已有的 VS15 或 VS16、SGR 与 OSC 载荷原样保留。session、复制与列映射保持原来的逻辑。`glyphs.textPresentation` 关闭后，由 `include` 追加字符。最终效果由字体与终端决定。帧 writer 之外的输出保持原样。

writer 激活时持有，关闭时释放。后装的包装保持独立。接管有风险时，报告并保持现状，重启后重新尝试。界面实现位于 `src/appearance/chrome/`。摘要与用量位于 `activity/`。Git 与装配位于 appearance。公共组件位于 `src/presentation/`。
