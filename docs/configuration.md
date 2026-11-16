# 配置参考

## 文件、作用域与写入

Metis 的偏好设置保存在全局的 **`<agentDir>/metis-pi.toml`**。`agentDir` 默认为 `~/.pi/agent`，跟随 `PI_CODING_AGENT_DIR`。

- [默认模板](../metis-pi.toml)同时也是运行时默认值的来源。[参数说明](../metis-pi-config.md)列出类型、单位、合法值与生效时机。
- `/metis-config` 查看配置路径。`/metis-config init` 创建缺失的 TOML 与说明文件，已有文件原样保留。缺失的字段使用默认值。读取只在内存中进行。
- 命令保存时，按模板重建注释，并保留未知字段。自定义注释请写在旁边的说明文件中。跨进程的锁串行化读取、合并与原子发布。重叠字段以最后一次写入为准。手动编辑由用户自行承担时序风险。损坏的 TOML 保持原状。
- TOML 没有 null。可选的触发器用 `false` 关闭。`maxImagesPerRequest=false` 表示使用 API 的默认值。

| 内容 | 位置 | 生效方式 |
| --- | --- | --- |
| 显示 | `[appearance]` 及子表 | `/reload` 或重启。`enabled` 只控制显示。 |
| 执行 | `[execution.tools]`、`[execution.ui]` | `/execution` 保存，在 run 边界刷新。修改快捷键后需重启。 |
| LSP | `[lsp]`、`[lsp.servers.<name>]` | 每次工具调用或 `/lsp` 时重读。 |
| MCP 策略 | `[mcp]` | 默认关闭。`/mcp reload` 刷新。 |
| 精简与 OCC | `[contextPrune]` 及子表 | `/pruner` 保存。手动修改后 `/reload`。 |
| 动态指令 | `[dynamicAgents]`、`[[dynamicAgents.groups]]` | 下一个正式 run 读取。Markdown 路径相对全局配置目录。 |
| 子代理 | `[subagents]`、`profiles` | 后端启动时读取。修改容量、超时或 profile 后，安全停止再重新连接。 |
| 本地搜索 | `[neuralSearch]` | 启动偏好需 `/reload` 或重启。semantic 的缓存预算与空闲超时在下一次请求时生效。 |
| 结构化提问 | `[askUserQuestion]` 及 `guidance` | 工具说明在注册时读取。折叠键每次调用时读取。 |
| 会话回忆 | `[sessionRecall]` | `query` 操作时重读。`queryModel="default"` 跟随当前模型，也可填 `provider/model-id`。 |
| 网页访问 | `[webAccess]` 及子表 | `/websearch`、`/curator` 保存普通选项。 |

网页凭据来自同目录的 **`web-search.json`** 或环境变量。密钥命令在实际请求时执行。模型、主题、packages、trust、reserve、MCP 定义与认证由 Pi 管理。goal 的状态保存在会话的 custom entries 中。原文和命令日志保存在会话旁的 `<sessionId>-blobs/`。这些内容与偏好文件分开。

## Pi 1.5.2 模型与预热

模型与预热属于 Pi 的配置，不写入 Metis 的 TOML。全局 `<agentDir>/settings.json` 中的 `cacheWarming` 默认为 `"idle"`。符合条件时，它在运行中以及回答后继续预热。空闲窗口最长 30 分钟。经济阈值与上下文有效性仍由 Pi 判断。`"streaming"` 只在运行中预热。`"off"` 关闭预热。主会话、BTW 与 worker 都沿用该设置。Metis 不会替用户修改默认值。

主界面 footer 中的会话 I/O、最近的缓存率，以及内部对话 ledger，只统计 assistant 和 compaction、branch summary 消息。独立的 `cache_warm` 用量不计入。当前 footer 不显示费用金额。ledger 中的 cost 不是完整账单。预热和其他独立请求的费用，以 provider 的记录为准。

