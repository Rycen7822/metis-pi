# LSP 诊断与修复

Metis 内置维护 `@narumitw/pi-lsp` **0.49.9** 的源码，入口为
`extensions/lsp.ts`，不依赖独立 npm 包或额外构建。上游提交、本地修改与维护边界见
[`src/pi-lsp/METIS.md`](../../src/pi-lsp/METIS.md)，MIT 许可保留在同目录。

## 调用接口

模型侧只注册一个 **direct** 工具 `lsp`，以 `action` 选择操作。
这不同于 deferred 的 `web_access` / `session_recall`：无需先发现操作或调用
`describe`，也没有嵌套 `params`。Pi 的工具选择和 codemode 设置仍决定最终暴露方式。
旧 `lsp_diagnostics`、`lsp_fix` 不作为别名注册；调用方需改用新接口。

| 操作 | 参数与默认行为 |
| --- | --- |
| `action: "diagnostics"` | `paths?` 为文件/目录数组，默认工作区根；`root?` 默认 cwd；`limit?` 默认每个服务器最多 50 个文件；`server?` 可为一个配置名或名字数组，省略时运行所有匹配扩展名的服务器。 |
| `action: "fix"` | 必填单文件 `path`；`root?` 默认 cwd；`server?` 只能是一个配置名，多个服务器匹配时须明确选择；`kind?` 默认 `source.fixAll`；`write?` 默认 `false`，只预览，显式 `true` 才写入。 |

定向诊断示例：

```json
{"action":"diagnostics","paths":["src/"],"limit":20}
```

通过 Ruff 预览导入整理：

```json
{"action":"fix","path":"src/main.py","server":"ruff","kind":"source.organizeImports"}
```

确认后写入时，在同一组参数上加 `"write": true`。`kind` 必须是所选服务器支持的
source action；这不是独立格式化工具。禁用动作和旧式 LSP Command 不会解析或应用，
有效动作的服务器解析错误仍会报出；不执行服务器返回的命令。相对文件路径按 `root` 解析，不允许越出该根，
包括指向根外的符号链接。`root` 只选择文件和服务器工作目录，不切换配置来源。

`/lsp` 查看配置中的命令及其在有效 `PATH` 上的可用状态，不安装或启动服务器。
命令参数不参与配置；通知适用于 TUI/RPC，print/JSON 模式不显示通知输出。

## 全局 TOML

LSP **只读取** `<agentDir>/metis-pi.toml` 的 `[lsp]`；通常是
`~/.pi/agent/metis-pi.toml`，跟随 `PI_CODING_AGENT_DIR`。
不读取项目 Metis 配置，也不读取全局或项目的 `pi-lsp.json` / `lsp.json`。
没有 TOML 或 `[lsp]` 时采用默认值；损坏 TOML 或无效 LSP 配置明确报错，
不会回退 JSON。每次工具或 `/lsp` 调用重新读取，读取不修改文件。

```toml
[lsp]
timeout = 20000 # 请求超时，毫秒
```

省略 `servers` 使用内置 catalog；指定自定义服务器表则**完整替换** catalog，
不与默认服务器合并。例如仅保留 Ruff：

```toml
[lsp]
timeout = 30000

[lsp.servers.ruff]
command = ["ruff", "server"]
extensions = [".py", ".pyi"]
```

显式关闭全部路由可使用：

```toml
[lsp]
servers = {}
```

保留的服务器选项包括 argv `command`、`extensions`、子进程 `env`、
`initialization`、`skipDirectories`、`diagnosticsSettleMs`、
`pushDiagnosticsGraceMs` 和 `pullDiagnosticsGraceMs`。合法值和默认值见
[参数说明](../../metis-pi-config.md#lsp)。

内置 catalog 包括 Biome、ty、Ruff、rust-analyzer、gopls、clangd 等；完整定义见
[`config.ts`](../../src/pi-lsp/config.ts)。命令需要用户自行安装并放在有效 `PATH` 上，
Metis 不下载语言服务器。使用内置 catalog 的诊断会报告并跳过缺失的默认命令；
显式选择或自定义配置的缺失命令会报错。`env.PATH` 同时用于解析启动命令。

## 从独立扩展切换

1. 在其他机器上，把旧 JSON 中的配置值**手动**写到全局 TOML 的 `[lsp]`。
   旧 `{ "timeout": ..., "servers": {...} }` 对应 `lsp.timeout` 与
   `lsp.servers`；旧裸服务器映射放到 `lsp.servers`。argv 数组和嵌套选项保持原值，
   不要用默认模板覆盖已有个性配置。项目 JSON 中需要保留的设置也须明确转为全局值。
2. 激活 Metis LSP 前，从 Pi `packages` 中移除或禁用 `npm:@narumitw/pi-lsp`，
   避免重复 `/lsp` 命令和旧工具。原 npm 目录与 JSON 可留作回退，不会自动删除。
3. 重载或重启 Pi，再用 `/lsp` 核对配置。LSP 没有旧 JSON 兼容读取，
   `/metis-config init` 也不会导入 LSP JSON；未复制的旧设置不会生效。

只关闭 Metis LSP 入口可在现有 Pi 包配置中排除 `-extensions/lsp.ts`；
这同时移除 `lsp` 与 `/lsp`，不影响网页、会话回忆或显示层。

## 权限与边界

- 聚合后仅按工具名配置的只读 allowlist 粒度更粗：加入 `lsp` 会同时允许诊断和修复，
  不能只按名字区分是否写入。需要严格只读时，省略该工具，或让权限策略检查
  `action` / `write`，允许诊断及不写入的预览，拦截 `fix` 的 `write: true`。
- 诊断和预览不主动写源文件，但仍启动用户配置的命令，继承 Pi 环境后应用 `env`。
  应检查命令、参数与初始化选项；路径检查或预览模式不是操作系统沙箱。
- 服务器仅在匹配的工具调用中启动，结束后关闭，不保持编辑器式常驻会话。
  取消和会话替换/关闭/重载会取消并等待本会话的调用清理，不影响其他会话；
  取消前已经完成的写入不回滚。
- 修复只处理目标文件的 source code actions，不提供跳转、引用、语义重命名或持续诊断。
  写入不参与 Pi 的共享文件修改队列，避免同时编辑同一文件。
- 并发调用共享状态栏键，一次完成可能清除另一次调用的指示；这不代表后台调用已完成。
- 输出没有独立的大小上限；应缩小 `paths` 和 `limit`，不要把它当作全仓库日志聚合器。
  无诊断、无可运行默认服务器或无可用修复都不代表项目验证通过。
  完成任务仍须运行项目规定的格式、lint、类型检查、构建与测试。
