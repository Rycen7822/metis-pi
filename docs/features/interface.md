# 输入区、状态与全屏界面

配置键与默认值统一见 [配置参考](../configuration.md)，实际安装状态见 `/codex-ui`。

## 输入区

appearance 使用宿主 CustomEditor，提供灰色输入面与首行 `> `；正文列、编辑状态、鼠标/光标几何和提交内容保留。提示符及 `Ask anything...` 不进入 `getText()`。prefix 依赖 surface，Footer metadata 独立。

聚焦时使用终端竖线光标，保留输入法定位；缺硬件光标 API 时回退宿主反色光标，卸载恢复原设置。editor 已被其他插件占用或能力缺失时保留原编辑区。

composer 为 `￥` 和第二个及之后的 `/` 补发 skill 查询，见 [skills](skills.md)。

## 探索工具显示

`read` 与 npm `@ff-labs/pi-fff` 的 `ffgrep` / `fffind` 统一使用 `Exploring / Explored`：分别显示 `Read`、`Search`、`Find`，直接调用和 codemode 嵌套调用均支持。成功的 FFF 结果默认折叠，展开可查看全文，错误保持可见；直接连续调用可与 read 共用探索标题。仅接管这两个 FFF 名称，其他来源的同名工具、FFF 对原生 grep/find 的覆盖以及独立 renderer overlay 保留原样。

原生 bash 和 Metis exec_command 中的只读 `ast-grep run/scan`、`rg` 内容检索显示 `Search`，`fd` 显示 `Find`，`bat` / `batcat` 及其他已识别的文件读取命令显示 `Read`（复用现有解析，不另建工具）。ast-grep 改写/交互更新、fd `--exec` / `--exec-batch`、输出重定向或混合执行仍显示 `Ran`；展开保留原命令。bash 输出沿用现有 shell 预览，不修改调用、参数或模型结果。

## Working、Header 与摘要

Header 显示实际 Pi/metis 版本。Working 从 `agent_start` 到 `agent_settled`，包含最终回复后的 condense 维护，显示 Working / Writing / Waiting for input。安装 widget 成功后才隐藏宿主 loader；失败时回退 `setWorkingIndicator`。

时长每秒更新，shimmer 仅 truecolor 使用；settle、关闭与重载清理计时器。交互时长与各 thinking run 时长分别计算。

codemode 工具行运行时显示 `Elapsed`，结束后显示 `Took`，没有嵌套工具调用的脚本也显示。历史记录使用已保存的执行时长；嵌套工具显示自己的时长。

手动 `/compact`、自动阈值压缩及 overflow 恢复时，输入区顶部的原生压缩提示旁显示 `· 12s` / `· 1m 03s`。计时从原生提示出现开始，包含重试等待，不混用 Working 的整轮时长；结束、失败或取消后清除。通过 CustomEditor 的公开状态组件接口渲染，复用宿主 spinner 刷新，不增加事件 hook、prototype patch 或定时器；Esc 和压缩流程由宿主管理。窄窗口裁切显示，其他插件占用 editor 时保留原生界面。

| 最终原因 | 摘要 |
| --- | --- |
| `stop` / `error` / `aborted` | Worked / Failed / Interrupted。 |
| `length` / 其他或未知 | Ended · output limit / Ended。 |

单个工具失败不等于整轮失败。旧 v1 工具错误标记仅显示 `legacy status unverified`。摘要由 `summary.persist` 决定保存到 custom entry 或当前界面临时显示。

已发送的用户消息下方显示发送时间，完成摘要下方显示回复结束时间，格式为 `2026-10-03 02:20:09`（固定 UTC+8）。回复时间取最终消息结束时刻，不受后续 condense 维护耗时影响；旧摘要缺少此字段时使用本轮结束时间。恢复历史使用已保存时间；时间戳只用于界面，不加入模型消息。关闭摘要持久化时，回复时间随临时摘要显示在状态区。

## 统计口径

Footer 默认显示模型、推理等级、provider、上下文、累计 I/O、cache、速度与 Git `+A -D`；窄终端按完整字段换行。目录和分支默认折叠，点击主状态行末尾的 `▶` 展开到下方，点击 `▼` 收起。`+A -D` 不随目录隐藏。元数据不依赖 composer 安装，不读取 auth 或查询额度。

prune 行常驻开关、上下文变化与累计额外用量，普通排队/延期消息默认折叠；点击该行的三角独立展开最新详情，不影响目录/分支。展开状态在同一 Footer 内保留，新会话按 TOML 默认值初始化。普通队列和无操作提示不追加到 TUI 正文；实际 prune 操作、警告和错误仍显示。

默认展开状态由全局 `metis-pi.toml` 控制，修改后 `/reload` 或重启生效；点击三角只改变当前界面，不写回配置。regular 模式鼠标由终端管理时也可通过 TOML 选择默认展开：

```toml
[appearance.footer]
locationExpanded = false # 目录/分支
pruneExpanded = false    # prune 详情
```

