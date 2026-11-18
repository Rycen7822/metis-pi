# 工具发现

直接调用 `tool_search`，或在 Codemode 内调用 `tools.tool_search`：两种方式使用相同的参数和结果。

- `search`（默认）按关键词列出候选，不激活工具。传 `namespace` 可缩小范围；只传 `namespace` 则列出该分组及其可用说明。结果有 `nextOffset` 时，用相同条件和 `offset` 继续。
- `describe` 接受精确工具名，返回顶层参数和可用的 Codemode 签名（含返回类型）。如果工具可激活，只激活这一项，供后续模型请求直接调用。找不到时不会激活相似工具。

```js
text(await tools.tool_search({ query: "search file contents", limit: 5 }));
text(await tools.tool_search({ namespace: "subagents" }));
text(await tools.tool_search({ action: "describe", name: "neural_search" }));
```

已经知道准确名称时可跳过搜索。多个操作共用一个工具名时，再向该工具查询操作参数，例如 `neural_search({ action: "describe", target: "grep" })`。工具发现不执行目标工具，也不放宽 Pi 的权限限制。

脚本已绑定的工具无需激活即可调用；新注册的工具不会加入当前脚本。网关读取当前会话目录，`ALL_TOOLS` 仍可用来确认当前脚本的实际绑定。新版网关可调用时，随包 SDK 不再暴露重复的 `searchTools()`、`describeTool()` 和 `describeNamespace()`；没有网关时保留原生助手。

已声明或已通过网关查看过的工具，同名但参数改变时会提示重新 `describe`。仅出现在搜索候选中的工具不触发参数变更提示。
