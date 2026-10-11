# 网页访问与会话回忆

Metis 内置维护两个上游扩展：

| 模块 | 来源版本 | 入口 |
| --- | --- | --- |
| 网页访问 | `pi-web-access` 0.38.0 | `extensions/web-access.ts` |
| 会话回忆 | `@ogulcancelik/pi-session-recall` 1.0.7 | `extensions/session-recall.ts` |

源码位于 `src/pi-web-access` 和 `src/pi-session-recall`，随 Metis 更新。
入口注释和各目录的 `METIS.md` 记录上游地址、提交和本地修改；原 MIT
许可证保留。`references` 仅用于临时参考，不参与构建或安装。

安装前从 Pi 的 `packages` 中移除或禁用原来的 `npm:pi-web-access` 和
`npm:@ogulcancelik/pi-session-recall`，避免重复注册同名工具。Metis 不自动
修改其他机器上的个人配置。旧 npm 安装目录可保留。

网页搜索、抓取、摘要沿用上游功能及 `web-search.json`。会话查询模型统一由
`metis-pi.toml` 的 `[sessionRecall]` 管理；登录信息、缓存和历史会话继续使用。
`openai` 与 `openai-codex` 兼容修改随 Metis 源码维护；实际 API 决定是否
启用 Codex 专用路由，官方 `openai-responses` 保持普通调用路径。

会话查询模型示例：

```toml
[sessionRecall]
queryModel = "openai/gpt-6.1-sol"
```

默认 `"default"` 跟随当前会话；模型不存在或选择值无效时也回退当前模型。
每次 `session_query` 重读配置，`session_search` 不调用模型。模型定义与认证
仍由 Pi 管理。新 TOML 不存在时 `/metis-config init` 导入旧
`session-recall.json`；已有 TOML 用 `/metis-config migrate` 备份并补齐，现有
TOML 值优先。旧 JSON 保留，TOML 存在后不再作为查询配置读取。

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
