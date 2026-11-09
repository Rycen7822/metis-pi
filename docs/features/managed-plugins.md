# 内置维护扩展

以下入口由 Metis 统一维护和交付，同一工具或命令只保留一个提供者。

| 功能 | 入口 | 实现和来源 |
| --- | --- | --- |
| 网页访问 | `extensions/web-access.ts` | [`src/pi-web-access/`](../../src/pi-web-access/METIS.md) |
| 会话回忆 | `extensions/session-recall.ts` | [`src/pi-session-recall/`](../../src/pi-session-recall/METIS.md) |
| LSP | `extensions/lsp.ts` | [独立指南](lsp.md) |
| BTW 旁路对话 | `extensions/btw.ts` | `src/btw/runtime.ts`，来自 mitsuhiko/agent-stuff，归属与许可见根目录 NOTICE。 |

## BTW 旁路对话

`/btw <问题>` 发起旁路问答，`/btw` 打开已有对话或重新开始。弹窗内 Enter 提交，Esc 或右上角 `[X]` 关闭；关闭时可丢弃旁路，或把摘要送回主会话。BTW 可使用 Pi 的 read、bash、edit、write，权限与主会话工具一致。弹窗与 Goal/Subagent 一致：居中，宽 90%、高 70%，橙色 `▏` 左边线加深灰底，小终端优先保留输入行。

新旁路会话沿用主会话当前的模型和思考级别，认证复用同一个 Pi 模型运行时，凭据与主会话共用。BTW 按 Pi 1.5 的运行时结构做能力检查，检查通过后启动，遇到陌生结构直接报错。旁路内容以 `btw-thread-entry` / `btw-thread-reset` 存入 Pi 会话，恢复或切分支时重建线程，关会话时释放临时 agent 与弹窗。

Pi 包配置 `"extensions": ["-extensions/btw.ts"]` 可单独停用。agent-stuff 的 `extensions/btw.ts` 与它互斥，同时只能启用一个；随包 `commit`、`github`、`uv` 的外部 CLI 依赖见 [Skills](skills.md)。

## 工具接口

`web_access` 与 `session_recall` 是 deferred 聚合工具，经 Pi `tool_search` 或 codemode 发现。先 `describe` 所需操作，再把参数放入 `params`：

```js
text(await tools.web_access({ action: "describe", target: "fetch" }));
// 按返回的 schema 调用：
text(await tools.web_access({ action: "fetch", params: { urls: ["https://example.com"] } }));
```

| 工具 | 操作 |
| --- | --- |
| `web_access` | `search`、`source_check`、`fetch`、`content`，只列出已启用的能力。 |
| `session_recall` | `search` 本地检索，纯本地扫描；`query` 用模型查会话。 |
| `lsp` | direct，扁平参数 `action: diagnostics/fix`，见 [LSP](lsp.md)。 |

网页的 `webSearch.enabled` 与 `tools.<capability>.enabled` 决定提供哪些操作。返回结构、缓存引用和会话文本按各操作 schema 保留。

## 配置

普通偏好存放在全局 TOML 的 `[webAccess]` / `[sessionRecall]`，模型与认证由 Pi 管理。网页 API key、自定义认证头、带认证代理来自同目录 `web-search.json` 或环境变量，支持 `$ENV` / `!command`；凭据只放 JSON 与环境变量，TOML 保存流程会避开凭据文件。

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

以上为手写示例，完整默认值见[模板](../../metis-pi.toml)。`queryModel="default"`、无效值、模型不存在时都跟随当前会话，也可填注册的 `provider/model-id`；每次 query 重读。

`/websearch`、`/curator` 保存网页偏好，`/search` 查看已存结果。手工修改后建议 `/reload`；注册和快捷键变化需重载，独立 MCP 进程需重启。`webAccess.cacheRoot` 可修改缓存父目录，已存引用继续有效。

网页直连与重定向会校验 DNS 并固定连接地址，非可信 HTTP 代理走 CONNECT。`webAccess.ssrf.trustEnvProxy=true` 将远端 DNS 委托给可信代理，NO_PROXY 命中的请求仍做本地校验；远端提取服务、yt-dlp/ffmpeg 有各自的网络边界。

`[lsp]`、入口过滤等其他字段见[配置参考](../configuration.md)。构建与测试见[开发说明](../development.md)，MIT 许可保留在各源码目录。
