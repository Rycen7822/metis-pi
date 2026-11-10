# 工具发现

Metis 提供统一的 `tool_search`，替换 Pi 可替换的原生搜索入口；执行、注册表和权限仍由 Pi 管理。

```js
// 已加载工具仍能再次搜索，不会重复激活。
tool_search({ query: "neural_search find file path", limit: 1 })
// 精确读取当前顶层定义，不执行目标工具，也不使用旧参数缓存。
tool_search({ action: "describe", name: "neural_search" })
// codemode 内使用同一个工具、参数和结构化结果。
await tools.tool_search({ action: "describe", name: "neural_search" })
```

`namespace` 限定命名空间。搜索空结果不表示执行错误，也不再因为工具已加载而把它排除。
参数描述只返回已登记的顶层 schema；聚合动作的细参仍由工具自己的描述接口提供，例如 `neural_search({action:"describe",target:"find"})`。
发现不会执行目标工具，也不解除隐藏、模块开关或子代理 profile 的限制。

模型请求前合并工具名称的新增/移除提示；不是仅显示给用户的 UI 通知。不轮询、不 hash 全目录、不复制全部 schema，也不为通知另开模型请求。
同名参数更新不依赖通知：再次精确描述即可读取当前定义。

随包 SDK 在当前脚本可调用 `tools.tool_search` 时收起全局 `searchTools()`，同步模型说明和错误建议；无统一网关时保留 Pi 原有发现能力。
脚本开始后新增的工具，在下一次 codemode 调用中获得绑定，不热插拔或自动重跑已执行脚本。
旧对话仍可只读回放，不从源码推断缺失动作，也不保留第二套搜索执行器。
