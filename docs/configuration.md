# 配置参考

Metis 读取全局的 `<agentDir>/metis-pi.toml`。`agentDir` 默认为 `~/.pi/agent`，可通过 `PI_CODING_AGENT_DIR` 覆盖。运行 `/metis-config` 查看实际路径；`/metis-config init` 创建缺失的配置和说明文件，不覆盖现有文件。

缺失字段使用[默认模板](../metis-pi.toml)中的值。完整字段、单位与默认值见[参数说明](../metis-pi-config.md)。在界面中保存时，Metis 保留未知字段，按模板重建注释；自定义说明请另存。无效的 TOML 不会被自动覆盖。

| 设置 | TOML 表 | 何时读取 |
| --- | --- | --- |
| 界面、思考与复制 | `[appearance]` | `/reload` 或重启。`enabled` 只控制显示。 |
| 执行工具与快捷键 | `[execution.tools]`、`[execution.ui]` | 运行边界刷新工具设置；快捷键改动需要重启。 |
| 自动压缩上限 | `[compactionPolicy]` | `/reload`；首次加载补丁版 SDK 需要重启。 |
| 历史整理与 OCC | `[contextPrune]` | `/pruner` 保存时生效；手动编辑后执行 `/reload`。 |
| 动态指令 | `[dynamicAgents]` | 下一次正式运行。 |
| 子代理 | `[subagents]`、`[subagents.profiles]` | 后端启动时。更新前先检查[活动任务](subagents/lifecycle.md)。 |
| 本地搜索 | `[neuralSearch]` | `/reload`；语义缓存预算和空闲超时在下一次语义请求读取。 |
| 提问 | `[askUserQuestion]` | 工具说明在注册时读取；折叠键在每次调用时读取。 |
| 会话检索 | `[sessionRecall]` | 每次 `query`。 |
| 网页访问 | `[webAccess]` | `/websearch`、`/curator` 保存偏好；注册相关改动需 `/reload`。 |
| LSP | `[lsp]` | 每次工具调用或执行 `/lsp` 时。 |
| MCP | `[mcp]` | `/mcp reload`；如需更换 MCP 提供者，重启 Pi。 |

模型、认证、主题、包列表、项目信任和 MCP 服务器定义由 Pi 管理。网页工具的凭据放在 `<agentDir>/web-search.json` 或环境变量中。会话正文及其 `<sessionId>-blobs/` 归档与配置分开保存。

## Pi 1.6.0 模型与预热

Metis 按当前 ChatGPT OAuth 登录刷新 `openai` 与 `openai-codex` 的账号目录。API key 和自定义地址沿用 Pi 的目录。`openai` 查询 `/v1/models`，`openai-codex` 使用本机 Codex 的版本号查询 Codex 后端；缺少模型参数时，Metis 会尝试用 `codex debug models` 补齐。缺少必需参数的条目不加入目录。

打开 `/model` 会触发查询。使用 Metis 随包 SDK 时，终端命令 `pi update --models` 强制刷新，跳过 60 秒缓存。
同步失败时优先使用同一次登录、同一账号和服务地址的缓存，否则使用 Pi 的目录。
随包 SDK 正常刷新 OAuth 令牌不会使这份缓存失效。旧版缓存仍需匹配原令牌，下次成功查询后会写入新版缓存。

