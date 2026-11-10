# 兼容性与限制

## 版本与平台

| 组件 | 要求 |
| --- | --- |
| Pi | **只认 1.5.1**；依赖、lock、CI 与 SDK 产物同版，不兼容旧 SDK。 |
| Node.js | **22.19.0+**。 |
| 子代理 | Linux/WSL 或 Windows，Python **3.11+**；沿用父端 SDK 和 Node。 |
| PTY | 随包 Linux x64 静态 helper、Windows x64 EXE；ConPTY 要 Windows 10 1809+ / 11。 |
| FFF 搜索 | Linux x64、glibc ≥2.31，或 Windows x64；保留可选依赖 `ffi-rs`。 |
| semantic | 另准备 Linux x64 运行包，见[搜索指南](features/neural-search.md)。 |

Windows Python 通过 PATH 或 `py` 查找；shell 使用 Git for Windows。Git Bash 安装在非默认路径时，在 Pi `settings.json` 设 `shellPath`，如 `"D:\\app\\Git\\bin\\bash.exe"`；指向 WSL 的 `bash.exe` 会造成脚本语义错乱。普通安装无需 Rust/MSVC；更新原生资产前退出所有相关 Pi 进程，避免 DLL 占用。

Metis 通过 `postinstall` 安装完整 SDK 补丁；若 npm 12 的 `allowScripts` 或禁脚本策略拦住该钩子，
首次加载 Metis 时的会话入口仍会补装并提示重启。不要把 `/reload` 当成 SDK 激活；不绕过包管理器的脚本授权策略。

其他平台、在线服务、模型、图片协议、插件组合，都要在目标环境实测。

## 显示适配

只接管来源明确的 Pi builtin 或本包 renderer。第三方同名工具、独立 renderer、陌生宿主结构、渲染失败均保持原生行为，执行和结果正文不受影响。

codemode 使用真实辅助动作的元数据，旧会话缺少记录时显示通用摘要。源码流式预览、自动收起、`Took`/正文折叠见[转录显示](features/display.md)；元数据有界，超限时在 details 中提示，脚本、权限和模型输出保持原样。

包装按所有权释放，后装插件的包装保持独立。editor/footer/Working、历史、复制、skills 依赖宿主结构，接管失败会退回原生，`/codex-ui` 说明原因；同名提供者只留一个。

Pi 默认 fullscreen；要终端 scrollback 就设 `tuiMode: "regular"` 或 `--tui-mode regular`。`quietStartup: "header"` 归 Pi 管。

## 托管工具授权

managed 子代理的显式白名单拦下未授权 MCP/资源工具，其余交宿主筛选；明确 MCP 名或 `mcp__` glob 按原规则走。普通 wildcard 白名单表达补集有歧义，启动前直接拒绝。默认选择和纯 modifier 跟 Pi 走，主端筛选保持原样，见[子代理](subagents/native.md)。

## MCP OAuth

登录使用原生 `pi mcp login`；Metis 共用状态、刷新锁和轮转后的 token。1.5 默认 `oauth.clientRegistration: "auto"`，带可选客户端文档；已有 DCR 注册继续使用，显式 `dcr`/`cimd` 遵循原生规则，`cimd` 须省略固定 clientId/clientName 和非原生回调路径。重登或服务端能力不足时明确报错，身份保持不变。

## 请求与恢复

provider、OAuth、工具配对、codemode 归 Pi。[远端压缩](features/codex-compaction.md)讲协议、检查点、失败和恢复；其他压缩和 condense 配合，未完成 nested 或归档失败时保留原文。

未知 `tools` 成员访问会报错，存在性用 `"name" in tools` 判断；图片用 `image(await tools.read({path: "image.png"}))` 转发，见[执行工具](execution.md)。

复制或备份会话时，把旁边的 `<sessionId>-blobs/` 一起带走。改配置、停扩展之前，先走完对应的恢复和关闭步骤；磁盘安装、当前进程、旧会话记录是三种状态。
