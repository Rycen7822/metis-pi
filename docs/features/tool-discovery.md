# 工具发现

Metis 提供统一的 `tool_search`，替代 Pi 可替换的原生搜索入口。执行、注册表与权限仍由 Pi 管理。

```js
// 已加载的工具仍可再次搜索，不会重复激活。
tool_search({ query: "neural_search find file path", limit: 1 })
// 精确读取当前顶层定义。不执行目标工具，也不使用旧的参数缓存。
tool_search({ action: "describe", name: "neural_search" })
// codemode 中使用相同的工具、参数与结构化结果。
await tools.tool_search({ action: "describe", name: "neural_search" })
```

`namespace` 限定命名空间。搜索结果为空不表示执行出错。已加载的工具不会因此被排除。

参数描述只返回已登记的顶层 schema。聚合动作的细参仍由工具自己的描述接口提供，例如 `neural_search({action:"describe",target:"find"})`。发现不会执行目标工具，也不会解除隐藏、模块开关或子代理 profile 的限制。

模型请求之前会合并工具名称的新增与移除提示。它不是只显示给用户的 UI 通知。发现过程不轮询、不对全目录做哈希、不复制全部 schema，也不为通知另外发起模型请求。

同名工具的参数更新不依赖通知。需要最新定义时，再次精确描述即可读取。

随包 SDK 在当前脚本能调用 `tools.tool_search` 时，会收起全局的 `searchTools()`，同时同步模型说明和错误建议。没有统一网关时，保留 Pi 原有的发现能力。

脚本开始之后新增的工具，在下一次 codemode 调用时才获得绑定。不会热插拔，也不会自动重跑已执行的脚本。旧对话仍可只读回放。缺失的动作不会从源码推断，也不保留第二套搜索执行器。
