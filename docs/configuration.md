# 配置参考

## 文件、作用域与写入

metis-pi 自有偏好统一使用 **`<agentDir>/metis-pi.toml`**，只有全局作用域。agentDir 通常是 `~/.pi/agent`，跟随 Pi 的 `PI_CODING_AGENT_DIR`；不再使用显示层单独的 `PI_AGENT_DIR`，不读取项目 metis JSON/TOML 覆盖。

完整默认值见包根目录 [metis-pi.toml](../metis-pi.toml)，逐项参数、合法值、单位和生效时机见同目录 [metis-pi-config.md](../metis-pi-config.md)。默认模板也是运行时默认值来源，读配置不改文件。

| 内容 | TOML 表 / 归属 | 生效和写入 |
| --- | --- | --- |
| 显示配置 | `[appearance]` 及子表 | 启动读取，修改后重启；`enabled` 只控制显示层。 |
| 执行配置 | `[execution.tools]` / `[execution.ui]` | `/execution` 写全局并保留其他字段；run 边界刷新，快捷键修改后重启；不支持 project 参数。 |
| MCP 策略 | `[mcp]` | 默认关闭；`/mcp reload` 刷新。服务器和凭据仍由 Pi 管理。 |
| condense / OCC | `[contextPrune]` 及子表 | `/pruner settings`、相关命令写全局；手动编辑后 `/reload`；见 [condense](features/condense.md)。 |
| 动态全局指令 | `[dynamicAgents]` / `[[dynamicAgents.groups]]` | 策略 Markdown 相对全局配置目录；下一正式 run 读取，见 [动态指令](features/dynamic-agents.md)。 |
| 子代理 | `[subagents]` / `inheritance` / `profiles` | native 入口启用开关、后端容量/超时/profile；后端启动读取，须安全 drain/stop 后重新连接。 |
| goal / 结束摘要 | Pi session custom entries | 会话状态不是配置；摘要持久化由 `appearance.summary.persist` 控制。 |
| 原文、图片、命令日志 | 会话旁 `<sessionId>-blobs/` | 恢复数据不搬入 TOML，复制或清理会话时一并处理。 |

首次升级运行 **`/metis-config init`**，导入旧全局 `metis-pi.json`、Pi `settings.json.contextPrune`、`dynamic-agents.json`、`pi-codex-conversion.json` 的 tools/ui、`subagents.json` 的可映射项及 `subagent-pi/config.toml`，生成完整配置和同目录说明。不覆盖已有 TOML/说明，不删除旧 JSON。新 TOML 不存在时保留只读兼容；一旦存在就不叠加旧配置。请先迁移，别直接用默认模板覆盖个性设置。Pi 的模型、主题、reserve、packages 和 MCP 服务器定义/认证仍留在原文件。

已有上一版 TOML 用 **`/metis-config migrate`**，备份当前文件及旧输入后补齐缺失项并刷新说明；保留现有个性化值，旧执行快捷键仅修复仍为默认值的项。旧 provider 的无效选项明确提示，不生成伪配置。命令不删除原文件、不停止任务；确认新版 frontend/backend 都已使用 TOML 后再将旧 Metis 文件移入备份，不能删除 Pi settings 或子代理数据目录。

归属审计边界：Metis 自有显示、执行、MCP 策略、动态指令、condense/OCC、子代理偏好都在 TOML。`pi-fff.json`/LSP/其他插件参数属于其他包；模型/主题/packages/trust/MCP 定义及认证属于 Pi；SQLite、WAL/SHM、daemon/命令日志、launch/bootstrap JSON、会话/缓存/归档属于状态；策略和 skill Markdown 属于内容；内部 FD、scope、managed-child 环境变量属于协议。它们不是遗漏的 Metis 偏好。

TOML 没有 null：可选触发器使用 `false` 关闭，`maxImagesPerRequest=false` 使用 API 默认。损坏 TOML 不回退旧 JSON，也不允许保存覆盖；显示层记录 problem 并回退，condense 使用默认关闭值，执行/MCP 按自身错误边界报错。初始化和命令保存按包内模板回填分区/参数注释，并保留未知字段；个人自定义注释不保留，可写在旁边说明中。原子 rename 避免半文件，多进程同时保存仍是最后写入者胜出。

## 显示字段

```toml
[appearance.thinking]
peekLines = 10
[appearance.footer]
showChanges = false
[appearance.fullscreen]
marginX = 0
```

