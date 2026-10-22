# 兼容性与限制

## 版本与平台

| 组件 | 要求 |
| --- | --- |
| Pi | **1.4.0**；依赖、锁文件和 CI 使用同一基线。 |
| Node.js | **22.19.0+**。 |
| 子代理 | Linux/WSL、Python **3.11+**，使用父会话的 Pi SDK 和 Node。 |
| PTY helper | 随包提供 **Linux x64** 静态可执行文件。 |
| Neural Search | **Linux x64，glibc ≥2.31**。 |

其他平台需要对应原生资产和实际验证。在线服务、模型、终端图片协议及第三方插件组合需在使用环境验证。

## 显示适配

Metis 校验宿主组件与工具 renderer 的来源，仅接管明确的 Pi builtin 或本包入口。第三方同名工具、独立 renderer、未知组件形状或渲染失败保留原生显示；执行与存储结果不变。

组件包装按所有权释放，保留后装插件的接管。输入区、全屏历史、选区复制与 skill 显示依赖宿主结构；退避和失败原因见 `/codex-ui`。相同工具或命令只启用一个提供者。

思考标签跟随当前主题；颜色、字体、鼠标和字宽边界见[界面](features/interface.md)与[复制](features/selection-copy.md)。Pi 默认 fullscreen；需要终端原生 scrollback 时，设置 `tuiMode: "regular"` 或使用 `--tui-mode regular`。`quietStartup: "header"` 由 Pi 处理。

## 托管工具授权

managed 子代理按显式工具白名单排除未授权的 MCP 和资源工具，保留原 excludes；明确 MCP 名称或 `mcp__` glob 交由宿主筛选。无法安全表达补集的普通 wildcard 白名单在启动前拒绝。默认选择和纯 modifier 遵循 Pi；此策略不改写主宿主的工具筛选，详见[原生子代理](subagents/native.md)。

## 请求与恢复

Pi 持有 provider、OAuth、工具配对和 codemode。远端压缩的协议选择、检查点范围、失败与恢复见[远端压缩](features/codex-compaction.md)；其他压缩由 Pi/condense 协作。未完成的 nested 证据或归档失败会保留源历史。

codemode 访问未知工具成员会报错，存在性检查使用 `"name" in tools`。普通图片用 `image(await tools.read({path: "image.png"}))` 转发，详见[执行工具](execution.md)。

复制或备份会话时保留旁边的 `<sessionId>-blobs/`。更换配置或停用扩展前，先完成对应功能的恢复与关闭步骤；当前进程、磁盘安装和已有会话记录是不同状态。