预热在 Pi 的 `settings.json` 设置：`cacheWarming: "idle"`（默认）也可在空闲期预热，最长 30 分钟；`"streaming"` 只在运行中预热；`"off"` 关闭。主会话、BTW 和子代理沿用 Pi 的设置。独立的预热请求不计入[状态栏用量](features/interface.md#统计口径)，费用以提供商记录为准。

### 自动压缩上限

```toml
[compactionPolicy]
contextWindowAbove = 400000
autoCompactTokenLimit = 400000
```

两个值都是正整数，单位为 token。Pi 的原阈值是模型窗口减去预留量。模型窗口严格大于 `contextWindowAbove` 时，Metis 取原阈值和 `autoCompactTokenLimit` 中较小的值。该设置不会启用已关闭的自动压缩，也不改变模型窗口或手动 `/compact`。

### OpenAI 兼容网关

没有当前工具时，请求默认省略 `tools`。如果网关要求带工具历史的请求显式传 `tools: []`，在相应模型的 `models.json` 定义中设置 `compat.requiresToolsWithToolHistory: true`。只对确认需要该行为的模型开启。

## 显示字段

用 `/codex-ui` 查看有效设置。参阅 [appearance 参数](../metis-pi-config.md#appearance-及其子表)、[转录显示](features/display.md)与[全屏界面](features/interface.md)。

## 执行字段

`/execution` 保存 `[execution.tools]` 与 `[execution.ui]`。执行工具的参数与示例见[进程会话](execution.md)。

## LSP

`[lsp].servers` 省略时采用内置服务器目录。显式配置会替换整个目录；设为 `{}` 会关闭所有路由。安装、配置和写入权限见 [LSP 指南](features/lsp.md)。

## MCP

Metis 的 MCP 默认关闭。启用前，在 `pi config` 中关闭 Pi 内置的 MCP 扩展，确保同一服务器只由一个扩展管理。然后写入以下配置并重启：

```toml
[mcp]
enabled = true
idleTimeoutSeconds = 600
keepAliveServers = []
```

Metis 使用 Pi 的 `<agentDir>/mcp.json` 和可信项目的 `<cwd>/.pi/mcp.json`；同名时使用项目定义。通过 `pi mcp add`、`list`、`login`、`logout` 管理服务器和登录。OAuth 凭据保存在 Pi 的 `mcp-auth.json`。后台只刷新已有登录，新授权请运行 `pi mcp login`。OAuth 客户端注册方式由 Pi 服务器配置决定。

| 选项 | 含义 |
| --- | --- |
| `idleTimeoutSeconds` | 正数，单位秒。没有调用或等待中的操作时，按空闲时间回收连接。 |
| `keepAliveServers` | 指定服务器按需连接，连接后保留到重载或会话关闭。 |
| `exposure` / `toolExposure` | Pi 服务器字段：`codemode`（默认）、`deferred`、`direct` 或 `hidden`。 |
| `autoEnableCodemode` | 在 `mcp.json` 中设为 `false`，关闭自动激活 Codemode。 |

支持 stdio 和 Streamable HTTP。发现结果缓存在 `<agentDir>/cache/metis-mcp/`，其中只存目录信息；实际调用经过 Pi 的权限检查。显式会话过期可重连重试一次，其他失败按原样返回。

HTTP JSON 回复及单个 SSE 事件最多 16 MiB。传输超限时没有完整结果可供恢复；优先使用服务器分页或资源链接。这与调用成功后面向模型的输出截断不同。

用 `/mcp` 查看状态、`/mcp reload` 重读配置、`/mcp refresh [server]` 刷新目录。停用时设 `mcp.enabled=false` 并重启，再选择所需的 MCP 提供者。配置与凭据不受影响。

## 颜色能力

| 条件 | 色彩模式 |
| --- | --- |
| 非空的 `NO_COLOR`，或 `FORCE_COLOR=0` / `false` | 无色。 |
| `FORCE_COLOR=1` 或 `2` | 宿主支持时使用真彩色，否则使用 256 色。 |
| `FORCE_COLOR=3`，或宿主、终端报告支持真彩色 | 真彩色。 |
| `TERM` 含 `256color` | 256 色；其余使用 16 色。 |

从上到下匹配。修改环境变量后重启 Pi。

## 独立入口开关

在 Pi 的 `settings.json` 中，给 Metis 对应的 `packages` 项增加扩展排除规则。保留原有的 `source` 和其他规则：

```json
{
  "packages": [{
    "source": "git:git@github.com:Rycen7822/metis-pi.git",
    "extensions": ["-extensions/goal.ts", "-extensions/action-fusion.ts"]
  }]
}
```

规则使用 `-extensions/<name>.ts`。同时停用 skill 输入和折叠时，排除 `skill-mux` 与 `skill-entry`。停用 `dynamic-agents` 前，先恢复需要的全局指令；停用 `codex-compaction` 前，按[恢复指南](features/codex-compaction.md#失败处理与恢复)处理仍需读取的检查点。`extensions: []` 会停用此包的全部扩展，不影响同一包的主题与 skills。

移除排除项即可恢复。一般改动用 `/reload`；变更包的加载方式或 SDK 时重启。完整入口见仓库的 [extensions/](../extensions/)。
