# 网页访问与会话回忆

Metis 内置维护两个上游扩展：

| 模块 | 来源版本 | 入口 |
| --- | --- | --- |
| 网页访问 | `pi-web-access` 0.38.0 | `extensions/web-access.ts` |
| 会话回忆 | `@ogulcancelik/pi-session-recall` 1.0.7 | `extensions/session-recall.ts` |

源码位于 `src/pi-web-access` 和 `src/pi-session-recall`，随 Metis 更新。
入口注释和各目录的 `METIS.md` 记录上游地址、提交和本地修改；原 MIT
许可证保留。`references` 仅用于临时参考，不参与构建或安装。

Pi 只注册 `web_access` 和 `session_recall` 两个聚合入口，两者均为 `deferred`，沿用 execution 的暴露方式，通过原生 codemode 的 `searchTools` / `describeTool` 按需发现。业务参数不放进常驻声明；先查询所选操作的说明，再执行：

```js
const spec = await tools.web_access({ action: "describe", target: "fetch" });
console.log(spec);
// 下一次脚本按返回的参数执行所需操作。
const page = await tools.web_access({ action: "fetch", params: { url: "https://example.com" } });
console.log(page);
```

`web_access` 提供 `search`、`source_check`、`fetch`、`content` 操作，只列出 TOML 中启用的操作；`session_recall` 提供 `search`、`query` 操作。两者的 `describe` 均用 `target` 选择操作，业务参数放在 `params` 内，仍按原操作的完整 schema 校验。返回值保留结构化网页数据及会话回忆文本，快捷键、命令、缓存和查询模型配置继续生效。

Metis 不再注册独立的 `web_search`、`source_check`、`fetch_content`、`get_search_content`、`web_enable`、`session_search`、`session_query` 工具。`webAccess.toolActivation` 和 `toolNames` 不再控制 Metis 聚合入口的暴露或名称；独立上游入口和 Web Access MCP 仍使用它们原有的接口。

安装前从 Pi 的 `packages` 中移除或禁用原来的 `npm:pi-web-access` 和
`npm:@ogulcancelik/pi-session-recall`，避免重复注册同名工具。Metis 不自动
修改其他机器上的个人配置。旧 npm 安装目录可保留。

网页搜索、抓取、摘要的普通选项统一放入现有 `metis-pi.toml` 的 `[webAccess]`；
会话查询模型由同一文件的 `[sessionRecall]` 管理。Web Access 的 API key/token、
自定义认证请求头以及带密码的代理继续用 `web-search.json`，文件位于 TOML
同目录，保留 `$ENV` / `!command` 及环境变量的原有取值方式。
登录信息、缓存和历史会话继续使用。
`openai` 与 `openai-codex` 兼容修改随 Metis 源码维护；实际 API 决定是否
启用 Codex 专用路由，官方 `openai-responses` 保持普通调用路径。

会话查询模型示例：

```toml
[sessionRecall]
queryModel = "openai/gpt-6.1-sol"
```

默认 `"default"` 跟随当前会话；模型不存在或选择值无效时也回退当前模型。
每次 `session_recall` 的 `query` 操作重读配置，`search` 操作不调用模型。模型定义与认证
仍由 Pi 管理。新 TOML 不存在时 `/metis-config init` 导入旧
`session-recall.json`；已有 TOML 直接修改 `[sessionRecall].queryModel`。
旧 recall JSON 保留，TOML 存在后不再作为查询配置读取。

网页配置示例（编辑同一份 `metis-pi.toml`）：

```toml
[webAccess]
workflow = "auto-summary"
autoOpenBrowser = false

[webAccess.searchRouting]
providers = ["parallel", "exa"]
useCurrentModel = false

[webAccess.fetch]
defaultMode = "readable"
timeout = 30
```

现有网页 JSON 的字段名保持不变，普通字段加上 `webAccess` 表前缀。
`/websearch` 和 `/curator` 只把选择写回 TOML。其他手动修改建议 `/reload`，
工具名称、快捷键和启用开关须重载扩展后生效；独立 MCP 需重启进程。

尚无 TOML 时，`/metis-config init` 同时导入网页配置：优先读取 agent 目录的
旧 JSON，缺失时兼容旧 XDG `pi/web-search.json` 和 `~/.pi/web-search.json`。
设置了 `PI_CODING_AGENT_DIR` 时只读取指定目录，不借用其他目录的密钥。
已有 TOML 直接编辑 `[webAccess]`。初始化将凭据 JSON 写到 TOML 同目录，
新写入文件的权限为 `0600`。外部旧文件不删除；同目录的旧混合 JSON 拆分前有备份。
读取过程不改文件。TOML 存在后，JSON 里的普通字段不再参与配置，
API key/token 等凭据仍从 JSON 或环境变量读取。
旧 ~/.pi/XDG 缓存目录通过 `webAccess.cacheRoot` 保留，历史缓存引用继续有效。

可分别用 Pi 包入口过滤关闭：

```json
{
  "source": "git:github.com/Rycen7822/metis-pi",
  "extensions": [
    "-extensions/web-access.ts",
    "-extensions/session-recall.ts"
  ]
}
```

维护时从 Metis 根目录运行 `npm run build:plugins` 生成网页扩展和 MCP
入口；`prepack` 自动执行构建。`npm run test:plugins` 运行该模块的上游测试。
