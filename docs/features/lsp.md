# LSP 诊断与修复

安装需要的语言服务器后，运行 `/lsp` 检查命令能否解析。`lsp` 使用扁平参数，通过扩展名选择服务器。需要指定服务器时，传 TOML 中的名称。

| `action` | 参数 |
| --- | --- |
| `diagnostics` | `paths` 为文件或目录数组，默认工作区根；`limit` 限制每个服务器检查的文件数，最多 50；`server` 可为单个名称或数组。 |
| `fix` | `path` 为单一文件；`server` 只接受一个名称，匹配多个时必须指定；`kind` 默认 `source.fixAll`；`write` 默认 `false`。 |

两个操作都接受 `root`，默认当前工作目录。目标文件及其符号链接指向必须在 root 内。

```json
{"action":"diagnostics","paths":["src/"],"limit":20}
```

预览 Ruff 的 import 整理。确认结果后再传 `"write": true`：

```json
{"action":"fix","path":"src/main.py","server":"ruff","kind":"source.organizeImports"}
```

Source action 需匹配请求且处于启用状态。服务器返回的独立 Command 仅作为结果返回。修复仅写入目标文件。

## 配置

```toml
[lsp]
timeout = 20000 # 毫秒

[lsp.servers.ruff]
command = ["ruff", "server"]
extensions = [".py", ".pyi"]
```

显式的 `servers` 替换整个内置服务器目录。省略时使用内置目录，设为 `{}` 停用全部路由。内置服务器的命令缺失时会跳过并报告；显式选择的服务器不可用时会报错。`command` 是参数数组，`env.PATH` 也参与命令查找。完整选项见 [LSP 参数](../../metis-pi-config.md#lsp)。

诊断和预览会启动配置中的服务器进程并继承环境，源码保持原样。工具名授权同时覆盖诊断和修复；只读策略应拒绝 `action: "fix"` 与 `write: true` 的组合。