其余字段默认值与校验规则见 [参数说明](../metis-pi-config.md#appearance-及其子表)。用 `/codex-ui` 查看有效配置。

## 执行字段

```toml
[execution.tools]
autoReasoning = false
[execution.ui]
backgroundShellPrevShortcut = "alt+u"
```

完整字段见 [参数说明](../metis-pi-config.md)。`/execution` 只写全局，项目配置不再参与解析。

## MCP

需要 Pi 1.0.0。Metis MCP 默认关闭；首次使用时显式切换：

1. 禁用或移除 `pi-mcp-adapter`，用 `pi config` 禁用内置 `mcp` 扩展；保留内置 `codemode`、`tool-search`。原生 `pi mcp` CLI 仍可用。
2. 在全局 TOML 设置下列策略。
3. 重启 Pi。全局 `<agentDir>/mcp.json` 与可信项目 `<cwd>/.pi/mcp.json` 沿用 Pi 配置格式，项目按同名服务器覆盖全局；仅服务器定义保持该 Pi 契约，Metis 策略没有项目覆盖。

```toml
[mcp]
enabled = true
idleTimeoutSeconds = 600
keepAliveServers = []
```

`idleTimeoutSeconds` 为正数秒；请求结束且 agent 空闲后回收，工具运行或等待操作时不回收。`keepAliveServers` 按服务器名保留有状态连接至会话结束/重载，首次仍按需连接。不要同时启用多个 MCP 会话 owner。

服务器 `exposure`/`toolExposure` 沿用 Pi：默认 `codemode`，工具独立注册为 deferred，自动激活原生 `codemode`；`deferred` 激活 `tool_search`；`direct` 直接提供，`hidden` 隐藏。`mcp.json` 的 `autoEnableCodemode: false` 可关闭自动激活。普通工具集合保留；所有调用经过 Pi 工具事件和权限处理。

支持 stdio、Streamable HTTP（含 SSE 通知流），不支持旧 HTTP+SSE、socket 或 rmcp-mux。项目 provider auth 沿用 Pi 限制；`!command`、环境变量取值沿用 Pi 语义。

目录缓存位于 `<agentDir>/cache/metis-mcp/`。可信缓存在启动时只注册目录，调用再连接；无缓存时后台发现，启动最多等 3 秒。缓存绑定配置、工作目录、可信状态、环境与认证，连接会重查 schema。动态命令取值/provider auth 不持久缓存，以真实发现为准。冷发现后默认断开；keepAlive 连接保留。缓存不保存令牌明文，权限 0600。

`/mcp` 查看状态，`/mcp reload` 重读配置，`/mcp refresh [server]` 更新目录。服务器增删及登录仍用 `pi mcp add/list/login/logout`；共用 `<agentDir>/mcp-auth.json` 及 Pi 刷新锁。登录只提示 CLI，不自动打开浏览器；CLI 登录/注销后下一 run 重查目录。

MCP Apps 不渲染，`ui://` 和 App HTML 资源被过滤。图片字节、文本/结构化结果、普通资源回读保留；资源工具跟随 direct/deferred 暴露。网络失败、超时、取消不自动重放，仅明确会话过期可重建连接并重试一次。

回滚：`mcp.enabled=false`，重新启用原生 mcp 或 adapter，重启；配置/凭据保持原样。

## 颜色能力

`src/palette.ts` 按顺序命中即停，实例缓存结果；改环境变量后重启。

| 条件 | 结果 |
| --- | --- |
| 非空 `NO_COLOR`，或 `FORCE_COLOR=0/false` | 无色。 |
| `FORCE_COLOR=1/2` | 宿主支持真彩则 truecolor，否则 ansi256。 |
| `FORCE_COLOR=3`，或宿主声明 truecolor | truecolor。 |
| `COLORTERM` 含 truecolor/24bit；非空 `WT_SESSION`；`TERM_PROGRAM=WindowsTerminal` | truecolor。 |
| `TERM` 含 256color；其余情况 | ansi256；ansi16。 |

降级保留布局：256 色 diff 底色用 22/52，16 色仅前景，无色使用 ASCII rail。

## 独立入口开关

包/扩展加载由 Pi 控制，不迁入 TOML。在 Pi `settings.json` 的 `packages` 安装项添加排除规则，保留 source 和其他规则，再 `/reload` 或重启。例如：

```json
{"packages": [{"source": "git:git@github.com:Rycen7822/metis-pi.git", "extensions": ["-extensions/goal.ts", "-extensions/action-fusion.ts"]}]}
```

| 功能 | 排除项 |
| --- | --- |
| 配置路径/迁移命令 | `-extensions/config.ts`；禁用仅移除命令，不阻止其他模块读取配置。 |
| 显示层 | `-extensions/appearance.ts` |
| goal / condense | `-extensions/goal.ts` / `-extensions/condense.ts` |
| 动态指令 | `-extensions/dynamic-agents.ts`；卸载前先恢复原生策略。 |
| skill 输入与显示 | 同时排除 `-extensions/skill-mux.ts`、`-extensions/skill-entry.ts`。 |
| 全部 Action Fusion | `-extensions/action-fusion.ts` |
| MCP | `-extensions/mcp.ts`；也可保持全局 `mcp.enabled=false`。 |
| 进程与图片工具 | `-extensions/execution.ts` |

删除排除项可恢复；`extensions: []` 关闭整个包。`appearance.enabled=false` 只关显示；`/pruner off` 只停自动精简，历史回读仍可用。
