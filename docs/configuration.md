# 配置参考

## 文件、作用域与写入

Metis 偏好使用全局 **`<agentDir>/metis-pi.toml`**。agentDir 默认 `~/.pi/agent`，跟随 `PI_CODING_AGENT_DIR`。

- [默认模板](../metis-pi.toml)同时是运行时默认值来源；[参数说明](../metis-pi-config.md)列出类型、单位、合法值和生效时机。
- `/metis-config` 查看路径；`/metis-config init` 创建缺失的 TOML 和说明，已有文件原样保留。缺失字段采用默认值，读取只进内存。
- 命令保存按模板重建注释并保留未知字段，自定义注释请放旁边说明。跨进程锁串行化读取、合并与原子发布，重叠字段以最后一次写入为准；手工编辑自担时序，损坏的 TOML 保持原状。
- TOML 没有 null；可选触发器用 `false` 关闭，`maxImagesPerRequest=false` 表示使用 API 默认。

| 内容 | 位置 | 生效方式 |
| --- | --- | --- |
| 显示 | `[appearance]` 及子表 | `/reload` 或重启；`enabled` 只控制显示。 |
| 执行 | `[execution.tools]` / `[execution.ui]` | `/execution` 保存，run 边界刷新；快捷键更改后重启。 |
| LSP | `[lsp]` / `[lsp.servers.<name>]` | 每次工具或 `/lsp` 调用重读。 |
| MCP 策略 | `[mcp]` | 默认关闭；`/mcp reload` 刷新。 |
| 精简与 OCC | `[contextPrune]` 及子表 | `/pruner` 保存；手工修改后 `/reload`。 |
| 动态指令 | `[dynamicAgents]` / `[[dynamicAgents.groups]]` | 下一正式 run 读取；Markdown 路径相对全局配置目录。 |
| 子代理 | `[subagents]` / `profiles` | 后端启动读取；更改容量、超时或 profile 后，安全停止再重连。 |
| 本地搜索 | `[neuralSearch]` | 启动偏好需 `/reload` 或重启；semantic 缓存预算/空闲超时在下一请求生效。 |
| 结构化提问 | `[askUserQuestion]` 及 `guidance` | 工具说明注册时读取，折叠键调用时读取。 |
| 会话回忆 | `[sessionRecall]` | `query` 操作重读；`queryModel="default"` 跟随当前模型，也可填 `provider/model-id`。 |
| 网页访问 | `[webAccess]` 及子表 | `/websearch`、`/curator` 保存普通选项。 |

网页凭据来自同目录 **`web-search.json`** 或环境变量；密钥命令在实际请求时执行。模型、主题、packages、trust、reserve、MCP 定义与认证由 Pi 管理。goal 状态保存在 session custom entries，原文和命令日志保存在会话旁 `<sessionId>-blobs/`，与偏好文件分开。

## Pi 1.5.2 模型与预热

模型和预热属于 Pi 配置，不写进 Metis TOML。全局 `<agentDir>/settings.json` 的 `cacheWarming` 默认是 `"idle"`：符合条件时在运行中及回答后继续预热，空闲窗口最长 30 分钟；经济阈值和上下文有效性仍由 Pi 判断。`"streaming"` 仅在运行中预热，`"off"` 关闭。主会话、BTW 和 worker 沿用该设置，Metis 不替用户改默认值。

主界面 footer 的会话 I/O、最近缓存率以及内部对话 ledger 只统计 assistant 与 compaction/branch_summary；独立 `cache_warm` usage 不计入。当前 footer 不显示费用金额，ledger 的 cost 也不是完整账单；预热和其他独立请求的费用以 provider 记录为准。

OpenAI-compatible 请求没有当前工具时，默认省略 `tools`。仅当指定旧网关在已有 tool history 时明确要求 `tools: []`，才在该模型的 `models.json` 定义中设 `compat.requiresToolsWithToolHistory: true`，例如：

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

此开关只针对已确认的模型差异；标准 OpenAI-compatible/vLLM 路径保持默认，当前仍有工具时正常发送工具定义，不全局补空数组。

## 显示字段

