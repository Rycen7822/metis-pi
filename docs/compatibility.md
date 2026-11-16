# 兼容性与限制

## 版本与平台

| 组件 | 要求 |
| --- | --- |
| Pi | **仅支持 1.5.2**。依赖、lock、CI 与 SDK 产物须保持同一版本，不兼容旧 SDK。 |
| Node.js | **22.19.0 及以上**。 |
| 子代理 | Linux、WSL 或 Windows；Python **3.11 及以上**。沿用父端的 SDK 和 Node。 |
| PTY | 随包提供 Linux x64 静态 helper 与 Windows x64 EXE。ConPTY 需要 Windows 10 1809 及以上，或 Windows 11。 |
| FFF 搜索 | Linux x64（glibc 2.31 及以上）或 Windows x64。保留可选依赖 `ffi-rs`。 |
| semantic | 需另行准备 Linux x64 运行包，见[搜索指南](features/neural-search.md)。 |

Windows 上的 Python 通过 PATH 或 `py` 查找。shell 使用 Git for Windows。若 Git Bash 安装在非默认路径，请在 Pi 的 `settings.json` 中设置 `shellPath`，例如 `"D:\\app\\Git\\bin\\bash.exe"`。指向 WSL 的 `bash.exe` 会让脚本语义错乱，不能使用。普通安装不需要 Rust 或 MSVC。更新原生资产前，先退出所有相关的 Pi 进程，否则 DLL 会被占用。

Metis 通过 `postinstall` 安装完整的 SDK 补丁。如果 npm 12 的 `allowScripts` 或禁止脚本的策略拦下了这个钩子，首次加载 Metis 时，会话入口仍会补装，并提示重启。`/reload` 不能激活 SDK 补丁。不要绕过包管理器的脚本授权策略。

SDK 同时更新 ai、tui、codemode、coding-agent，以及 codemode 文档。[统一发现](features/tool-discovery.md)由 Metis 插件提供。旧的搜索入口会根据可调用网关的能力收起。

其他平台、在线服务、模型、图片协议和插件组合，需要在目标环境中实测。

## 显示适配

只接管来源明确的 Pi builtin 或本包的 renderer。第三方同名工具、独立 renderer、陌生的宿主结构和渲染失败，都保持原生行为。执行和结果正文不受影响。

codemode 使用真实辅助动作的元数据。旧会话缺少记录时，显示通用摘要。源码流式预览、自动收起、`Took` 与正文折叠见[转录显示](features/display.md)。元数据有界，超限时在 details 中提示。脚本、权限和模型输出保持原样。

包装按所有权释放，后装插件的包装保持独立。editor、footer、Working、历史、复制和 skills 依赖宿主结构。接管失败时退回原生，`/codex-ui` 会说明原因。同名提供者只保留一个。

Pi 默认使用 fullscreen。需要终端 scrollback 时，设置 `tuiMode: "regular"` 或 `--tui-mode regular`。`quietStartup: "header"` 由 Pi 管理。

## 托管工具授权

managed 子代理的显式白名单会拦下未授权的 MCP 与资源工具，其余工具交给宿主筛选。明确的 MCP 名称或 `mcp__` glob 按原规则处理。普通通配符白名单表达补集时有歧义，启动前直接拒绝。默认选择和纯 modifier 跟随 Pi，主端筛选保持原样。见[子代理](subagents/native.md)。

## MCP OAuth

登录使用原生的 `pi mcp login`。Metis 与 Pi 共用状态、刷新锁和轮转后的 token。1.5 默认的 `oauth.clientRegistration` 为 `"auto"`，可带可选的客户端文档。已有的 DCR 注册继续使用。显式的 `dcr` 或 `cimd` 遵循原生规则；`cimd` 要省略固定的 clientId、clientName 和非原生回调路径。重新登录或服务端能力不足时，明确报错，身份保持不变。

## 请求与恢复

provider、OAuth、工具配对与 codemode 归 Pi 负责。[远端压缩](features/codex-compaction.md)说明协议、检查点、失败与恢复。其他压缩与 condense 配合使用。未完成 nested 调用或归档失败时，保留原文。

未知的 `tools` 成员访问会报错，判断存在请用 `"name" in tools`。图片用 `image(await tools.read({path: "image.png"}))` 转发，见[执行工具](execution.md)。

复制或备份会话时，要把同级的 `<sessionId>-blobs/` 一起带走。修改配置或停用扩展前，先完成对应的恢复与关闭步骤。磁盘上的安装、当前进程和旧会话记录是三种不同的状态。
