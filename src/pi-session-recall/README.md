# Metis Session Recall

随 [metis-pi](../../README.md) 发布，与独立包 `@ogulcancelik/pi-session-recall` 同时只能启用一个，避免工具重复。来源和维护契约见 [METIS.md](METIS.md)，MIT 署名见 [LICENSE](LICENSE)。

deferred `session_recall` 提供 search/query/describe。search 默认逐字扫 JSONL，显式 `hybrid` / `enhanced` 走本地原生索引和原文回读，不向提供商发送历史。query 经 Pi 模型运行时读取指定分支并回答问题；`[sessionRecall].queryModel` 可换另一个已注册模型，认证归 Pi。

用法和配置见[内置扩展指南](../../docs/features/managed-plugins.md)。根依赖和检查直接载 TypeScript，无需另建 manifest 和构建。
