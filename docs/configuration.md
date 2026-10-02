# 配置参考

## 文件、作用域与写入

| 内容 | 路径或归属 | 生效和写入 |
| --- | --- | --- |
| 显示配置 | `<agentDir>/metis-pi.json` | 启动读取，显示层不改写；修改后重启。 |
| 执行配置 | 同一文件的 `execution`；可信项目可用 `<cwd>/.pi/metis-pi.json` 覆盖 | 全局 → 项目；`/execution [project]` 原子写所选字段，保留其他 section 和未知字段。快捷键修改需重启。 |
| MCP | `metis-pi.json` 的 `mcp`；服务器仍在全局及可信项目的 `mcp.json` | 默认关闭，显式切换后由 Metis 管理会话连接；下文说明切换步骤。 |
| condense / OCC | Pi `settings.json` 的 `contextPrune` | `/pruner settings` 可写；见 [condense](features/condense.md)。 |
| 动态全局指令 | `<agentDir>/dynamic-agents.json` 及所选策略文件 | 下一次正式 run 读取；配置与策略只读，见 [动态指令](features/dynamic-agents.md)。 |
| goal / 结束摘要 | Pi session custom entries | goal 保存状态；摘要由 `summary.persist` 控制。 |
| 原文、图片、命令日志 | 会话旁 `<sessionId>-blobs/` | 恢复依赖这些文件；复制或清理会话时一并处理，见 [condense](features/condense.md)。 |

agentDir 通常为 `~/.pi/agent`，跟随 `PI_CODING_AGENT_DIR`。显示入口另允许 `PI_AGENT_DIR` 优先覆盖；该变量不改变其他入口的宿主目录。显示层不读取项目级配置，项目覆盖用于执行设置及 MCP 连接策略。

显示配置缺失、坏 JSON 或根非对象时用默认值；非法 section 单独回退。字段错误可静默回退并记录 problem，用 `/codex-ui` 核对有效配置。执行配置的坏 JSON / 根非对象会报错，不能套用显示层回退规则。

## 显示字段

布尔值使用 JSON `true` / `false`；数字范围列出校验方式。未列出的字段忽略。

| 字段 | 默认 | 行为或范围 |
| --- | --- | --- |
| `enabled` | `true` | 只控制 appearance 显示层。 |
| `thinking.streaming` | `"peek"` | `peek` / `full` / `collapsed`。 |
| `thinking.completed` | `"collapsed"` | `collapsed` / `full`，结束时切换一次。 |
| `thinking.rail` | `true` | 思考正文左侧 rail。 |
| `thinking.peekLines` | `6` | 1–40，越界钳制。 |
| `writePreview.enabled` | `true` | 流式 write 参数预览。 |
| `writePreview.rows` | `8` | 0–64，越界回退；总屏幕行预算，0 只留标题与阶段。 |
| `composer.surface` | `true` | 灰色输入面。 |
| `composer.promptPrefix` | `true` | 首行 `> `，依赖 surface。 |
| `composer.metadata` | `true` | Footer 的模型、推理等级、provider、上下文信息。 |
| `working.elapsed` | `true` | 时长；关闭不影响其他阶段字段。 |
| `working.thought` / `working.tool` | `true` | 思考时长 / 当前工具。 |
| `working.tokens` | `false` | token 段。 |
| `working.animation` | `true` | 仅 truecolor 显示动画。 |
| `working.animationIntervalMs` | `32` | 32–1000，越界钳制。 |
| `footer.enabled` / `footer.details` | `true` | Footer / 累计 I/O 和 cache。 |
| `footer.showCache` / `footer.showChanges` / `footer.showSpeed` | `true` | cache 命中率 / Git 改动量 / tok/s。 |
| `summary.enabled` / `summary.persist` | `true` | 结束摘要 / 会话持久化；不持久化时临时显示。 |
| `selectionCopy.enabled` / `selectionCopy.ctrlC` | `true` | fullscreen 精确复制 / Ctrl+C 路由。 |
| `fullscreen.marginX` | `2` | 0–8，越界回退；0 关闭留白。 |
| `fullscreen.minWidth` | `72` | 40–400，越界回退；更窄时不留白。 |
| `glyphs.textPresentation` | `true` | 指定符号请求文字字形。 |
| `glyphs.include` | `[]` | 单个非 ASCII 字符的数组；非法项跳过，去重后最多 32 项。 |

最小示例：

```json
{
  "thinking": {"peekLines": 10},
  "footer": {"showChanges": false},
  "fullscreen": {"marginX": 0}
}
```

## 执行字段

以下字段位于 `execution` 内，布尔值或字符串类型不符时保留上层值。

| 字段 | 默认 | 用途 |
| --- | --- | --- |
| `tools.autoReasoning` | `false` | 可选的 run 内推理等级调整；见 [执行工具](execution.md)。 |
| `tools.customRustBinariesDir` | `""` | 自定义原生 helper 目录；空值使用随包路径。 |
| `tools.viewImageFallback` | `false` | 文本模型通过已认证图片模型生成描述。 |
| `ui.toolRenaming` | `true` | 执行与图片工具的自定义显示。 |
| `ui.backgroundShellWidget` | `true` | 后台 shell 面板。 |
| `ui.backgroundShellToggleShortcut` | `"alt+w"` | 展开面板。 |
| `ui.backgroundShellPrevShortcut` / `ui.backgroundShellNextShortcut` | `"alt+q"` / `"alt+e"` | 上一项 / 下一项。 |
| `ui.backgroundShellCloseShortcut` | `"alt+r"` | 关闭面板。 |

