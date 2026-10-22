# LSP 诊断与修复

入口为 `extensions/lsp.ts`，实现位于 `src/pi-lsp/`。模型工具 `lsp` 使用扁平参数和 `action`，默认 direct 暴露，最终权限由 Pi 决定；`/lsp` 查看命令及 PATH 可用状态，不安装或启动服务器。

## 调用接口

| action | 参数与行为 |
| --- | --- |
| `diagnostics` | `paths?` 文件/目录数组，默认工作区根；`root?` 默认 cwd；`limit?` 默认每服务器 50 个文件；`server?` 为配置名或数组，省略时按扩展名路由。 |
| `fix` | 必填单文件 `path`；`root?` 默认 cwd；`server?` 只能是一个名字，匹配多个时须明确选择；`kind?` 默认 `source.fixAll`；`write?` 默认 false，预览后显式 true 才写入。 |

```json
{"action":"diagnostics","paths":["src/"],"limit":20}
```

Ruff 导入整理预览：

```json
{"action":"fix","path":"src/main.py","server":"ruff","kind":"source.organizeImports"}
```

`kind` 必须是服务器支持的 source action。仅选择未禁用且 kind 匹配的 CodeAction，不执行服务器返回的 Command。相对路径按 `root` 解析，文件及符号链接目标不能越出根；root 只影响工作目录和路由。

## 配置

全局 TOML `[lsp]` 每次调用重读；缺失选项采用默认值，损坏或无效配置报错，读取不写盘。

```toml
[lsp]
timeout = 20000 # 毫秒

[lsp.servers.ruff]
command = ["ruff", "server"]
extensions = [".py", ".pyi"]
```

显式 `servers` 完整替换内置 catalog；省略使用 catalog，`servers = {}` 关闭路由。内置定义见 [config.ts](../../src/pi-lsp/config.ts)，命令需自行安装。

服务器还可设置 `env`、`initialization`、`skipDirectories`、`diagnosticsSettleMs`、`pushDiagnosticsGraceMs`、`pullDiagnosticsGraceMs`；合法值见 [lsp 参数](../../metis-pi-config.md#lsp)。`command` 为 argv 数组，`env.PATH` 也用于启动命令解析。

内置 catalog 的诊断跳过并报告缺失命令；显式选择或自定义配置缺失命令会报错。确保 `/lsp` 和工具只有一个提供者；入口过滤见[配置](../configuration.md#独立入口开关)。

## 权限与边界

- 只按工具名允许 `lsp` 会同时允许诊断和修复。严格只读策略需检查 `action` / `write`，拦截 `fix` 的 `write: true`。
- 诊断和预览不主动写源码，但会启动用户配置的进程并继承环境；不是 OS 沙箱。
- 服务器按调用启动、结束后关闭。取消、会话切换或重载会等待本会话清理，已完成的写入不回滚。
- 修复只处理目标文件的 source actions；写入不进入 Pi 共享修改队列，避免并发编辑同一文件。
- 并发调用共享状态栏键，指示消失不代表全部完成。缩小 paths/limit 控制输出；无诊断、无默认服务器或无修复都不等于项目验收通过。

MIT 许可与来源记录见 [`src/pi-lsp/`](../../src/pi-lsp/METIS.md)。
