# 网页访问、会话检索与 BTW

## 网页访问

通过 [`tool_search`](tool-discovery.md) 发现 `web_access`。按配置提供 `search`、`source_check`、`fetch` 和 `content`。先描述目标操作，再把实参传入 `params`：

```js
text(await tools.web_access({ action: "describe", target: "fetch" }));
text(await tools.web_access({ action: "fetch", params: { urls: ["https://example.com"] } }));
```

`/websearch` 与 `/curator` 保存设置，`/search` 查看已保存的结果。普通偏好放在 `[webAccess]`；API key、认证头与带凭据的代理放在同目录的 `web-search.json` 或环境变量中。凭据值支持 `$ENV` 和 `!command`。变更工具注册或快捷键后运行 `/reload`；独立 MCP 进程需重启。`webAccess.cacheRoot` 指定缓存的父目录。

直连与重定向使用本地 DNS 校验。`webAccess.ssrf.trustEnvProxy` 适用于可信代理：启用后由代理解析域名，匹配 `NO_PROXY` 的请求继续使用本地校验。远端提取服务、yt-dlp 和 ffmpeg 有各自的网络边界。

## 会话检索

`session_recall.search` 默认在 JSONL 中查固定字符串。Linux x64（glibc ≥ 2.39）安装或更新 Metis 后，可用 `mode: "hybrid"`
做本地 BM25 + Bekko128 检索。Recall worker 随插件附带；Bekko128 由 Semantic Search 安装流程准备，两者读取同一份模型，
已有语义搜索模型时无需重新下载或复制。更新后重新加载 Pi。

```js
text(await tools.session_recall({ action: "search", params: {
  mode: "hybrid", query: "为什么保留会话原文件？", scope: { kind: "project" },
} }));
```

`scope` 默认覆盖当前授权范围内的所有会话；也可用 `{kind:"session",sessionPath}` 或 `{kind:"branch",sessionPath,leafId}`。混合检索的索引范围为用户和助手可见正文，证据从原文件回读。部分覆盖表示索引尚未完成，匹配结果仅覆盖已索引内容。`literal` 适用于工具输出搜索和本地模型缺失的场景。SQLite 作为可重建缓存；JSONL 继续负责原始记录、恢复和分支。

HNSW 默认关闭。显式设置 `backgroundIndex = true` 和 `hnsw = "on"` 后，Pi 空闲时最多每小时为当前会话存储巡检一次图缓存。
图按 UTC 日期分片；加速范围限于整库查询，最近入库和过期历史使用精确扫描。保留期默认 15 天，可用 `hnswRetentionDays` 修改。
缩短保留期后，查询立即绕过到期图，磁盘文件在后台回收。建图在后台执行，查询直接继续。

`session_recall` 的 `query` 使用模型回答会话相关问题。`[sessionRecall].queryModel` 可填已注册的 `provider/model-id`；`"default"` 以及失效的模型引用均回退到当前会话模型。使用 `query` 前，确认允许向所选模型发送有关会话内容。

会话能装进输入预算时完整发送。需要选窗时，除英文关键词外，也按相邻汉字双字寻找相关消息，保留开头、结尾和省略提示。
输入按模型上下文的 80% 控制，包含系统指令、问题和提示标记；输出预算为余下的 20%，同时受模型输出上限约束。
`details.inputTokenCounter` 标明口径：已知 OpenAI 模型（例如 `gpt-4o`）用对应编码做本地参考计数，其余模型用 `pi-estimate`。两者仅用于本地预算，账单以提供商回执为准。
遇到极长的连续空白或无空白文本时，本地分词可能很慢，对应片段按 UTF-8 字节数保守计入，可能少装一些原文。

### 增强会话检索

需要 Linux x64、随包原生 worker、Bekko128 和本地支持 BF16 的 NVIDIA CUDA 环境。准备好本地 Python 3.11+（验证环境为
PyTorch 2.11 / Transformers 5.12，另需 Accelerate 和 Safetensors）。以下模型文件需按固定修订手动准备：

- [Potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2/tree/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b)：`model.safetensors`、`tokenizer.json`。
- [Yuanbao-Reranker-0.6B](https://huggingface.co/Yuanbao-Search/Yuanbao-Reranker-0.6B/tree/0101299a7937a016848d8d55b092f6e31cfa312d)：`model.safetensors`、`config.json`、`tokenizer.json`、`tokenizer_config.json`。

配置可信解释器和本地权重的绝对路径：

```toml
[sessionRecall.enhanced]
python = "/opt/recall-env/bin/python"
potionDir = "/opt/recall-models/potion-code"
modelDir = "/opt/recall-models/yuanbao"
```

将上例的 `mode: "hybrid"` 改为 `mode: "enhanced"`。增强检索在同一授权范围内运行 BM25、Bekko128 和 Potion，按 25/60/15 融合结果，再由 Yuanbao 重排中心候选。结果先保留 K16 实际返回的前五个会话，再用 K64 补充原文。

正常增强输出上限为 2,048 token，同时受该题 K16 实际原文预算约束。引文包含原记录和字节跨度，对话处理全程在本机完成。HNSW 与增强评分相互独立。

Potion 缓存随显式增强请求按批准备，并与普通索引共享磁盘上限。现有索引可直接使用，JSONL 保持原格式。

以下情况会回退到同一授权范围的普通 hybrid，并在结果中注明原因：首次调用、大范围索引待准备、模型缺失或不兼容、提示对超过 1,024 token、工作进程失败。回退沿用普通展示额度，结果标记为普通 hybrid。取消请求会直接结束。

显式增强会为重排启动本地 Python/CUDA 进程，占用额外时间、RAM 和显存。字面搜索直接扫描 JSONL，普通 hybrid 使用 BM25 / Bekko128；两个附加模型由显式增强请求加载。

## BTW 旁路对话

`/btw <问题>` 打开旁路对话；无参数时继续已有对话或开始新的对话。Enter 提交，Esc 或 `[X]` 关闭。关闭时可以保留对话，或把摘要送回主会话。

旁路沿用主会话的模型、推理级别和认证。默认 **read** 提供 `read`、`grep`、`find`、`ls`；点击权限标记或按 Alt+P 切换到 **write**，额外提供 `bash`、`edit`、`write`。回到 read 会终止正在运行的旁路请求，已完成的修改保持原状。权限标记仅控制 BTW 工具；操作系统隔离需由外部沙箱提供，主会话权限独立。重载或切换分支后恢复 read。

对话写入当前 Pi 会话，恢复或切换分支时按记录重建。BTW 需要 Metis 随包 SDK；更新 SDK 后重启 Pi。用 `-extensions/btw.ts` [排除入口](../configuration.md#独立入口开关)。agent-stuff 的 BTW 扩展与 Metis BTW 二选一。

网页与会话检索的配置见[参数参考](../../metis-pi-config.md)，来源与许可见 [Web Access](../../src/pi-web-access/METIS.md)、[Session Recall](../../src/pi-session-recall/METIS.md)和 [NOTICE](../../NOTICE)。
