# 输入区、状态与全屏界面

[配置参考](../configuration.md)列出键/默认值，`/codex-ui` 查看有效状态。

## 输入区

基于宿主 CustomEditor 的灰色输入面和 `> `，保留正文列、编辑/提交、光标和鼠标几何；提示符与 `Ask anything...` 属于装饰，`getText()` 只含正文。`composer.surface` 控制底色，`promptPrefix` 依赖 surface，`metadata` 控制 Footer 模型/provider/推理/上下文。

聚焦用终端竖线光标并保留输入法定位，缺硬件 API 时回退反色，卸载时恢复。宿主 editor 被外来代码接管或能力缺失时保持原生。`￥` 和后续 `/` 的 skill 查询见 [skills](skills.md)。

## 探索工具显示

`read`/本包 `neural_search` 用 Exploring/Explored；只读 `ast-grep run/scan`、`rg` 为 Search，`fd` 为 Find，识别的读取命令为 Read。改写、子命令执行、重定向或混合操作仍为 Ran；展开保留原命令/输出，见[转录显示](display.md#命令与探索)。

## Working、Header 与摘要

Header 显示实际 Pi/Metis 版本；Working 从 `agent_start` 到 `agent_settled`（含回复后 condense 维护），显示 Working/Writing/Waiting for input。widget 安装成功才隐藏原 loader，失败时改用 `setWorkingIndicator`。

- 时长用单调时钟；共享刷新对齐活动 thinking run 的秒界，无 run 时对齐整轮。主线程/终端停顿后直接显示当前值。thinking run 与整轮分别计时。
- shimmer 仅真彩，`working.elapsed/thought/tool/tokens` 控制各段，动画开关/32–1000ms 间隔归 `animation/animationIntervalMs`。settle/关闭/重载清 timer。
- 展开流式思考的灰色 `thinking 12s` 复用活动时钟，占位独立于 peek 正文预算，随复制一起排除，完成后移除；折叠摘要仍是 `Thought for …`。
- 纯 thinking 流仅在实际 peek 且 ≥16 Ki 字符时按 100ms 合并更新，静止时刷最后一批；Markdown 使用完整原生排版。点击/滚动/视图、文字/工具和完成立即处理，卸载时取消待刷新。
- codemode 运行显示 Elapsed、完成 Took，无子调用也显示；历史/嵌套各用自己的保存时长。自有参数/结果/账本引用共用估算 4 MiB UI 缓存，淘汰较早已完成项，保运行中参数与顺序，超大项走完整渲染；历史失效释放派生组件。外来 renderer 自管，缺参数/diff/输出时如实说明。
- 原生手动/自动/overflow 压缩提示旁加 `· 12s` / `· 1m 03s`，从提示出现计（含重试），结束/失败/取消清除。用 CustomEditor 公开状态组件和原 spinner；Esc/压缩仍归宿主，窄屏裁切、外来 editor 回退原生。

| 终态 | 摘要 |
| --- | --- |
| `stop` / `error` / `aborted` | Worked / Failed / Interrupted。 |
| `length` / 其他或未知 | Ended · output limit / Ended。 |

单工具失败只标记该工具，整轮结果以终态为准。`summary.persist` 选择持久或临时摘要。用户消息下显示发送时间，摘要下显示回复结束时间，固定 UTC+8（如 `2026-10-03 02:20:09`）；回复时间截至结算点，缺失时回退结算，历史用保存值。时间戳只出现在界面。

## 统计口径

Footer 显示模型/推理/provider/上下文、I/O、cache、速度、Git `+A -D`，按完整字段换行；`footer.enabled/details/showCache/showChanges/showSpeed` 控制各段，元数据独立于 composer，凭据和额度留在 Pi。

目录/分支与 prune 排队详情分别用三角独立展开；`+A -D`、prune 开关/上下文变化/累计用量常驻。点击只改当前 UI，TOML 保持原样；新 Footer 的默认展开状态来自 `appearance.footer.locationExpanded/pruneExpanded`（均 false，regular 同样适用，改后重载）。普通无操作/排队提示保持单行，实际操作/警告/错误带正文。

| 字段 | 来源 |
| --- | --- |
| context | `getContextUsage()` 持久化分支投影；流式复用有效样本，分支/模型/完成边界刷新。 |
| `Σ` I/O | 当前 session 所有分支的标准 assistant、compaction、branch summary；工具自报、condense、摘要 custom entry 属于独立口径。input 已含 cacheRead 时按原值计。 |
| cache | 最近确认请求的 `cacheRead / (input + cacheRead + cacheWrite)`，诊断同口径。 |
| `gen≈(live)` · `tok/s` | 流式文本/工具参数的计时 UTF-16 长度 ÷ 4 ÷ 观测秒数；4 是 UI 近似。 |
| `gen≈(last/avg2/avg3)` · `tok/s` | 每批 assistant 完成（含 toolUse）以可靠 `output-reasoning` 按计时字符份额校准；工具批单报，短正文取至多三窗。 |
| `gen≈(est)` · `tok/s` | 推理明细缺失时沿用字符÷4估算，估算来源限于已观测文本。 |

生成速率取 SDK producer 的 `text_delta/toolcall_delta` 单调时钟，排除排队 UI 时间。各段首批字符/时间同时排除，思考/段切换拆窗，同批同步/微任务保持同窗。计时须 ≥100ms 且覆盖至少一半输出；单批、短尾、终态补发才报数。工具 JSON 只计原始 delta 长度，以 `toolcall_end` 封口；混合输出需各块完整，reasoning=0 时按 est 口径。

新输出先隐藏旧值，足量观测后显示 live，完成立即校准；工具执行/返回值和无新输出的失败保持上一批次。工具批与正文分开平滑，正文 ≤64 tokens 时用至多三窗的 `Σ估算 tokens / Σ秒数`；provider/实际模型/推理级别分别记账，会话/模型/上下文变化后清空重来。这是受网络/字符密度影响的客户端估算，UI 只用字符计数，token 统计以 provider 用量为准。

诊断另报 `out(last)` = SDK 总输出（含推理）÷完整 `durationMs`：含首字等待/思考/传输，请求前压缩、工具执行、UI 延迟单独排除；无可靠正文速率时仍有这个口径。原始用量/历史/摘要保持原样，I/O/cache/本轮摘要只收主 assistant；condense 额外用量单列，旧摘要保持不变，上下文缓存按生命周期失效。

Git 比较工作树/index 相对 HEAD，加上未忽略的未跟踪文本，输出 `+A -D` 两个数。未跟踪最多 200 文件×256 KiB，二进制跳过，已跟踪文件无此上限。可见启用时每 2s 采样、250ms 防抖，隐藏时停止；5s 超时，diff 使用内置逻辑，对象库保持只读，失败沿用旧值。确认 unborn HEAD 后才使用对应哈希格式的空树。

## 全屏历史与留白

fullscreen 留白/历史/置顶输入共用布局生命周期；留白开关只控制留白，regular 保持终端原生滚动。`marginX` 0–8（0 为关闭）、`minWidth` 40–400；原 session 完整保留。

### 置顶输入与跳转

预留顶部一行：prompt 部分可见时留空，完全滚出上方后显示最近阅读位置对应的 `↑` 单行摘要，位置跟随当前阅读处；显示/脱敏/Markdown 转换与主题色取自原组件，按列宽裁切。

左键跳回原 prompt（超窗按需加载），跳转后停留在阅读位置；拖选、右键、修饰键交给选区，滚轮照常。输入条独立于 session/模型/正文选区，选区固定阅读上下文，释放再更新，关闭恢复布局。

### 历史窗口

- 最多 5,000 显示行（含 Earlier/Later），边缘继续滚动翻页并释放另一端派生缓存，保阅读锚点；顶部/底部键可跨页，搜索覆盖已加载窗口。
- 滚动条拖到底跳真实历史末尾并跟新输出，普通定位/提示留在当前页。零边距/留白均安装；`history-window.scrollbarFollow` 报告桥接，桥接缺失时保留滚轮分页和显式跳顶/底。
- 活动秒钟仅使缓存内流式块过期以更新思考标题，完成历史复用缓存。有选区固定已提交窗口并保留待刷新状态，解除后第一帧追上当前时钟；提交输入解除选区；resize 无法重投影时按[复制](selection-copy.md)回退。
- 预算限制的是显示行数，内存占用随内容而定；超大组件可能完整 render 一次后裁切/释放。

## 字形

布局后为 `✔ ✖ ✓ ✗ ⚠` 补 U+FE0E，请求文字形态；已有 VS15/VS16、SGR/OSC 载荷原样保留，session、复制、列映射保持原逻辑。`glyphs.textPresentation` 关闭后由 `include` 追加字符；最终效果由字体/终端决定，帧 writer 之外的输出保持原样。

writer 激活时持有、关闭时释放，后装包装保持独立；接管有风险时报告并保持现状，重启后重新尝试。界面实现归 `src/appearance/chrome/`，摘要/用量归 `activity/`，Git/装配归 appearance，公共组件归 `src/presentation/`。
