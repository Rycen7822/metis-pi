# Neural Search

Metis 维护的本地路径与内容搜索，索引、排序和 Rust 引擎均在本机运行，不上传项目文件。随包提供 Linux x64 / glibc ≥2.31 的原生库；普通安装无需编译器，需要保留可选依赖 `ffi-rs`。

## 一个入口，按需加载

`neural_search` 是 deferred 聚合工具。通过 Pi `tool_search` 或 codemode 发现，再用 `describe` 读取所需操作参数；发现本身不启动索引。managed 子代理的可用工具仍由 profile 决定。

```js
neural_search({ action: "describe", target: "find" })
neural_search({ action: "find", params: { pattern: "profile", path: "src/", limit: 10 } })
neural_search({ action: "grep", params: { pattern: "ProfileStore", path: "src/", context: 2 } })
neural_search({ action: "multi_grep", params: { patterns: ["ProfileStore", "profile_store"], path: "src/" } })
```

| action | 用途 |
| --- | --- |
| `find` | 模糊路径搜索、glob 过滤、Git/常用度排序；精确路径和 glob 放 `path`。 |
| `grep` | 单模式内容搜索，智能大小写、有效正则及字面量回退。 |
| `multi_grep` | 多个字面量的 OR 搜索，可另用 `constraints` 过滤。 |
| `describe` | 返回操作说明和 schema。 |

激活后的定义会进入后续请求。精确参数以 `describe` 为准，游标只能续同一会话、操作和查询。

## 参数与分页

| 预算 | 限制 |
| --- | --- |
| `find` | 默认 30、每页最多 100；完整快照最多 10,000 条，超出需缩小范围。 |
| find 游标缓存 | 不同快照合计 20,000 条、200 个游标，超限淘汰最旧；共享快照不重复计数。 |
| `grep` / `multi_grep` | 默认 20、每页最多 50；每文件最多收集 200 条。 |
| `context` | 最多 20 行，重叠上下文合并。 |
| 显示 | 单行最多 500 字符，整页 2,000 行 / 50 KiB，另加限制提示。 |

find 续页使用不可变快照；内容续页遇索引更新会要求重新查询。`perFileLimitReached` 表示文件可能还有遗漏，游标不能越过每文件收集上限。`outputTruncated` 表示展示可能不完整，续页不补回已裁剪的行尾或正文，应缩小查询或直接读文件。

单个多行模式按原生块返回，块可能裁到 512 字节；`nativeMultilineLimited` 和截断提示表示潜在不完整，计数不是实际匹配次数。多个 OR 模式中含换行会拒绝，需拆成单独请求。

## 路径与内容

- `path`、`exclude` 和内容 needle 分开处理；`constraints` 是原生过滤表达式，不是 shell 命令。精确文件查询不扩展为整个目录。
- 已存在的绝对文件按字面路径处理，包括 glob 字符、逗号、反斜杠和首尾空白；其他 glob 使用模式语义。相对输入外围空白视为填充。
- 含空白的实际目录可建立独立索引；过滤表达式不支持含空白的文件名/glob 或 shell 引号转义，应搜索所在目录再读取文件。
- basename glob 可用 `path: "*.rs"`；直接传 `constraints` 可写 `"./*.rs"`。`exclude` 支持标量列表或数组，全范围排除确实排除整个根。
- 正则有效性先校验，无效正则按字面匹配；有效正则中的纯通配表达式、空白和 NUL 查询拒绝。`/api/users/`、连续空格与反斜杠属于内容数据，保留路径约束。

## 配置与索引

偏好来自全局 `[neuralSearch]`，字段和默认值见[参数指南](../../metis-pi-config.md#neuralsearch)：`enabled`、`mentions`、`enableFsRootScanning`、`enableHomeDirScanning`、`warnOnHomeDirScan`、`followSymlinks`、`frecencyDbPath`、`historyDbPath`。

`mentions` 控制 `@` 补全，不激活模型工具；目录导航交给宿主。`/neural-search health` 查看索引、监听、Git 和数据库状态，`rescan` 请求重扫。搜索根默认拒绝文件系统根目录，主目录扫描允许但警告；外部路径使用相同规则。

主索引状态目录默认 `<agentDir>/metis/neural-search/{frecency,history}`；两项数据库路径都是目录。辅助索引按精确扫描根复用，不使用主数据库；空闲缓存最多 3 个，闲置 5 分钟释放，执行中租约可暂时超额。这些是缓存预算，不是进程内存硬限制。

扫描遵循符号链接、忽略和 Git 规则，监视路径变化并更新排序。扫描或监听未完整就绪会返回部分状态，不能据此断言整个目录无匹配；可用 rescan 重试。数据库不可用时报告原因并允许无持久化搜索，不自动删除陌生数据库。

`METIS_NEURAL_SEARCH_LMDB_MAX_READERS` 仅控制底层 reader 容量，默认 1024、最小 126；变更后重启全部数据库使用者。

请求取消停止等待初始化，不销毁其他请求共用索引；原生同步检索不能由 JS 信号即时打断。会话结束释放索引；工具所有权被其他扩展接管时释放集成。更新原生库后必须重启 Pi，`/reload` 不卸载进程中的原生模块。

## 维护边界

实现、MIT 许可和来源位于 `src/neural-search/`，原生库与依赖许可位于其 `assets/`。`npm run build:neural-engine` 从源码构建，`verify:neural-engine` 校验源码、字节、ABI 与许可；prepack 校验，CI 重建。详细流程见[引擎维护指南](https://github.com/Rycen7822/metis-pi/blob/main/src/neural-search/engine/README.md)。
