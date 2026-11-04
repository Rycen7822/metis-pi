# Metis Session Recall

Shipped by [metis-pi](../../README.md), not a separate package; disable standalone `@ogulcancelik/pi-session-recall` to avoid duplicate tools. [METIS.md](METIS.md) records source/maintenance contracts; [LICENSE](LICENSE) retains MIT attribution.

Deferred `session_recall` exposes search/query/describe: search is literal saved-JSONL scanning (rg recommended, grep/streaming Node fallback), query reads a selected branch through Pi's current model runtime. No background index/vector database. Global `[sessionRecall].queryModel` optionally selects another registered model; Pi owns authentication.

See [usage/configuration](../../docs/features/managed-plugins.md). Root dependencies/checks own direct TypeScript loading; no nested manifest/build.
