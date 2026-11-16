# LSP 诊断与修复

入口为 `extensions/lsp.ts`，实现位于 `src/pi-lsp/`。模型工具 `lsp` 使用扁平参数加 `action`，默认 direct 暴露，最终权限由 Pi 决定。`/lsp` 显示命令与 PATH 的可用状态。语言服务器需要自行安装。

## 调用接口

| action | 参数与行为 |
| --- | --- |
| `diagnostics` | `paths?` 为文件或目录数组，默认工作区根。`root?` 默认 cwd。`limit?` 为每个服务器最多检查的文件数，上限 50。`server?` 为配置名或数组，省略时按扩展名路由。 |
| `fix` | 必填单个文件 `path`。`root?` 默认 cwd。`server?` 只接受一个名字，匹配多个时必须指明。`kind?` 默认 `source.fixAll`。`write?` 默认 false，预览确认后显式设为 true 才会写入。 |

```json
{"action":"diagnostics","paths":["src/"],"limit":20}
```

用 Ruff 预览 import 整理：

```json
{"action":"fix","path":"src/main.py","server":"ruff","kind":"source.organizeImports"}
```

`kind` 必须是服务器支持的 source action。只选择未禁用且 kind 匹配的 CodeAction。服务器返回的 Command 交由用户处理。相对路径按 `root` 解析。文件与符号链接的目标都必须位于根目录之内。root 只影响工作目录和路由。

## 配置

全局 TOML 的 `[lsp]` 每次调用时重读。缺失的项使用默认值。配置损坏或无效时报错，并保持用户手写的内容不变。

```toml
[lsp]
timeout = 20000 # 毫秒

[lsp.servers.ruff]
command = ["ruff", "server"]
extensions = [".py", ".pyi"]
```

显式的 `servers` 整体替换内置 catalog。省略时使用 catalog。`servers = {}` 关闭全部路由。命令需自行安装。

服务器还可以设置 `env`、`initialization`、`skipDirectories`、`diagnosticsSettleMs`、`pullDiagnosticsGraceMs` 与 `pushDiagnosticsGraceMs`，合法值见 [lsp 参数](../../metis-pi-config.md#lsp)。`command` 是 argv 数组，`env.PATH` 也参与命令解析。

内置 catalog 中缺少命令时，诊断会跳过并报告。显式选择或自定义配置中缺少命令，则直接报错。`/lsp` 与工具只保留一个提供者。入口过滤见[配置](../configuration.md#独立入口开关)。

## 权限与边界

- 按工具名放行 `lsp`，等于同时放行诊断和修复。严格的只读策略应检查 `action` 与 `write`，拦下 `write: true` 的 fix。
- 诊断和预览只读取源码，但会启动用户配置的进程并继承环境。权限边界与普通命令一致。
- 服务器按调用启动，调用结束后关闭。取消、切换会话和重载时，会等待本会话的清理完成。已写入的修改保留。
- 修复只处理目标文件的 source action。写入独立于 Pi 的共享修改队列。避免与他人并发编辑同一文件。
- 并发调用共用同一个状态栏 key。指示消失即表示该调用结束。建议从窄范围配置 paths 与 limit。诊断为空、缺少默认服务器、没有修复能力，都属于正常结果。项目验收需另行确认。

MIT 许可与来源见 [`src/pi-lsp/`](../../src/pi-lsp/METIS.md)。