有效值见 `/codex-ui`；字段、单位、默认值见 [appearance 参数](../metis-pi-config.md#appearance-及其子表)。例如 `appearance.thinking.peekLines` 控制思考预览，`appearance.footer` 控制状态字段与默认展开。

## 执行字段

`/execution` 保存 `[execution.tools]` / `[execution.ui]`；修改快捷键后重启。工具用法见[执行工具](execution.md)，字段见[参数说明](../metis-pi-config.md)。

## LSP

```toml
[lsp]
timeout = 20000 # 毫秒

[lsp.servers.ruff]
command = ["ruff", "server"]
extensions = [".py", ".pyi"]
```

显式 `servers` 完整替换内置 catalog；省略使用 catalog，`servers = {}` 关闭全部路由。自行安装服务器命令，`/lsp` 查看可用状态；同一命令只启用一个扩展提供者。工具与权限见 [LSP](features/lsp.md)，类型和单位见 [lsp 参数](../metis-pi-config.md#lsp)。

## MCP

Metis MCP 默认关闭。启用时用 `pi config` 禁用 Pi 内置 `mcp` 扩展，保留 `codemode` 和 `tool-search`，并确保同一服务器只有一个会话 owner；设置以下策略后重启：

```toml
[mcp]
enabled = true
idleTimeoutSeconds = 600
keepAliveServers = []
```

服务器定义沿用 Pi 的全局 `<agentDir>/mcp.json` 与可信项目 `<cwd>/.pi/mcp.json`，同名项目服务器覆盖全局。服务器增删和登录使用 `pi mcp add/list/login/logout`，凭据共用 `<agentDir>/mcp-auth.json` 及 Pi 刷新锁；CLI 登录变化在下一 run 重查。

| 策略 | 行为 |
| --- | --- |
| `idleTimeoutSeconds` | 正数秒；请求结束且 agent 空闲后回收连接，执行或等待操作时保留。 |
| `keepAliveServers` | 指定服务器仍按需连接，建立后保留到会话结束或重载。 |
| `exposure` / `toolExposure` | Pi 服务器字段：`codemode` 默认、`deferred` 经 tool_search、`direct` 直接提供、`hidden` 隐藏。 |
| `autoEnableCodemode` | `mcp.json` 中设为 `false` 可关闭自动激活。 |

支持 stdio 和 Streamable HTTP。所有调用经过 Pi 工具事件与权限检查；环境变量、密钥命令和 provider auth 遵循 Pi 规则。

目录缓存位于 `<agentDir>/cache/metis-mcp/`，绑定配置、cwd、可信状态、环境与认证；启动只注册可信目录，调用时连接并重查 schema。缓存只存目录信息，令牌留在 Pi 原生存储，权限 0600；动态认证以实际发现为准。无缓存时后台发现，启动最多等 3 秒；冷发现后断开，keepAlive 连接保留。

连接先发现工具，资源和模板按需查询；目录消费者会等待相关发现，等待可取消。namespace 接受服务器原名或 `mcp__server`，结果保留文本、图片和 JSON `structuredContent`。网络失败、超时和取消原样上报，只有明确会话过期才重建并重试一次。

HTTP JSON 回复与 SSE 单事件沿用 Pi 的 **16 MiB** 默认传输限制；超限取消读取并报告 `MCP JSON response exceeds … bytes` 或对应 SSE 错误。它不同于成功返回后约 20 KiB 的模型展示截断：传输已失败时没有完整回复可落盘。大结果优先让服务端分页、返回资源链接或分块，不通过关闭限额绕过保护。

后台 OAuth 只刷新已有登录，不发起隐藏授权或重注册客户端；失败时保留待完成浏览器登录的 PKCE verifier。需要新授权时显式使用 `pi mcp login`，原生 CLI 与 Metis 共用刷新锁和凭据。

`/mcp` 查看状态，`/mcp reload` 重读配置，`/mcp refresh [server]` 更新目录。停用时设置 `mcp.enabled=false` 并重启，再选择所需 owner；配置和凭据保留。

## 颜色能力

调色板按下表顺序命中并缓存；环境变量更改后重启。

| 条件 | 结果 |
| --- | --- |
| 非空 `NO_COLOR`，或 `FORCE_COLOR=0/false` | 无色。 |
| `FORCE_COLOR=1/2` | 宿主支持真彩时 truecolor，否则 ansi256。 |
| `FORCE_COLOR=3`，或宿主声明 truecolor | truecolor。 |
| `COLORTERM` 含 truecolor/24bit、非空 `WT_SESSION`、`TERM_PROGRAM=WindowsTerminal` | truecolor。 |
| `TERM` 含 256color / 其余 | ansi256 / ansi16。 |

降级保持布局，16 色仅前景，无色使用 ASCII rail。

## 独立入口开关

Pi package entry filters 控制扩展加载。在 `settings.json` 的 packages 项保留 source 与其他规则，添加排除项，再 `/reload` 或重启：

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
| 配置命令 / 显示 | `-extensions/config.ts` / `-extensions/appearance.ts`。 |
| goal / condense | `-extensions/goal.ts` / `-extensions/condense.ts`。 |
| 动态指令 | `-extensions/dynamic-agents.ts`；停用前恢复所需的全局指令。 |
| Pi 文档提示 / 网关错误分类 | `-extensions/system-prompt.ts` / `-extensions/retry-policy.ts`。 |
| skill 输入与显示 | 同时排除 `-extensions/skill-mux.ts`、`-extensions/skill-entry.ts`。 |
| 修改后执行命令 / PTY | `-extensions/action-fusion.ts` / `-extensions/execution.ts`。 |
| MCP / LSP / 本地搜索 | `-extensions/mcp.ts` / `-extensions/lsp.ts` / `-extensions/neural-search.ts`。 |
| 结构化提问 / 子代理 | `-extensions/ask-user-question.ts` / `-extensions/subagents.ts`。 |
| 远端压缩 | `-extensions/codex-compaction.ts`；含检查点的会话先按[恢复说明](features/codex-compaction.md)写成普通摘要。 |
| 网页访问 / 会话回忆 | `-extensions/web-access.ts` / `-extensions/session-recall.ts`。 |

移除排除项恢复；`extensions: []` 关闭整个包。`appearance.enabled=false` 只关显示，`/pruner off` 只停自动精简、保留历史回读。

网关分类把 `workspace_billing_scope_unavailable` 交给 Pi 原生 retry 策略处理。Pi 文档指引位于 `<agentDir>/PI_Documentation_Guide.md`；带 Metis 首行标记的文件按当前 SDK 路径更新，其余内容保持用户手写。
