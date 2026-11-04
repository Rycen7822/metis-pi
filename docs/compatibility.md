# 兼容性与限制

## 版本与平台

| 组件 | 要求 |
| --- | --- |
| Pi | **仅 1.5.0**；依赖、lock 和 CI 同版。 |
| Node.js | **22.19.0+**。 |
| 子代理 | Linux/WSL 或 Windows，Python **3.11+**；沿用父端 SDK/Node。 |
| PTY | 随包 Linux x64 静态 helper、Windows x64 EXE；ConPTY 需 Windows 10 1809+ / 11。 |
| FFF 搜索 | Linux x64、glibc ≥2.31，或 Windows x64；保留可选依赖 `ffi-rs`。 |
| semantic | 另需准备 Linux x64 运行包，见[搜索指南](features/neural-search.md)。 |

Windows Python 可经 PATH 或 `py` 查找；shell 需 Git for Windows。非默认 Git Bash 路径在 Pi `settings.json` 设置 `shellPath`，如 `"D:\\app\\Git\\bin\\bash.exe"`，不要选 WSL `bash.exe`。普通安装无需 Rust/MSVC；更新原生资产前退出全部相关 Pi，避免 DLL 占用。

其他平台、在线服务、模型、图片协议及插件组合须在目标环境验证。

## 显示适配

只接管来源明确的 Pi builtin 或本包 renderer。第三方同名工具、独立 renderer、未知宿主结构或渲染失败保留原生行为，不改变执行和结果正文。

codemode 使用真实辅助动作元数据，无记录的旧会话保留通用摘要，不猜旧调用。源码流式预览、自动收起和 `Took`/正文折叠见[转录显示](features/display.md)；元数据有界且超限提示，只补 details，不改脚本、权限或模型输出。

包装按所有权释放，不覆盖后装插件。editor/footer/Working、历史、复制与 skills 依赖宿主结构，退避见 `/codex-ui`；同名提供者只开一个。主题/字体/鼠标/字宽限制见[界面](features/interface.md)、[复制](features/selection-copy.md)。

Pi 默认 fullscreen；需要终端 scrollback 时设 `tuiMode: "regular"` 或 `--tui-mode regular`。`quietStartup: "header"` 由 Pi 管理。

## 托管工具授权

managed 子代理的显式白名单排除未授权 MCP/资源工具并保留 excludes；明确 MCP 名或 `mcp__` glob 交宿主筛选。无法安全表示补集的普通 wildcard 白名单启动前拒绝。默认选择与纯 modifier 遵循 Pi，不改主端筛选，详见[子代理](subagents/native.md)。

## MCP OAuth

登录用原生 `pi mcp login`；Metis 共用状态/刷新锁并保存旋转 token。1.5 默认 `oauth.clientRegistration: "auto"` 可选客户端文档，已有 DCR 注册继续复用；显式 `dcr`/`cimd` 遵循原生规则，`cimd` 不能配固定 clientId/clientName 或非原生回调路径。需要重登或服务端能力不足时明确报错，不静默换身份。

## 请求与恢复

Pi 持有 provider、OAuth、工具配对与 codemode。[远端压缩](features/codex-compaction.md)说明协议、检查点、失败和恢复；其他压缩与 condense 协作，未完成 nested 或归档失败保留原文。

未知 `tools` 成员访问会报错，存在性判断用 `"name" in tools`；图片转发用 `image(await tools.read({path: "image.png"}))`，见[执行工具](execution.md)。

复制/备份会话须保留旁边 `<sessionId>-blobs/`。更换配置或停用扩展前完成对应恢复与关闭步骤；磁盘安装、当前进程及旧会话记录是不同状态。
