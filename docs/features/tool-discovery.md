# 工具发现

用 `tool_search` 查找可延迟加载的工具，或读取已知工具的当前参数定义。搜索也包含已经加载的工具。`namespace` 可缩小查找范围。

Codemode 示例：

```js
text(await tools.tool_search({ query: "search file contents", limit: 5 }));
text(await tools.tool_search({ action: "describe", name: "neural_search" }));
```

`describe` 返回顶层参数。多个操作共用一个工具名时，再向工具本身查询操作参数，例如 `neural_search({ action: "describe", target: "grep" })`。发现不会执行目标工具，也不会改变 Pi 的权限限制。

在脚本开始之后才激活的工具，从下一次 Codemode 调用起可用。随包 SDK 在脚本已提供 `tools.tool_search` 时不再暴露 `searchTools()`；没有该网关时保留 Pi 原生搜索入口。
