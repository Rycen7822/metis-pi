# 网页、会话与 LSP 扩展

Metis 统一维护并交付以下入口；同一工具或命令只启用一个提供者。

| 功能 | 入口 | 实现和来源 |
| --- | --- | --- |
| 网页访问 | `extensions/web-access.ts` | [`src/pi-web-access/`](../../src/pi-web-access/METIS.md) |
| 会话回忆 | `extensions/session-recall.ts` | [`src/pi-session-recall/`](../../src/pi-session-recall/METIS.md) |
| LSP | `extensions/lsp.ts` | [独立指南](lsp.md) |

## 工具接口

`web_access`、`session_recall` 为 deferred 聚合工具，可通过 Pi `tool_search` 或 codemode 发现。先 `describe` 所需操作，再把参数放入 `params`：

```js
text(await tools.web_access({ action: "describe", target: "fetch" }));
// 后续按返回的 schema 调用：
text(await tools.web_access({ action: "fetch", params: { urls: ["https://example.com"] } }));
```

| 工具 | 操作 |
| --- | --- |
| `web_access` | `search`、`source_check`、`fetch`、`content`；只列出已启用能力。 |
| `session_recall` | `search` 本地检索，不调用模型；`query` 使用模型查询会话。 |
| `lsp` | direct、扁平参数 `action: diagnostics/fix`，见 [LSP](lsp.md)。 |

网页的 `webSearch.enabled` 与 `tools.<capability>.enabled` 决定操作是否提供。返回结构、缓存引用和会话文本按各操作 schema 保留。

## 配置

普通偏好使用全局 TOML 的 `[webAccess]` / `[sessionRecall]`；模型和认证由 Pi 管理。网页 API key/token、自定义认证头及带认证代理来自同目录 `web-search.json` 或环境变量，支持 `$ENV` / `!command`；凭据不能写入 TOML，初始化和偏好保存不修改凭据文件。

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

此为自定义示例；完整默认值见[模板](../../metis-pi.toml)。`queryModel="default"`、无效值或模型不存在时跟随当前会话，也可填注册的 `provider/model-id`；每次 query 重读。

`/websearch`、`/curator` 保存网页偏好；`/search` 查看已存结果。手工修改后建议 `/reload`，注册和快捷键变化须重载，独立 MCP 进程须重启。`webAccess.cacheRoot` 可指定缓存父目录，存储引用保持有效。

网页直连与重定向校验 DNS 并固定连接地址；非可信 HTTP 代理需要 CONNECT。`webAccess.ssrf.trustEnvProxy=true` 将代理远端 DNS 安全交给可信代理，NO_PROXY 绕过仍本地校验；远端提取服务、yt-dlp/ffmpeg 的网络连接有各自边界。

LSP 的 `[lsp]`、入口过滤及其他字段见[配置参考](../configuration.md)。构建与测试见[开发说明](../development.md)，MIT 许可保留于各源码目录。