默认 `alt+q` 可能与宿主冲突，可将上一项改为 `alt+u`。

## MCP

需要 Pi 1.0.0。Metis MCP 默认关闭；首次使用时显式切换：

1. 禁用或移除 `pi-mcp-adapter`，用 `pi config` 禁用内置 `mcp` 扩展；保留内置 `codemode`、`tool-search`。原生 `pi mcp` CLI 仍可用。
2. 在全局 `<agentDir>/metis-pi.json` 合并下列配置；项目不能启用这个入口。
3. 重启 Pi。全局 `<agentDir>/mcp.json` 与可信项目 `<cwd>/.pi/mcp.json` 沿用 Pi 配置格式，项目按同名服务器覆盖全局。

```json
{"mcp": {"enabled": true, "idleTimeoutSeconds": 600, "keepAliveServers": []}}
```

| 字段 | 默认及作用域 | 行为 |
| --- | --- | --- |
| `mcp.enabled` | `false`，仅全局生效 | 避免与已有 adapter/原生会话扩展重复注册。 |
| `mcp.idleTimeoutSeconds` | `600`；全局及可信项目 | 请求结束且 agent 空闲后回收连接；工具正在运行或等待 agent 操作时不会回收。 |
| `mcp.keepAliveServers` | `[]`；全局及可信项目 | 按服务器名保留有状态连接，直到会话结束/重载；首次连接仍按需。 |

服务器的 `exposure`/`toolExposure` 沿用 Pi：默认 `codemode`，工具独立注册为 deferred，自动激活原生 `codemode`；`deferred` 激活 `tool_search`；`direct` 直接提供，`hidden` 隐藏。`mcp.json` 的 `autoEnableCodemode: false` 可关闭自动激活。已有普通工具集合保留；所有调用经过 Pi 的工具事件和权限处理。

支持 stdio、Streamable HTTP（包括其 SSE 通知流），不支持旧 HTTP+SSE、socket 或 rmcp-mux。项目 provider auth 与 Pi 一样受限；`!command`、环境变量取值沿用当前 Pi 语义。

目录缓存位于 `<agentDir>/cache/metis-mcp/`。已有可信缓存的服务器在启动时只注册目录，调用时再连接；没有缓存时后台发现，启动最多等 3 秒。缓存绑定配置、工作目录、可信状态、环境与认证，实际连接会重查 schema。动态命令取值或 provider auth 不持久缓存，以真实发现为准。冷发现后默认断开；`keepAliveServers` 中的连接保留。缓存不保存令牌明文，文件权限为 0600。

用 `/mcp` 查看状态，`/mcp reload` 重读配置，`/mcp refresh [server]` 更新目录。增删服务器与登录仍用 `pi mcp add/list/login/logout`；凭据共用 `<agentDir>/mcp-auth.json` 及 Pi 的刷新锁。需要登录时只提示 CLI，不自动打开浏览器。CLI 登录/注销后下一次 agent run 重查目录。

MCP Apps 不渲染，`ui://` 与 App HTML 资源被过滤。普通图片保留字节，文本/结构化结果与普通资源回读保留；资源工具跟随 direct 或 deferred 暴露。网络失败、超时及取消不自动重放调用，仅明确会话过期可重建连接并重试一次。

回滚：将 `mcp.enabled` 设为 `false`，重新启用原生 `mcp` 或 adapter，重启。配置与凭据文件保持原样；不要同时启用多个 MCP 会话 owner。

## 颜色能力

`src/palette.ts` 按下表顺序命中即停，当前实例缓存结果；改环境变量后重启。

| 条件 | 结果 |
| --- | --- |
| 非空 `NO_COLOR`，或 `FORCE_COLOR=0/false` | 无色。 |
| `FORCE_COLOR=1/2` | 宿主支持真彩则 truecolor，否则 ansi256。 |
| `FORCE_COLOR=3`，或宿主声明 truecolor | truecolor。 |
| `COLORTERM` 含 truecolor/24bit；非空 `WT_SESSION`；`TERM_PROGRAM=WindowsTerminal` | truecolor。 |
| `TERM` 含 256color；其余情况 | ansi256；ansi16。 |

降级保留布局：256 色 diff 底色用 22/52，16 色仅前景，无色使用 ASCII rail 等样式。

## 独立入口开关

在 Pi `settings.json` 的既有 `packages` 安装项添加排除规则，保留 source 和其他规则，然后 `/reload` 或重启。例如：

```json
{"packages": [{
  "source": "git:git@github.com:Rycen7822/metis-pi.git",
  "extensions": ["-extensions/goal.ts", "-extensions/action-fusion.ts"]
}]}
```

| 功能 | 排除项 |
| --- | --- |
| 显示层 | `-extensions/appearance.ts` |
| goal / condense | `-extensions/goal.ts` / `-extensions/condense.ts` |
| 动态指令 | `-extensions/dynamic-agents.ts`；卸载前先恢复原生策略，见功能页。 |
| skill 输入与显示 | 同时排除 `-extensions/skill-mux.ts`、`-extensions/skill-entry.ts`。 |
| 全部 Action Fusion | `-extensions/action-fusion.ts`。 |
| MCP | `-extensions/mcp.ts`；也可保持全局 `mcp.enabled: false`。 |
| 进程与图片工具 | `-extensions/execution.ts`。 |

删除对应排除项可恢复加载；`extensions: []` 会关闭整个包的全部扩展。`enabled: false` 仅关闭显示层；`/pruner off` 仅关闭自动精简，历史回读仍可用。
