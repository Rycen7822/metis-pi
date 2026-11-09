# Metis Session Recall

随 [metis-pi](../../README.md) 发布，与独立包 `@ogulcancelik/pi-session-recall` 同时只能启用一个，避免工具重复。来源和维护契约见 [METIS.md](METIS.md)，MIT 署名见 [LICENSE](LICENSE)。

deferred `session_recall` 提供 search/query/describe：search 逐字扫已存 JSONL（先 rg，fallback 走 grep 或流式 Node），query 经 Pi 当前模型运行时读指定分支。检索全部发生在本地文件上。全局 `[sessionRecall].queryModel` 可换另一个已注册模型；认证归 Pi。

用法和配置见[内置扩展指南](../../docs/features/managed-plugins.md)。根依赖和检查直接载 TypeScript，无需另建 manifest 和构建。
