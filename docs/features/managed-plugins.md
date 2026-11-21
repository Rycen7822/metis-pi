# 网页访问、会话检索与 BTW

## 网页访问

通过 [`tool_search`](tool-discovery.md) 发现 `web_access`。按配置提供 `search`、`source_check`、`fetch` 和 `content`。先描述目标操作，再把实参传入 `params`：

```js
text(await tools.web_access({ action: "describe", target: "fetch" }));
text(await tools.web_access({ action: "fetch", params: { urls: ["https://example.com"] } }));
```

`/websearch` 与 `/curator` 保存设置，`/search` 查看已保存的结果。普通偏好放在 `[webAccess]`；API key、认证头与带凭据的代理放在同目录的 `web-search.json` 或环境变量中。凭据值支持 `$ENV` 和 `!command`。变更工具注册或快捷键后运行 `/reload`；独立 MCP 进程需重启。`webAccess.cacheRoot` 指定缓存的父目录。

直连与重定向使用本地 DNS 校验。只有信任代理时才启用 `webAccess.ssrf.trustEnvProxy`，它允许把域名解析交给代理；匹配 `NO_PROXY` 的请求仍做本地校验。远端提取服务、yt-dlp 和 ffmpeg 有各自的网络边界。

## 会话检索

`session_recall.search` 默认在 JSONL 中查固定字符串。带 Recall worker 的 Linux x64 包可用 `mode: "hybrid"` 做本地 BM25 + Bekko128 检索，例如：

```js
text(await tools.session_recall({ action: "search", params: {
  mode: "hybrid", query: "为什么保留会话原文件？", scope: { kind: "project" },
} }));
```

省略 `scope` 搜当前允许的所有会话；也可用 `{kind:"session",sessionPath}` 或 `{kind:"branch",sessionPath,leafId}`。混合检索只索引用户和助手可见正文，最后从原文件回读证据。部分覆盖表示还有内容未索引，不等于没有匹配。工具输出或缺失本地模型时仍可用 `literal`。SQLite 是可重建缓存，原 JSONL、恢复和分支行为不变。

HNSW 默认关闭。显式设置 `backgroundIndex = true` 和 `hnsw = "on"` 后，Pi 空闲时最多每小时为当前会话存储巡检一次图缓存。
图按 UTC 日期分片；仅加速整库查询，最近入库和过期历史仍精扫。保留期默认 15 天，可用 `hnswRetentionDays` 修改。
缩短保留期后查询立即绕过到期图，磁盘文件在后台回收；查询不等待建图。

`session_recall` 的 `query` 使用模型回答会话相关问题。`[sessionRecall].queryModel` 可填已注册的 `provider/model-id`；`"default"` 或不可用的模型使用当前会话模型。使用 `query` 前，确认允许向所选模型发送有关会话内容。

会话能装进输入预算时完整发送。需要选窗时，除英文关键词外，也按相邻汉字双字寻找相关消息，保留开头、结尾和省略提示。
输入仍按模型上下文的 80% 控制，包含系统指令、问题和提示标记；输出最多使用余下的 20%，且不超过模型输出上限。
`details.inputTokenCounter` 标明口径：已知 OpenAI 模型（例如 `gpt-4o`）用对应编码做本地参考计数，其余模型用 `pi-estimate`。两者都不是服务端账单用量。
遇到极长的连续空白或无空白文本时，本地分词可能很慢，对应片段按 UTF-8 字节数保守计入，可能少装一些原文。

### 增强会话检索

需要 Linux x64、随包原生 worker、Bekko128 和本地支持 BF16 的 NVIDIA CUDA 环境。准备好本地 Python 3.11+（验证环境为
PyTorch 2.11 / Transformers 5.12，另需 Accelerate 和 Safetensors），以及下列固定修订的模型文件；不会自动安装或下载。

- [Potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2/tree/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b)：`model.safetensors`、`tokenizer.json`。
- [Yuanbao-Reranker-0.6B](https://huggingface.co/Yuanbao-Search/Yuanbao-Reranker-0.6B/tree/0101299a7937a016848d8d55b092f6e31cfa312d)：`model.safetensors`、`config.json`、`tokenizer.json`、`tokenizer_config.json`。

配置可信解释器和本地权重的绝对路径：

```toml
[sessionRecall.enhanced]
python = "/opt/recall-env/bin/python"
potionDir = "/opt/recall-models/potion-code"
modelDir = "/opt/recall-models/yuanbao"
```

将上例的 `mode: "hybrid"` 改为 `mode: "enhanced"`。增强路径在同一授权范围精确检索 BM25 / Bekko128 / Potion，
按 25/60/15 融合、用 Yuanbao 只重排中心；先保留 K16 实际返回的前五会话，再用 K64 补原文。正常增强输出最多 2,048 token
且不超过该题的 K16 实际原文预算，返回的引文含原记录和字节跨度；不会把对话提交给远端。HNSW 不参与增强评分。

Potion 缓存只在显式增强请求时按批准备，跟普通索引一起受磁盘上限限制；旧索引就地兼容，不迁移 JSONL。
首次调用、大范围未准备、模型缺失/不兼容、提示对超 1,024 token 或工作进程失败时，可收到注明原因的**同范围普通 hybrid**结果，
而不是静默扩大增强输入。普通回退使用既有的普通展示额度，不算增强命中。取消不启动回退。
显式增强会为重排启动本地 Python/CUDA 进程，占用额外时间、RAM 和显存；默认字面搜索和普通 hybrid 不载入这两个附加模型。

## BTW 旁路对话

`/btw <问题>` 打开旁路对话；无参数时继续已有对话或开始新的对话。Enter 提交，Esc 或 `[X]` 关闭。关闭时可以保留对话，或把摘要送回主会话。

旁路沿用主会话的模型、推理级别和认证。默认 **read** 提供 `read`、`grep`、`find`、`ls`；点击权限标记或按 Alt+P 切换到 **write**，额外提供 `bash`、`edit`、`write`。回到 read 会终止正在运行的旁路请求，不回滚已完成的修改。这是工具权限，不是系统沙箱，也不影响主会话权限。重载或切换分支后恢复 read。

对话写入当前 Pi 会话，恢复或切换分支时按记录重建。BTW 需要 Metis 随包 SDK；更新 SDK 后重启 Pi。用 `-extensions/btw.ts` [排除入口](../configuration.md#独立入口开关)。不要同时启用 agent-stuff 的 BTW 扩展。

网页与会话检索的配置见[参数参考](../../metis-pi-config.md)，来源与许可见 [Web Access](../../src/pi-web-access/METIS.md)、[Session Recall](../../src/pi-session-recall/METIS.md)和 [NOTICE](../../NOTICE)。
