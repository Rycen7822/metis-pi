# Working 行、Header 与 Footer

Working 显示本次交互进度，Header 显示运行版本，Footer 显示会话及工作区状态。配置键集中在 [配置](../configuration.md)，诊断字段见 [`/codex-ui`](diagnostics.md)。

## Working 与回合摘要

交互从 `agent_start` 开始，到 `agent_settled` 结束；最终回复后的 condense 维护也包含在内。阶段为 `Working`、`Writing`、`Waiting for input`。

- 安装 Working widget 成功后才隐藏宿主 loader，失败时退回 `setWorkingIndicator`，避免出现两行或完全丢失进度。
- 时长每秒刷新；启用动画时默认 32 ms 一帧。可见 shimmer 只用于 truecolor，低色彩模式使用静态样式。
- settle、关闭和重载清理旧计时器。交互总时长与每个 thinking 段的可测时长分别计算，见 [Thinking](thinking.md)。

回合摘要按最终停止原因显示：

| 原因 | 摘要 |
| --- | --- |
| `stop` | `Worked` |
| `error` | `Failed` |
| `aborted` | `Interrupted` |
| `length` | `Ended · output limit` |
| 其它或未知 | `Ended` |

单个工具失败不必然表示整个交互失败。旧 v1 的失败标记可能仅来自工具错误，显示 `legacy status unverified`，不倒推整个交互失败。`summary.persist: true` 将摘要保存为 session custom entry；关闭持久化时只在当前界面临时显示。

## Header 与 Footer 布局

Header 使用实际运行的 Pi 和 metis-pi 版本。Footer 依次显示模型、推理等级、provider、cwd/分支/改动、上下文、累计 I/O、缓存和速度；窄终端按完整字段换行，不随意丢弃统计。

Footer 元数据独立于编辑器，使用其它编辑器时仍可显示。不读取 auth 内容，不在右侧渲染 quota；转换层已有的左侧状态仍可显示。

Git 刷新默认每 2 秒一次并作 250 ms 防抖，只在已安装且可见的 Footer、启用改动显示并有 cwd 时运行。隐藏或 shutdown 后停止。上下文归一化结果按生命周期失效缓存，避免每帧遍历历史。

## 统计口径

| 字段 | 来源与计算 |
| --- | --- |
| context | 实时 `getContextUsage()`，表示当前上下文占用 |
| `Σ` I/O | 当前 session 分支的标准 assistant、compaction 和 branch summary 用量；不把本插件的摘要 custom entry 再计一次 |
| cache | 最近一次已确认请求的 `cacheRead / (input + cacheRead + cacheWrite)`；`/codex-ui` 另报 session 加权值 |
| input | 不把缓存读取重复算为新输入 |
| tok/s | 输出 token 除以首个至最后一个输出 delta 的时间，排除 TTFT；缺少 delta 时回退消息时间。窗口不足 300 ms、未知或无效时隐藏 |

这些字段分别描述当前上下文、累计用量和最近请求，不能互相替代；condense 额外摘要用量单列，见 [历史压缩](condense.md)。

## Git `+A -D`

显示当前工作树相对 HEAD 的未提交改动：已暂存与未暂存内容合并比较一次，加上未被忽略的未跟踪文本文件。它不是历次编辑量，也不是新增减删除后的单一净值。

- 未跟踪文件最多扫描 200 个，每个最多 256 KiB，按文件大小和修改时间缓存；二进制跳过。已跟踪文件不使用这个扫描上限，重命名交给 Git 处理。
- Git 查询超时为 5 秒，关闭外部 diff、textconv 和可选锁。失败时保留上次可用值，不凭空归零。
- 无初始提交时，只有确认 symbolic HEAD 未出生才回退空树；按仓库实际哈希格式查询，不猜测固定 SHA。查询不写 Git 对象或临时文件。

实现集中在 `src/chrome/`与 `src/turn-summary.ts`；显示与持久化所有权见 [架构](../architecture.md)，实测证据见 [VALIDATION](../../VALIDATION.md)。
