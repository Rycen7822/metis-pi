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

网页搜索、抓取、摘要及会话搜索和查询沿用上游功能与配置路径。原有
`web-search.json`、`session-recall.json`、登录信息、缓存和历史会话继续使用。
`openai` 与 `openai-codex` 兼容修改随 Metis 源码维护；实际 API 决定是否
启用 Codex 专用路由，官方 `openai-responses` 保持普通调用路径。

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