| 字段 | 来源 |
| --- | --- |
| context | 实时 `getContextUsage()`。 |
| `Σ` I/O | 当前 session 文件的标准 assistant、compaction、branch summary 用量（包含其他分支已产生的用量）；工具自报的模型用量、condense 和摘要 custom entry 不混入。 |
| cache | 最近已确认请求的 `cacheRead / (input + cacheRead + cacheWrite)`；诊断同样报告最近已确认请求值。 |
| input | 不把 cacheRead 重复算为新输入。 |
| `gen(last) … tok/s` | 最近一次可测纯文字响应的生成阶段速率：`(usage.output − usage.reasoning − 1) / 首末非空内容事件间隔（秒）`。排除首输出前的等待/TTFT、隐藏推理和完成后的回调延迟；等待、生成和工具执行期间保留最近一次有效结果，`last` 明确其并非当前实时速度。 |

计速在 SDK 流实例将 `text_delta` 入队之前记录时间，用完成消息的对象身份配对最终用量，而不是用排队后的扩展回调时间，也不从无请求 ID 的原始增量猜测归属。缓存预热、嵌套调用及同 ID 的其他流有各自的弱引用计时状态，不会混入主响应。观察器仅在启用的 TUI session 安装，在关闭/重载时引用计数释放并恢复原方法；不修改 SDK 磁盘文件、不改动消息或持久化原文。使用标准 SDK 流的提供端均可被观测，自定义流实现无法观测时不显示新速度。\n\n只采样纯文字响应：`usage.output − usage.reasoning` 与文字窗口配对；工具调用及混合输出缺少可靠的分段 token 计数，暂不生成速度。没有 reasoning 子计数时，仅显式关闭推理且未观察到推理内容的响应可按零处理。至少需要两个不同时间的非空文字增量和大于一个的有效 token 数，并校验最终文字长度与流式增量完整对应。单块回复、未流式补齐文字、缺少有效计量、失败/取消及未完成 deferred 响应均不生成新速度，也不回退为含等待的旧公式。缺少新样本时保留已有 `gen(last)`，没有历史样本则不显示。完整计数的 token 上限截断响应仍可更新。新轮次和新交互保留旧样本；模型/推理等级、会话或上下文变化会清除。\n\n这是客户端观测的生成段估计，不是服务端纯解码基准：网络缓冲、分块合并、流读取调度仍会影响采样，尤其很短的输出；首个 chunk 可能含多个 token，`−1` 采用常见 TPOT 口径，并不假装获得逐 token 时间戳。不按字符数估 token，不用首个可见文字之后的时间除以包含隐藏推理的全部输出。当前不额外增加常驻 TTFT 字段。

实时累计 I/O、最近请求 cache 和本轮摘要只接收主 assistant 用量，与 session 重建保持同一角色范围；工具的活动/错误仍正常显示，历史已持久化摘要不重写。condense 的额外摘要用量单列，不能与上述统计互换。上下文归一化缓存按生命周期失效，不每帧扫描历史。

Git `+A -D` 合并比较工作树/index 相对 HEAD，再加未忽略的未跟踪文本；不是累计编辑次数或单一净值。未跟踪扫描最多 200 文件、每个 256 KiB，二进制跳过；已跟踪文件不受此扫描上限限制。

可见且启用的 Footer 每 2 秒采样并 250 ms 防抖，隐藏或关闭即停止。Git 查询 5 秒超时，不运行外部 diff/textconv、不写对象；失败保留上次值。只有确认 HEAD 未出生时才用对应哈希格式的空树。

## 全屏历史与留白

fullscreen 留白、历史窗口与置顶输入条共用一个布局根安装生命周期；关闭留白不关闭窗口或输入条，regular 模式不接管终端滚动。原始 session 记录保留。

### 置顶输入与跳转

- 顶部预留一行，避免输入条出现/消失时正文和输入区跳动；原 prompt 尚有部分可见时留空，完全滚出上方后显示 `↑` 和单行摘要。
- 摘要对应当前阅读位置最近的用户输入，翻阅旧轮次时不会错误显示最新输入；使用原组件实际显示的内容，保留 Markdown 转换/脱敏，按终端列宽裁切并沿用用户消息主题色。
- 左键点击输入条跳回那条原始 prompt；即使原位置已超出 5,000 行窗口也会按需加载。拖动、右键或带修饰键点击不跳转，滚轮仍滚动正文；跳转后不自动跟随新输出。
- 输入条独立于正文滚动和复制，不加入 session、模型上下文或正文选区。选区固定当前阅读上下文，释放后再更新；关闭/重载恢复原布局。

### 历史窗口

- 最多保留 5,000 显示行，包含 Earlier/Later 提示；到边缘继续滚动按需翻页，释放另一端派生缓存。
- 阅读旧历史时保留锚点，宿主顶部/底部跳转可跨页，搜索仅覆盖已加载窗口。
- 有选区时固定已提交窗口，提交输入解除；resize 无法安全重投影时按 [复制](selection-copy.md) 规则回退。
- 预算限制保留窗口；边界处单个超大组件仍可能完整 render 一次，再裁切并释放缓存。

## 字形

布局后为默认 `✔ ✖ ✓ ✗ ⚠` 补 U+FE0E，请求文字形态；已有 VS15/VS16 不改，SGR 和 OSC 载荷原样通过。选择子不进入 session 或复制文本，布局列映射不变。

`glyphs.include` 可追加字符；终端和字体决定实际效果，绕过帧写入路径的组件不受处理。

实现集中在 `src/chrome/`、`turn-summary.ts`、`git-changes.ts` 和 `glyph-presentation.ts`。
