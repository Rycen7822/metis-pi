# 输入区、状态与全屏界面

配置键与默认值统一见 [配置参考](../configuration.md)，实际安装状态见 `/codex-ui`。

## 输入区

appearance 使用宿主 CustomEditor，提供灰色输入面与首行 `> `；正文列、编辑状态、鼠标/光标几何和提交内容保留。提示符及 `Ask anything...` 不进入 `getText()`。prefix 依赖 surface，Footer metadata 独立。

聚焦时使用终端竖线光标，保留输入法定位；缺硬件光标 API 时回退宿主反色光标，卸载恢复原设置。editor 已被其他插件占用或能力缺失时保留原编辑区。

composer 为 `￥` 和第二个及之后的 `/` 补发 skill 查询，见 [skills](skills.md)。

## Working、Header 与摘要

Header 显示实际 Pi/metis 版本。Working 从 `agent_start` 到 `agent_settled`，包含最终回复后的 condense 维护，显示 Working / Writing / Waiting for input。安装 widget 成功后才隐藏宿主 loader；失败时回退 `setWorkingIndicator`。

时长每秒更新，shimmer 仅 truecolor 使用；settle、关闭与重载清理计时器。交互时长与各 thinking run 时长分别计算。

| 最终原因 | 摘要 |
| --- | --- |
| `stop` / `error` / `aborted` | Worked / Failed / Interrupted。 |
| `length` / 其他或未知 | Ended · output limit / Ended。 |

单个工具失败不等于整轮失败。旧 v1 工具错误标记仅显示 `legacy status unverified`。摘要由 `summary.persist` 决定保存到 custom entry 或当前界面临时显示。

## 统计口径

Footer 依次显示模型、推理等级、provider、cwd/分支/改动、上下文、累计 I/O、cache 与速度；窄终端按完整字段换行。元数据不依赖 composer 安装，不读取 auth 或查询额度。

| 字段 | 来源 |
| --- | --- |
| context | 实时 `getContextUsage()`。 |
| `Σ` I/O | 当前分支的标准 assistant、compaction、branch summary 用量；不重复计算摘要 custom entry。 |
| cache | 最近已确认请求的 `cacheRead / (input + cacheRead + cacheWrite)`；诊断另报 session 加权值。 |
| input | 不把 cacheRead 重复算为新输入。 |
| tok/s | 输出 token / 首尾 delta 时间，排除 TTFT；无 delta 时回退消息时间，窗口不足 300 ms 或无效则隐藏。 |

condense 的额外摘要用量单列，不能与上述统计互换。上下文归一化缓存按生命周期失效，不每帧扫描历史。

Git `+A -D` 合并比较工作树/index 相对 HEAD，再加未忽略的未跟踪文本；不是累计编辑次数或单一净值。未跟踪扫描最多 200 文件、每个 256 KiB，二进制跳过；已跟踪文件不受此扫描上限限制。

可见且启用的 Footer 每 2 秒采样并 250 ms 防抖，隐藏或关闭即停止。Git 查询 5 秒超时，不运行外部 diff/textconv、不写对象；失败保留上次值。只有确认 HEAD 未出生时才用对应哈希格式的空树。

## 全屏历史与留白

fullscreen 留白和历史窗口共用一个布局根拦截器；关闭留白不关闭窗口，regular 模式不安装窗口。原始 session 记录保留。

- 最多保留 5,000 显示行，包含 Earlier/Later 提示；到边缘继续滚动按需翻页，释放另一端派生缓存。
- 阅读旧历史时保留锚点，宿主顶部/底部跳转可跨页，搜索仅覆盖已加载窗口。
- 有选区时固定已提交窗口，提交输入解除；resize 无法安全重投影时按 [复制](selection-copy.md) 规则回退。
- 预算限制保留窗口；边界处单个超大组件仍可能完整 render 一次，再裁切并释放缓存。

## 字形

布局后为默认 `✔ ✖ ✓ ✗ ⚠` 补 U+FE0E，请求文字形态；已有 VS15/VS16 不改，SGR 和 OSC 载荷原样通过。选择子不进入 session 或复制文本，布局列映射不变。

`glyphs.include` 可追加字符；终端和字体决定实际效果，绕过帧写入路径的组件不受处理。

实现集中在 `src/chrome/`、`turn-summary.ts`、`git-changes.ts` 和 `glyph-presentation.ts`；运行覆盖见 [VALIDATION](../../VALIDATION.md)。
