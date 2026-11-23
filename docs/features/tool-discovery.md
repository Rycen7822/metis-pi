# 工具发现

直接调用 `tool_search`，或在 Codemode 内调用 `tools.tool_search`：两种方式使用相同的参数和结果。

- `search`（默认）按关键词列出候选，激活由 `describe` 完成。传 `namespace` 可缩小范围；只传 `namespace` 则列出该分组及其可用说明。结果有 `nextOffset` 时，用相同条件和 `offset` 继续。
- `describe` 接受精确工具名，返回顶层参数和可用的 Codemode 签名（含返回类型）。如果工具可激活，仅激活精确匹配项，供后续模型请求直接调用；名称无匹配时返回错误。

```js
text(await tools.tool_search({ query: "search file contents", limit: 5 }));
text(await tools.tool_search({ namespace: "subagents" }));
text(await tools.tool_search({ action: "describe", name: "neural_search" }));
```

已经知道准确名称时可跳过搜索。多个操作共用一个工具名时，再向该工具查询操作参数，例如 `neural_search({ action: "describe", target: "grep" })`。工具发现只读取目录和参数定义；目标工具执行及权限检查由后续调用负责。

脚本可直接调用启动时绑定的工具；新注册的工具从下一个脚本开始绑定。网关读取当前会话目录，`ALL_TOOLS` 列出当前脚本的实际绑定。网关可用时由 `tool_search` 提供发现与描述；网关缺席时由 SDK 原生 `searchTools()`、`describeTool()` 和 `describeNamespace()` 提供。

已声明或已通过网关查看过的工具，同名但参数改变时会提示重新 `describe`。参数变更提示针对这些已知工具，搜索候选保持惰性。
