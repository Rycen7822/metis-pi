# 诊断

在出现问题的会话中执行 `/codex-ui`。报告只描述当前 Pi 进程，包含版本、终端模式、有效配置和各显示组件的状态。

| 现象 | 检查与处理 |
| --- | --- |
| 配置未生效 | 先用 `/metis-config` 核对文件路径，再按[配置参考](configuration.md)重载或重启。 |
| 工具显示与预期不同 | 查看 `transcript` 和 `chrome`。第三方渲染器不由 Metis 接管。 |
| 全屏看不到最新输出 | 查看 `history-window`。出现 `Later history` 时，向下翻页或[跳到最新](features/interface.md#全屏历史与留白)。 |
| 复制带有软换行 | 查看 `selection-copy` 和 `copy-stats`；`native-fallback` 表示使用了 Pi 原生提取。 |
| 用量或速度不符合预期 | 先比对[统计口径](features/interface.md#统计口径)。状态栏的估算不用于计费。 |
| 缓存命中突然下降 | 用 [请求前缀诊断](#请求前缀诊断) 对照复现前后的请求。 |
| 模型、指令或整理状态有误 | 用 `/model` 核对当前模型；用 `/dynamic-agents` 或 `/pruner status` 查看策略。 |
| Codemode 停在 `Receiving script from model` | 脚本仍是模型输出，尚未执行；可用 Esc 中断。[OpenAI 流停滞](#openai-流停滞)说明何时会自动报错。 |
| `OpenAI safety policy blocked the response` | OpenAI 明确报告了安全拦截，不是网络断开。见 [OpenAI 安全拦截](#openai-安全拦截)。 |
| 工具未注册或不可用 | 用 [tool_search](features/tool-discovery.md) 核对目录；再检查 `/mcp`、`/lsp`、`/neural-search health` 或 `/metis-subagents`。 |

报告问题时附上 Pi 与 Metis 版本、终端模式、复现步骤和相关诊断字段。发送前移除密钥、私人路径和会话正文。

## OpenAI 流停滞

Metis 接管的 `openai` 提供商使用 HTTP Responses API。某个工具调用开始收到参数后，若连续 120 秒没有该调用的新参数、也未收到完成事件，Metis 会取消该响应并报告 `OpenAI Responses stream stalled`。连接心跳、正文、思考和其他调用不会替它续期。

参数收齐后停止计时，不必等整个响应完成。Codemode 会从 `Receiving script from model` 切换到
`Script received; waiting for model response to finish`。这两个阶段都没有执行脚本，中断也不会运行半截脚本。
没有未收齐参数时，正文、隐藏推理和等待响应结束仍沿用 Pi 的 HTTP 超时；`openai-codex` 的传输策略不变。

需要定位停在哪一步时，在复现前执行 `/responses-stream on`。中断或请求结束后执行 `/responses-stream` 查看最近四条
OpenAI HTTP Responses 请求的解析事件数、参数增量字节数、最后进展和结束事件；例如有 `args.done` 但没有 `completed`，
说明参数结束后没有收到正常响应终止。字节数不是网络流量，HTTP 心跳注释不算解析事件。
默认关闭，只在内存保留事件类别、索引、计数和相对时间，不采集脚本、正文、思维链、请求 ID 或凭据；
`/responses-stream off` 清空并停止。切分支清空；切会话或重载后重新开启。

## OpenAI 安全拦截

当请求最终失败，且 OpenAI 明确返回 `This content was flagged for possible cybersecurity risk.` 或 `incomplete.content_filter` 时，
TUI 会显示单独的错误通知，无需开启 `/responses-stream`。普通拒答、网络断开、参数超时或缺失结束事件不会触发该通知。

## 请求前缀诊断

1. 在出问题的会话执行 `/cache-prefix on`，并先运行一次正常请求。要排查 Goal 暂停和恢复时的缓存变化，请在暂停前打开。
2. 复现后执行 `/cache-prefix`。报告对照同分支最近两次成功主请求：时间差、第一处不同的输入项、工具声明和系统提示变化、服务端回报的缓存读取量。仅在输入数组尾部增加也会单列；工具和缓存设置另行比较。
3. 执行 `/cache-prefix off` 关闭并清空。切换分支会丢弃旧样本，切换会话或重载会关闭采集。默认不采集；开启时只在内存保留有界指纹、系统段/工具名称和用量，不写会话，不输出正文、凭据或指纹。

需要含准备请求观察接口的 Metis SDK。支持 OpenAI Responses（包括 Codex 和 Azure Responses）、OpenAI Chat Completions 和 Anthropic Messages 的对应请求形状；不支持的形状或超出采集预算时会提示。失败、中断、后台预热及摘要请求不作为样本。

诊断比较扩展最后处理的载荷，不包含后续传输层的重试、WebSocket 增量、请求头或提供商内部缓存状态；列出的系统段名是 Pi 的逻辑段，不是服务端的 token offset。首处不同不等于服务端缓存丢失原因，前缀相同也不保证缓存命中。
