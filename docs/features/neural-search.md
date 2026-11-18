# 本地搜索

`neural_search` 在本机搜索路径、文件内容和语义。路径与内容工具随包支持 Linux x64（glibc ≥ 2.31）和 Windows x64，依赖 `ffi-rs`。语义搜索使用独立的 Linux x64 CPU 运行包。

## 选择操作

| `action` | 用途 |
| --- | --- |
| `find` | 模糊查找路径，排序考虑 Git 和使用频率。精确路径或 glob 放在 `path`。 |
| `grep` | 按单个模式查找内容，支持智能大小写与正则；无效正则按字面量处理。 |
| `multi_grep` | 对多个字面值做 OR 搜索。`constraints` 另行限制文件。 |
| `semantic` | 在指定范围内按内容含义找相关片段，不使用路径的使用频率排序。 |
| `describe` | 查看指定操作的参数。 |

通过 [`tool_search`](tool-discovery.md) 发现。以下是工具在 Codemode 中的调用示例：

```js
text(await tools.neural_search({ action: "describe", target: "grep" }));
text(await tools.neural_search({ action: "grep", params: { pattern: "ProfileStore", path: "src/", context: 2 } }));
```

## 路径、结果与分页

`path` 和 `exclude` 限制文件范围，`pattern` 或 `patterns` 匹配内容。`constraints` 是搜索引擎自己的过滤表达式，不使用 shell 转义。已有的绝对文件路径按字面解释。复杂文件名可先搜索其目录，再读取已确认的文件。

`find` 默认每页 30 条，最多 100；快照最多 10,000 条，超限时缩小范围。`grep` 和 `multi_grep` 默认每页 20 条，最多 50；单文件最多收集 200 条，上下文最多 20 行。游标仅限同一会话、操作和查询；内容索引变更后重新查询。`outputTruncated` 或 `perFileLimitReached` 表示结果可能不完整。一次搜索多个多行模式时，请拆成单独查询。

## 语义搜索

```js
text(await tools.neural_search({
  action: "semantic",
  params: { query: "缓存容量不足时从哪里读取", path: "src/", limit: 5 },
}));
```

`path` 是已有文件或目录，可相对当前目录、使用绝对路径或以 `~/` 开头；不支持 glob 或 `exclude`。检索对该范围内的全部片段评分，再结合语义和关键词排序。`model: "auto"` 对纯自然语言范围用 Bekko128，其他范围用 LateOn；也可指定 `"text"` 或 `"code"`。

`limit` 默认 5，最多 100，不提供分页。结果含相对 `root` 的路径、行范围、评分与原文。文本输出超过 50,000 字节时标记 `outputTruncated`；JSON 超过 16 MiB 时请求失败。`timeoutSeconds` 含排队和初始化，默认 1,800，范围 1–3,600；取消只停止本次请求，不关闭共享服务。

Linux x64、glibc ≥ 2.39 时，安装或更新 Metis 可自动准备预编译运行包；未运行安装钩子时，首次查询会尝试准备。`SGREP_RUNTIME_DIR` 可指定可信的独立运行包。模型资产可跨项目复用。查询不向模型提供商发送源文件。

`[neuralSearch.semantic].cacheBudgetMiB` 可取 256、512 或 1024（默认 512 MiB），限制同一用户下共享的磁盘缓存，不是内存上限。索引超出磁盘预算时仍可以流式计算。`idleTimeoutSeconds` 默认 300，范围 1–86,400；两项均在下一次语义请求读取。服务管理见[引擎文档](../../src/neural-search/semantic/README.md#cli-and-shared-service)。

## 索引状态与设置

`/neural-search health` 查看索引与监听状态，`/neural-search rescan` 重新扫描。索引未准备好时，空结果只说明当前已扫描范围无匹配。文件系统根目录默认拒绝扫描；扫描主目录会告警。`[neuralSearch].mentions` 只控制 `@` 补全。完整配置见[参数参考](../../metis-pi-config.md#neuralsearch)。更新原生库后重启 Pi，Windows 更新前先关闭使用该库的进程。
