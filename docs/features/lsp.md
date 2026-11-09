# LSP 诊断与修复

入口为 `extensions/lsp.ts`，实现位于 `src/pi-lsp/`。模型工具 `lsp` 采用扁平参数加 `action`，默认 direct 暴露，权限最终由 Pi 决定。`/lsp` 显示命令与 PATH 可用状态；服务器需自行安装。

## 调用接口

| action | 参数与行为 |
| --- | --- |
| `diagnostics` | `paths?` 文件/目录数组，默认工作区根；`root?` 默认 cwd；`limit?` 每个服务器最多 50 个文件；`server?` 配置名或数组，省略时按扩展名路由。 |
| `fix` | 必填单个文件 `path`；`root?` 默认 cwd；`server?` 只接受一个名字，匹配多个时须指明；`kind?` 默认 `source.fixAll`；`write?` 默认 false，预览确认后显式 true 才写入。 |

```json
{"action":"diagnostics","paths":["src/"],"limit":20}
```

Ruff 整理 import 预览：

```json
{"action":"fix","path":"src/main.py","server":"ruff","kind":"source.organizeImports"}
```

`kind` 必须是服务器支持的 source action；只选择未禁用且 kind 匹配的 CodeAction，服务器返回的 Command 留给用户。相对路径按 `root` 解析，文件与符号链接目标都限制在根内；root 仅影响工作目录和路由。

## 配置

全局 TOML `[lsp]` 每次调用重读；缺失项使用默认值，损坏或无效配置报错，配置文件保持用户手写内容。

```toml
[lsp]
timeout = 20000 # 毫秒

[lsp.servers.ruff]
command = ["ruff", "server"]
extensions = [".py", ".pyi"]
```

显式 `servers` 整体替换内置 catalog，省略时使用 catalog，`servers = {}` 关闭全部路由；命令需自行安装。

服务器还可设置 `env`、`initialization`、`skipDirectories`、`diagnosticsSettleMs`、`pullDiagnosticsGraceMs`、`pushDiagnosticsGraceMs`，合法值见 [lsp 参数](../../metis-pi-config.md#lsp)。`command` 为 argv 数组，`env.PATH` 也参与命令解析。

内置 catalog 缺命令的诊断会跳过并报告；显式选择或自定义配置缺命令则报错。`/lsp` 与工具只保留一个提供者，入口过滤见[配置](../configuration.md#独立入口开关)。

## 权限与边界

- 按工具名放行 `lsp` 等于同时放行诊断和修复。严格只读策略应检查 `action` / `write`，拦下 `write: true` 的 fix。
- 诊断和预览只读源码，但会启动用户配置的进程并继承环境，权限边界与普通命令一致。
- 服务器按调用启动、结束关闭。取消、切会话、重载会等待本会话清理完成；已写入的修改保留。
- 修复只处理目标文件的 source actions，写入独立于 Pi 共享修改队列；请避免与他人并发编辑同一文件。
- 并发调用共用状态栏 key，指示消失表示该调用结束。paths/limit 建议从窄配置；诊断为空、缺少默认服务器、缺修复能力都属于正常结果，项目验收需另行确认。

MIT 许可与来源记录见 [`src/pi-lsp/`](../../src/pi-lsp/METIS.md)。
