# 架构

Pi 将 Metis 加载为扩展包。Pi 管理模型、认证、会话、工具权限和 Codemode。Metis 提供工具与策略，并通过扩展 API 接入宿主。少数缺少扩展接口的集成由随包的 [Pi SDK 补丁](../sdk-patches/pi-1.6.0/README.md) 提供。

## 模块边界

| 领域 | 入口和实现 |
| --- | --- |
| 配置 | `extensions/config.ts` 初始化全局配置；`src/configuration/` 负责读取和保存，各扩展校验自己的字段。 |
| 显示 | `src/appearance/` 适配 Pi；`src/presentation/` 提供共用渲染组件；`src/selection-copy/` 按已显示的帧提取选区。 |
| 交互与指令 | `src/goal/`、`src/dynamic-agents/`、`src/skills/`、`src/btw/`、`src/ask-user-question/`。 |
| 执行 | `src/execution/` 管理 PTY 会话和修改后运行的命令。原生 helper 管进程和输出；TypeScript 层管调用、归档和交付。 |
| 上下文 | `src/condense/` 管理工具归档与请求投影；`src/remote-compaction/` 管理提供商检查点；`compaction-policy.ts` 为 Pi 的自动压缩配置上限。 |
| 搜索与服务 | `src/neural-search/` 管本地索引；`src/pi-lsp/` 路由语言服务器；`src/mcp/` 缓存目录和管理连接，复用 Pi 的协议和认证。 |
| 网页与会话检索 | `src/pi-web-access/` 与 `src/pi-session-recall/`；模型、工具发现与权限仍走 Pi。 |
| 子代理 | `src/subagents/`：父端接入 Pi，Python 后端负责调度与账本，JavaScript worker 执行子会话。 |

## 数据流

工具通过 Pi 的注册表暴露。Codemode 可以调用同一批工具，并为嵌套调用提供父调用 ID。显示组件只读调用和结果，执行由工具运行时负责。选区复制使用该帧的来源映射；映射缺失时交给 Pi 原生提取。

工具原文与模型消息投影分开。Condense 归档可恢复的原文，再决定是否用摘要等内容替换后续请求中的历史。Pi 负责触发整段压缩；匹配的提供商请求由远端压缩扩展处理。每轮压缩由单个发布者提交结果。跨扩展事件见 [src/collaboration.ts](../src/collaboration.ts)。

关键实现取舍及对应测试见 [架构决策](decisions.md)。

## 持久化与交付

配置、会话归档、子代理账本和显示缓存各自独立，渲染缓存可单独清理。已接受的子代理任务在父端关闭后继续运行，见 [生命周期](subagents/lifecycle.md)。

根目录的 `package.json` 定义入口和发布文件。交付物包含运行时、主题、skills、原生资产及 SDK 补丁和预编译 SDK。测试与构建源码留在仓库。构建流程见[开发说明](development.md)。