OpenAI 兼容的请求在没有当前工具时，默认省略 `tools`。只有旧网关在存在工具历史时明确要求 `tools: []`，才需要在该模型的 `models.json` 定义中设置 `compat.requiresToolsWithToolHistory: true`：

```json
{
  "providers": {
    "gateway": {
      "api": "openai-completions",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "models": [{ "id": "model-id", "compat": { "requiresToolsWithToolHistory": true } }]
    }
  }
}
```

这个开关只针对已确认的模型差异。标准的 OpenAI 兼容与 vLLM 路径保持默认。当前有工具时，仍正常发送工具定义，不会全局补空数组。

## 显示字段

有效值见 `/codex-ui`。字段、单位与默认值见 [appearance 参数](../metis-pi-config.md#appearance-及其子表)。例如 `appearance.thinking.peekLines` 控制思考预览的行数。`appearance.footer` 控制状态字段与默认展开状态。

## 执行字段

`/execution` 保存 `[execution.tools]` 与 `[execution.ui]`。修改快捷键后需要重启。工具用法见[执行工具](execution.md)。字段见[参数说明](../metis-pi-config.md)。

## LSP

```toml
[lsp]
timeout = 20000 # 毫秒

[lsp.servers.ruff]
command = ["ruff", "server"]
extensions = [".py", ".pyi"]
```

显式的 `servers` 会完整替换内置 catalog。省略时使用 catalog。`servers = {}` 关闭全部路由。语言服务器需自行安装。`/lsp` 查看可用状态。同一命令只启用一个扩展提供者。工具与权限见 [LSP](features/lsp.md)。类型与单位见 [lsp 参数](../metis-pi-config.md#lsp)。

## MCP

Metis 的 MCP 默认关闭。启用时，用 `pi config` 禁用 Pi 内置的 `mcp` 扩展，保留 `codemode` 与 `tool-search`，并确保同一服务器只有一个会话 owner。然后设置以下策略并重启：

```toml
[mcp]
enabled = true
idleTimeoutSeconds = 600
keepAliveServers = []
```

服务器定义沿用 Pi 的全局 `<agentDir>/mcp.json`，以及可信项目的 `<cwd>/.pi/mcp.json`。同名时，项目服务器覆盖全局服务器。服务器的增删与登录使用 `pi mcp add`、`list`、`login`、`logout`。凭据共用 `<agentDir>/mcp-auth.json` 及 Pi 的刷新锁。CLI 的登录变化在下一次 run 时重新查询。

| 策略 | 行为 |
| --- | --- |
| `idleTimeoutSeconds` | 正数，单位秒。请求结束、agent 空闲后回收连接。执行或等待操作期间保留。 |
| `keepAliveServers` | 指定的服务器仍按需连接。连接建立后保留，直到会话结束或重载。 |
| `exposure`、`toolExposure` | Pi 服务器字段。`codemode` 为默认值；`deferred` 通过 tool_search；`direct` 直接提供；`hidden` 隐藏。 |
| `autoEnableCodemode` | 在 `mcp.json` 中设为 `false`，可关闭自动激活。 |

支持 stdio 与 Streamable HTTP。所有调用都经过 Pi 的工具事件与权限检查。环境变量、密钥命令与 provider 认证遵循 Pi 的规则。

目录缓存位于 `<agentDir>/cache/metis-mcp/`，与配置、cwd、可信状态、环境和认证绑定。启动时只注册可信目录。调用时才连接，并重新查询 schema。缓存只保存目录信息。令牌保留在 Pi 的原生存储中，文件权限为 0600。动态认证以实际发现的结果为准。没有缓存时，在后台发现。启动最多等待 3 秒。冷发现之后断开连接。keepAlive 的连接保留。

连接先发现工具。资源和模板按需查询。目录的消费者会等待相关发现，等待可以取消。namespace 接受服务器的原名或 `mcp__server`。结果保留文本、图片和 JSON `structuredContent`。网络失败、超时和取消原样上报。只有明确的会话过期，才会重建连接并重试一次。

HTTP 的 JSON 回复和 SSE 的单个事件，沿用 Pi 的 **16 MiB** 默认传输限制。超限时取消读取，并报告 `MCP JSON response exceeds … bytes` 或对应的 SSE 错误。这不同于成功返回后约 20 KiB 的模型展示截断。传输已失败时，无法得到完整回复落盘。大结果应优先让服务端分页、返回资源链接或分块。不要通过关闭限额来绕过保护。

后台 OAuth 只刷新已有的登录，不发起隐藏的授权，也不重新注册客户端。失败时，保留等待浏览器完成登录的 PKCE verifier。需要新授权时，显式使用 `pi mcp login`。原生 CLI 与 Metis 共用刷新锁和凭据。

`/mcp` 查看状态。`/mcp reload` 重读配置。`/mcp refresh [server]` 更新目录。停用时设置 `mcp.enabled=false` 并重启，然后选择所需的 owner。配置与凭据保留。

## 颜色能力

调色板按下表的顺序匹配并缓存。修改环境变量后需要重启。

| 条件 | 结果 |
| --- | --- |
| 非空的 `NO_COLOR`，或 `FORCE_COLOR=0`、`false` | 无色。 |
| `FORCE_COLOR=1`、`2` | 宿主支持真彩色时使用 truecolor，否则使用 ansi256。 |
| `FORCE_COLOR=3`，或宿主声明支持 truecolor | truecolor。 |
| `COLORTERM` 包含 truecolor 或 24bit，非空的 `WT_SESSION`，或 `TERM_PROGRAM=WindowsTerminal` | truecolor。 |
| `TERM` 包含 256color | ansi256。其余情况为 ansi16。 |

降级时保持布局。16 色模式只用前景色。无色模式使用 ASCII 的 rail。

## 独立入口开关

Pi 的 package entry filter 控制扩展的加载。在 `settings.json` 的 packages 项中保留 source 与其他规则，再添加排除项，然后执行 `/reload` 或重启：

```json
{
  "packages": [{
    "source": "git:git@github.com:Rycen7822/metis-pi.git",
    "extensions": ["-extensions/goal.ts", "-extensions/action-fusion.ts"]
  }]
}
```

| 功能 | 排除项 |
| --- | --- |
| 配置命令、显示 | `-extensions/config.ts`、`-extensions/appearance.ts` |
| goal、condense | `-extensions/goal.ts`、`-extensions/condense.ts` |
| 动态指令 | `-extensions/dynamic-agents.ts`。停用前，先恢复所需的全局指令。 |
| Pi 文档提示、网关错误分类 | `-extensions/system-prompt.ts`、`-extensions/retry-policy.ts` |
| skill 输入与显示 | 同时排除 `-extensions/skill-mux.ts` 与 `-extensions/skill-entry.ts` |
| 修改后执行命令、PTY | `-extensions/action-fusion.ts`、`-extensions/execution.ts` |
| MCP、LSP、本地搜索 | `-extensions/mcp.ts`、`-extensions/lsp.ts`、`-extensions/neural-search.ts` |
| 结构化提问、子代理 | `-extensions/ask-user-question.ts`、`-extensions/subagents.ts` |
| 远端压缩 | `-extensions/codex-compaction.ts`。含检查点的会话，需先按[恢复说明](features/codex-compaction.md)写成普通摘要。 |
| 网页访问、会话回忆 | `-extensions/web-access.ts`、`-extensions/session-recall.ts` |

移除排除项即可恢复。`extensions: []` 关闭整个包。`appearance.enabled=false` 只关闭显示。`/pruner off` 关闭本地历史整理，已归档的内容仍可回读。

网关分类会把 `workspace_billing_scope_unavailable` 交给 Pi 原生的 retry 策略处理。Pi 文档指引位于 `<agentDir>/PI_Documentation_Guide.md`。带有 Metis 首行标记的文件按当前 SDK 路径更新。其余内容保持用户手写的样子。
