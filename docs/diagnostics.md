# 诊断

在出现问题的会话中执行 `/codex-ui`。报告只描述当前 Pi 进程，包含版本、终端模式、有效配置和各显示组件的状态。

| 现象 | 检查与处理 |
| --- | --- |
| 配置未生效 | 先用 `/metis-config` 核对文件路径，再按[配置参考](configuration.md)重载或重启。 |
| 工具显示与预期不同 | 查看 `transcript` 和 `chrome`。第三方渲染器保持其原有实现。 |
| 全屏看不到最新输出 | 查看 `history-window`。出现 `Later history` 时，向下翻页或[跳到最新](features/interface.md#全屏历史与留白)。 |
| 复制带有软换行 | 查看 `selection-copy` 和 `copy-stats`；`native-fallback` 表示使用了 Pi 原生提取。 |
| 用量或速度不符合预期 | 先比对 [统计口径](features/interface.md#统计口径)。计费以提供商账单为准。 |
| 缓存命中突然下降 | 用 [请求前缀诊断](#请求前缀诊断) 对照复现前后的请求。 |
| 模型、指令或整理状态有误 | 用 `/model` 核对当前模型；用 `/dynamic-agents` 或 `/pruner status` 查看策略。 |
| Codemode 停在 `Receiving script from model` | 脚本正在生成，可用 Esc 中断。[OpenAI 流停滞](#openai-流停滞)说明自动报错条件。 |
| `OpenAI safety policy blocked the response` | 这是 OpenAI 返回的安全拦截。见 [OpenAI 安全拦截](#openai-安全拦截)。 |
| 工具未注册或不可用 | 用 [tool_search](features/tool-discovery.md) 核对目录；再检查 `/mcp`、`/lsp`、`/neural-search health` 或 `/metis-subagents`。 |

报告问题时附上 Pi 与 Metis 版本、终端模式、复现步骤和相关诊断字段。发送前移除密钥、私人路径和会话正文。

## OpenAI 流停滞

Metis 接管的 `openai` 提供商使用 HTTP Responses API。同一工具调用的参数或完成事件停滞 120 秒后，Metis 会取消响应并报告 `OpenAI Responses stream stalled`。该调用的新参数或完成事件会重置计时。

参数收齐即停止计时。Codemode 随后从 `Receiving script from model` 切换到 `Script received; waiting for model response to finish`；脚本执行始于模型响应完成之后，Esc 可在此阶段中断。正文、隐藏推理和响应尾部沿用 Pi 的 HTTP 超时；`openai-codex` 保持原有传输策略。

需要定位停滞阶段时，在复现前执行 `/responses-stream on`。中断或请求结束后执行 `/responses-stream`，查看最近四条 OpenAI HTTP Responses 请求的解析事件数、参数增量字节数、最后进展和结束事件。结束事件停留在 `args.done` 时，说明响应尾部尚未完成。字节数仅统计参数增量；解析事件计数排除 HTTP 心跳注释。

该诊断默认关闭。内存记录限于事件类别、索引、计数和相对时间；脚本、正文、思维链、请求 ID 及凭据均排除在采集范围外。`/responses-stream off` 清空并停止采集；切换分支也会清空，切换会话或重载后需重新开启。

## OpenAI 安全拦截

当请求最终失败，且 OpenAI 返回 `This content was flagged for possible cybersecurity risk.` 或 `incomplete.content_filter` 时，TUI 会直接显示单独的错误通知。触发条件限于这两类 OpenAI 响应。

## 请求前缀诊断

1. 在出问题的会话执行 `/cache-prefix on`，并先运行一次正常请求。要排查 Goal 暂停和恢复时的缓存变化，请在暂停前打开。
2. 复现后执行 `/cache-prefix`。报告对照同分支最近两次成功主请求：时间差、第一处不同的输入项、工具声明和系统提示变化、服务端回报的缓存读取量。输入数组的尾部追加会单独列出；工具和缓存设置另行比较。
3. 执行 `/cache-prefix off` 关闭并清空。切换分支会丢弃旧样本，切换会话或重载会关闭采集。采集需显式开启；样本保存在内存，字段限于有界指纹、系统段名、工具名称和用量。

此功能需要 Metis SDK 的请求准备观察接口。采集范围包括 OpenAI Responses（含 Codex 和 Azure Responses）、OpenAI Chat Completions 和 Anthropic Messages；其他请求形状或超出采集预算时会显示提示。样本仅来自成功的主请求。

诊断范围止于扩展最终处理的载荷；传输层重试、WebSocket 增量、请求头及提供商内部缓存状态位于采集范围之外。系统段名对应 Pi 的逻辑段，服务端 token offset 需由提供商诊断。首处不同用于定位载荷变化，缓存归因还需结合提供商指标；前缀相同的请求也可能出现缓存未命中。
