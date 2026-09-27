# 历史压缩与恢复

metis-pi 内置 pi-condense 2.11.0。首次接管保持上游摘要、批处理、阈值、链压缩、错误清理及恢复宽限策略，沿用已有归档。新用户默认关闭压缩；已有 `contextPrune.enabled: true` 继续有效。

## 配置与迁移

使用 Pi agent 目录的 `settings.json` → `contextPrune`，尊重 `PI_CODING_AGENT_DIR`。`/pruner` 查看状态和设置，`/pruner on`、`/pruner off` 切换压缩。不会复制或自动重写已有设置，也不硬编码摘要模型。上游配置说明见 [2.11.0 configuration](https://github.com/jjuraszek/pi-condense/blob/1bdbba695305419e97be179b412b1fb267298d7f/doc/configuration.md)。

如果同时安装了独立 pi-condense，内置入口会在工具发现后检测 `context_tree_query`，跳过自身注册并提示迁移；外部实例继续工作。使用内置版时，先确认更新后的 metis-pi 已安装，再移除独立的 pi-condense 安装项并重新加载。无需删除 `contextPrune`、会话文件或 sidecar。

通过包入口过滤 `"extensions": ["-condense.ts"]` 可完全禁用内置功能。`metis-pi.json` 的显示层 `enabled` 不控制它。`/pruner off` 仍保留历史回读工具；上游独立的图片数量上限处理保持原行为。

## 分页恢复

工具名称和 `toolCallIds` 保持不变：

```json
{"toolCallIds": ["t12"], "maxBytes": 8192}
```

返回 JSON，其中 `results` 的每条记录包含历史工具、退出错误状态、参数预览、`offsetBytes`、`totalBytes`、精确 `text` 和 `complete`。参数预览截短时 `argsTruncated` 为 true。`nextCursor` 非空时，用相同的 `toolCallIds` 和该值作为 `cursor` 继续读取；`eof` 表示整组选择已经读完。重复原始 tool ID 的各次 occurrence 分别返回。

`maxBytes` 约束整个 JSON 文本，包含头部和游标；默认及上限为 32768，最小为 2048。内容不会在 UTF-8 字符中间截断，超长单行也能继续翻页。工具结果 details 仅保留当前页，不复制整份归档。

游标绑定会话和选中的记录；正常会话增长和索引重建不会使它失效，切换到不含相同记录的分支时需重新查询。sidecar 缺失会返回明确错误，不能把预览当作完整原文。恢复的是历史捕获结果：文件可能已变化，RTK 或执行层之前丢弃的内容不能在这里恢复。

恢复宽限期继续按用户消息组保护回读结果；不会因读取一页而主动重新注入整份原始日志。

## 状态、成本与协作

沿用 pruner 的压缩进度状态；显示受已有 `showPruneStatusLine` 控制。最终回复后仍可能等待摘要，Working 的结束继续以 `agent_settled` 为准。摘要失败、取消和会话处理沿用上游机制。

摘要用量在扩展状态中单列为 `prune usage`。数值来自 `cost:external`，是自当前会话加载以来的累计增量；重复通知覆盖显示，不再次相加。切会话/分支清空该显示，未知或零价格不显示美元金额。footer `Σ` 保持原有标准会话 usage 口径。

Pi 原生容量兜底压缩与 goal 自动续跑保持各自职责。此集成不新增计划工具、主动 abort/compact/resume 调度器或 SoL-Pi 的另一套归档。Codex 的额外 context-management/hybrid/native compaction 组合不因安装本功能自动启用。

来源、许可和更新边界见 [UPSTREAM](../../vendor/pi-condense/UPSTREAM.md)；本地修改见 [PATCHES](../../vendor/pi-condense/PATCHES.md)。
