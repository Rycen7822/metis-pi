# 输入区、状态与全屏界面

配置键与默认值统一见 [配置参考](../configuration.md)，实际生效状态见 `/codex-ui`。

## 输入区

appearance 使用宿主 CustomEditor，提供灰色输入面与首行 `> `；正文列、编辑状态、鼠标/光标几何和提交内容保留。提示符及 `Ask anything...` 不进入 `getText()`。`composer.surface` 控制输入面，`composer.promptPrefix` 依赖 surface，`composer.metadata` 控制 Footer 的模型/provider/推理/上下文字段。

聚焦时使用终端竖线光标，保留输入法定位；缺硬件光标 API 时回退宿主反色光标，卸载恢复原设置。editor 已被其他插件占用或能力缺失时保留原编辑区。

composer 为 `￥` 和第二个及之后的 `/` 补发 skill 查询，见 [skills](skills.md)。

## 探索工具显示

`read` 与本包 `neural_search` 使用 Exploring / Explored，规则见[转录显示](display.md#命令与探索)。只读 `ast-grep run/scan`、`rg` 命令显示 Search，`fd` 显示 Find，已识别读取命令显示 Read；改写、执行子命令、重定向或混合操作仍显示 Ran。展开保留原命令和输出。

## Working、Header 与摘要

Header 显示实际 Pi/metis 版本。Working 从 `agent_start` 到 `agent_settled`，包含最终回复后的 condense 维护，显示 Working / Writing / Waiting for input。安装 widget 成功后才隐藏宿主 loader；失败时回退 `setWorkingIndicator`。

时长每秒更新，shimmer 仅 truecolor 使用；settle、关闭与重载清理计时器。交互时长与各 thinking run 时长分别计算。`working.elapsed/thought/tool/tokens` 分别控制时长、思考、工具和 token 段，`working.animation` 与 `working.animationIntervalMs` 控制动画（帧间隔 32–1000 ms）。

长思考的纯 thinking 流在实际处于 peek 视图且达到 16 Ki 字符后，按 100 ms 合并预览更新；暂停输入时仍会刷新最后一批。保留完整宿主 Markdown 排版，不截断源码来拼尾部。点击、滚动、切换视图、普通文字/工具调用与最终完成立即处理；卸载取消待刷新的预览。

codemode 工具行运行时显示 `Elapsed`，结束后显示 `Took`，没有嵌套工具调用的脚本也显示。历史记录使用已保存的执行时长；嵌套工具显示自己的时长。

嵌套工具在已有 renderer 支持范围内复用直接调用样式；实时工具行也读取会话保存的完整参数，不把截断摘要当作完整命令。临时参数、结果和会话参数账本引用共用估算体积 4 MiB 的 UI 缓存预算（不是整个进程的内存上限），空间不足时为新数据淘汰较早已完成的条目，保留运行中参数和原调用顺序；超大单项仍不缓存。Metis 自有的嵌套结果组件随历史窗口失效释放，重新显示时只从仍保留的数据重建；不接管第三方 renderer 的缓存生命周期。命令参数或 diff/输出确实未保留时，会说明缺失原因，不从当前文件或脚本猜测历史改动。

手动 `/compact`、自动阈值压缩及 overflow 恢复时，输入区顶部的原生压缩提示旁显示 `· 12s` / `· 1m 03s`。计时从原生提示出现开始，包含重试等待，不混用 Working 的整轮时长；结束、失败或取消后清除。通过 CustomEditor 的公开状态组件接口渲染，复用宿主 spinner 刷新，不增加事件 hook、prototype patch 或定时器；Esc 和压缩流程由宿主管理。窄窗口裁切显示，其他插件占用 editor 时保留原生界面。

| 最终原因 | 摘要 |
| --- | --- |
| `stop` / `error` / `aborted` | Worked / Failed / Interrupted。 |
| `length` / 其他或未知 | Ended · output limit / Ended。 |

单个工具失败不等于整轮失败，历史证据不足时不推断成功。`summary.persist` 决定摘要持久保存或仅临时显示。

已发送的用户消息下方显示发送时间，完成摘要下方显示回复结束时间，格式为 `2026-10-03 02:20:09`（固定 UTC+8）。回复时间取最终消息结束时刻，不受后续 condense 维护耗时影响；记录缺少结束时刻时使用本轮结算时间。恢复历史使用已保存时间；时间戳只用于界面，不加入模型消息。关闭摘要持久化时，回复时间随临时摘要显示在状态区。

## 统计口径

Footer 默认显示模型、推理等级、provider、上下文、累计 I/O、cache、速度与 Git `+A -D`；窄终端按完整字段换行。`footer.enabled`、`details`、`showCache`、`showChanges`、`showSpeed` 分别控制整块与各段。目录和分支默认折叠，点击主状态行末尾的 `▶` 展开到下方，点击 `▼` 收起。`+A -D` 不随目录隐藏。元数据不依赖 composer 安装，不读取 auth 或查询额度。

prune 行常驻开关、上下文变化与累计额外用量，普通排队/延期消息默认折叠；点击该行的三角独立展开最新详情，不影响目录/分支。展开状态在同一 Footer 内保留，新会话按 TOML 默认值初始化。普通队列和无操作提示不追加到 TUI 正文；实际 prune 操作、警告和错误仍显示。

默认展开状态由全局 `metis-pi.toml` 控制，修改后 `/reload` 或重启生效；点击三角只改变当前界面，不写回配置。regular 模式鼠标由终端管理时，也用这两个字段选择默认状态：

```toml
[appearance.footer]
locationExpanded = false # 目录/分支
pruneExpanded = false    # prune 详情
```

| 字段 | 来源 |
| --- | --- |
| context | `getContextUsage()` 的已持久化分支用量；流式片段复用有效样本，分支、模型或消息完成等边界刷新。 |
| `Σ` I/O | 当前 session 文件的标准 assistant、compaction、branch summary 用量（包含其他分支已产生的用量）；工具自报的模型用量、condense 和摘要 custom entry 不混入。 |
| cache | 最近已确认请求的 `cacheRead / (input + cacheRead + cacheWrite)`；诊断同样报告最近已确认请求值。 |
| input | 不把 cacheRead 重复算为新输入。 |
| `gen(last)` / `gen(avg2)` / `gen(avg3)` · `tok/s` | 每次可测**模型响应**完成即刷新，文字、工具调用和混合响应均可更新，不等整个任务结束。较长输出显示本次生成速率；短输出结合当前和前两条有效响应加权平滑，`avg2/avg3` 明确表示用了历史窗口，不是本次原始值，也不是逐 token 实时估算。 |

context 样本来自 `getContextUsage()` 读取的已持久化会话投影，不是正在流式生成的消息，因此不是实时输出 token 计数。

生成速度按每次可测主模型响应更新，文字和工具调用都计入，不等待工具执行或整轮结束。计算使用 SDK 流交付前的首末产物时间与 provider 最终用量，排除工具运行、工具返回、缓存预热和其他模型流。

- 非推理输出不超过 64 tokens 时，结合当前及前两条有效响应平滑：`Σ(各次输出 tokens − 1) / Σ(各次生成间隔秒数)`，不是速率的算术平均。较长输出显示本次值，最多保存三条原始数值。
- 至少两次非空增量、正时间窗口、完整内容覆盖及可靠非推理用量才产生样本。参数增量需能与最终 arguments 对应；reasoning 未报告时，仅显式关闭推理且无推理块才按零处理。单块、同 tick、无法确定非推理用量或未完成响应不猜 token 数。
- 错误、取消和不可测响应保留上次有效值，不挤占样本。provider、模型、推理等级、会话或上下文变化会清空；模型身份不可靠时仅显示单次值，不校准历史。重启后等待新样本。

这是客户端生成段速率，不是服务端解码基准。首 chunk 可含多个 token，网络缓冲和分块影响短样本；平滑只能减小抖动。临时参数在响应结束后释放，不持久化正文。

实时累计 I/O、最近请求 cache 和本轮摘要只接收主 assistant 用量，与 session 重建保持同一角色范围；工具的活动/错误仍正常显示，历史已持久化摘要不重写。condense 的额外摘要用量单列，不能与上述统计互换。上下文归一化缓存按生命周期失效，不每帧扫描历史。

Git `+A -D` 合并比较工作树/index 相对 HEAD，再加未忽略的未跟踪文本；不是累计编辑次数或单一净值。未跟踪扫描最多 200 文件、每个 256 KiB，二进制跳过；已跟踪文件不受此扫描上限限制。

可见且启用的 Footer 每 2 秒采样并 250 ms 防抖，隐藏或关闭即停止。Git 查询 5 秒超时，不运行外部 diff/textconv、不写对象；失败保留上次值。只有确认 HEAD 未出生时才用对应哈希格式的空树。

## 全屏历史与留白

fullscreen 留白、历史窗口与置顶输入条共用一个布局根安装生命周期；关闭留白不关闭窗口或输入条，regular 模式不接管终端滚动。`fullscreen.marginX`（0–8，0 关闭留白）与 `fullscreen.minWidth`（40–400）控制左右留白。原始 session 记录保留。

### 置顶输入与跳转

- 顶部预留一行，避免输入条出现/消失时正文和输入区跳动；原 prompt 尚有部分可见时留空，完全滚出上方后显示 `↑` 和单行摘要。
- 摘要对应当前阅读位置最近的用户输入，翻阅旧轮次时不会错误显示最新输入；使用原组件实际显示的内容，保留 Markdown 转换/脱敏，按终端列宽裁切并沿用用户消息主题色。
- 左键点击输入条跳回那条原始 prompt；即使原位置已超出 5,000 行窗口也会按需加载。拖动、右键或带修饰键点击不跳转，滚轮仍滚动正文；跳转后不自动跟随新输出。
- 输入条独立于正文滚动和复制，不加入 session、模型上下文或正文选区。选区固定当前阅读上下文，释放后再更新；关闭/重载恢复原布局。

### 历史窗口

- 最多保留 5,000 显示行，包含 Earlier/Later 提示；到边缘继续滚动按需翻页，释放另一端派生缓存。
- 阅读旧历史时保留锚点，滚轮在边缘继续逐页加载；宿主顶部/底部跳转可跨页。拖动滚动条到底会回到真实历史末尾并跟随新输出，不停在已加载片段的末尾；普通定位和提示导航不会触发这一跨页跳转。零边距与留白模式都在真实 renderer 上安装；`history-window.scrollbarFollow` 诊断报告桥接是否成功及原因。无法安全桥接宿主滚动条入口时仅停用该增强，仍保留滚轮分页和显式顶部/底部跳转。搜索仅覆盖已加载窗口。
- 有选区时固定已提交窗口，提交输入解除；resize 无法安全重投影时按 [复制](selection-copy.md) 规则回退。
- 预算限制保留窗口；边界处单个超大组件仍可能完整 render 一次，再裁切并释放缓存。

## 字形

布局后为默认 `✔ ✖ ✓ ✗ ⚠` 补 U+FE0E，请求文字形态；已有 VS15/VS16 不改，SGR 和 OSC 载荷原样通过。选择子不进入 session 或复制文本，布局列映射不变。`glyphs.textPresentation` 关闭这套处理，`glyphs.include` 额外追加字符；终端和字体决定实际效果，绕过帧写入路径的组件不受处理。

主界面实现集中在 `src/appearance/chrome/`，交互摘要与用量 owner 位于 `src/appearance/activity/`；Git 统计和会话装配由 appearance 管理，共用呈现组件位于 `src/presentation/`。

字形 writer 随激活持有、会话关闭释放，不覆盖后装包装。无法安全替换时保留现状并报告，重启 Pi 后再接管。
