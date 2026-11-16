# 内置维护扩展

以下入口由 Metis 统一维护和交付。同一工具或命令只保留一个提供者。

| 功能 | 入口 | 实现与来源 |
| --- | --- | --- |
| 网页访问 | `extensions/web-access.ts` | [`src/pi-web-access/`](../../src/pi-web-access/METIS.md) |
| 会话回忆 | `extensions/session-recall.ts` | [`src/pi-session-recall/`](../../src/pi-session-recall/METIS.md) |
| LSP | `extensions/lsp.ts` | [独立指南](lsp.md) |
| BTW 旁路对话 | `extensions/btw.ts` | `src/btw/runtime.ts`。来自 mitsuhiko/agent-stuff，归属与许可见根目录 NOTICE。 |

## BTW 旁路对话

`/btw <问题>` 发起一次旁路问答。`/btw` 无参数时，继续已有的对话，或开始新对话。弹窗居中，宽 90%、高 70%。Enter 提交，Esc 或右上角的 `[X]` 关闭。关闭时可以保留旁路对话，也可以把摘要送回主会话。

新建、重载或切换分支后，权限默认为 **read**，只提供 `read`、`grep`、`find`、`ls`。点击顶部的权限标记，或按 **Alt+P**，可切换到 **write**，此时额外提供 `bash`、`edit`、`write`。模型不能自行授权，也不会改变主会话的权限。切回 read 会阻止新的修改，并终止正在运行的旁路请求。已完成的修改不会回滚。在同一线程中关闭弹窗，不会撤销已授予的权限。这不是操作系统沙箱。

消息、思考、工具结果和编辑器与主页面共用原生渲染链。滚动、查找、滚动条和选区复制也由同一个渲染器处理。工具与思考的展开快捷键沿用主页面的设置。旁路对话独立保存显示状态与原生消息。旧版只有问答的记录仍可读取。

BTW 与子代理弹窗共用嵌入式 TUI、消息文档与显示作用域。工具绘制工厂与来源选择策略也与主界面共用。只读视图使用相同的原生布局、滚动与临时滚动条规则，不创建空编辑器。输入、权限和后台生命周期各自管理。呈现由 Metis 插件完成，Pi 保留主会话的原生消息调度。

旁路对话沿用主会话当前的模型与思考级别，借用同一个 Pi 模型运行时。它不建立独立的认证，也不启动第二个主界面。仅支持 **Pi 1.5.2**。需要更新 Metis 的 SDK 补丁，并完整重启 Pi。单独的 `/reload` 不会替换已加载的 SDK。内容以 `btw-thread-entry` 与 `btw-thread-reset` 写入 Pi 会话。恢复或切换分支时重建线程。关闭会话时释放旁路 agent 与弹窗。

包配置中设置 `"extensions": ["-extensions/btw.ts"]` 可单独停用。agent-stuff 的 `extensions/btw.ts` 与它互斥，同时只能启用一个。随包的 `commit`、`github`、`uv` 依赖的外部 CLI，见 [Skills](skills.md)。

## 工具接口

`web_access` 与 `session_recall` 是 deferred 的聚合工具，通过 Pi 的 `tool_search` 或 codemode 发现。先用 `describe` 查看所需的操作，再把参数放入 `params`：

```js
text(await tools.web_access({ action: "describe", target: "fetch" }));
// 按返回的 schema 调用：
text(await tools.web_access({ action: "fetch", params: { urls: ["https://example.com"] } }));
```

| 工具 | 操作 |
| --- | --- |
| `web_access` | `search`、`source_check`、`fetch`、`content`。只列出已启用的能力。 |
| `session_recall` | `search` 做本地检索，纯本地扫描。`query` 用模型查询会话。 |
| `lsp` | direct 暴露，扁平参数 `action: diagnostics` 或 `fix`。见 [LSP](lsp.md)。 |

网页的 `webSearch.enabled` 与 `tools.<capability>.enabled` 决定提供哪些操作。返回结构、缓存引用和会话文本，按各操作的 schema 保留。

## 配置

普通偏好存放在全局 TOML 的 `[webAccess]` 与 `[sessionRecall]` 中。模型与认证由 Pi 管理。网页的 API key、自定义认证头和带认证的代理，来自同目录下的 `web-search.json` 或环境变量。支持 `$ENV` 与 `!command` 形式。凭据只写入 JSON 与环境变量，TOML 保存流程会避开凭据文件。

```toml
[sessionRecall]
queryModel = "default"

[webAccess]
workflow = "summary-review"
autoOpenBrowser = false

[webAccess.searchRouting]
providers = ["parallel", "exa"]
useCurrentModel = false

[webAccess.fetch]
defaultMode = "readable"
timeout = 30
```

以上为手写示例。完整默认值见[模板](../../metis-pi.toml)。`queryModel="default"`、无效值，或模型不存在时，都跟随当前会话。也可以填写已注册的 `provider/model-id`。每次 query 都重读配置。

`/websearch` 与 `/curator` 保存网页偏好。`/search` 查看已保存的结果。手工修改后建议 `/reload`。注册和快捷键的变化需要重载。独立的 MCP 进程需要重启。`webAccess.cacheRoot` 可修改缓存的父目录，已保存的引用继续有效。

网页的直连与重定向会校验 DNS，并固定连接地址。非可信的 HTTP 代理使用 CONNECT。`webAccess.ssrf.trustEnvProxy=true` 会把远端 DNS 委托给可信代理。命中 NO_PROXY 的请求仍做本地校验。远端提取服务、yt-dlp 与 ffmpeg 有各自的网络边界。

`[lsp]`、入口过滤等其他字段见[配置参考](../configuration.md)。构建与测试见[开发说明](../development.md)。MIT 许可保留在各源码目录中。
