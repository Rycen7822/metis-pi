# Neural Search

Metis 维护的本地路径、内容与语义搜索，检索在本机执行，项目文件留在本机。

`find/grep/multi_grep` 随包提供 Linux x64 / glibc ≥2.31 和 Windows x64 的 FFF 原生库，需要保留可选依赖 `ffi-rs`。`semantic` 使用独立 CPU CLI，目前仅支持 Linux x64，另需准备通过验收的运行包；缺失时明确报错，查询路径与编译安装相互独立。Windows 更新 FFF 库前先退出加载它的 Pi 进程，详见[兼容性](../compatibility.md)。

## 一个入口，按需加载

`neural_search` 是 deferred 聚合工具。通过[统一 `tool_search`](tool-discovery.md) 发现或重新搜索，codemode 内使用 `tools.tool_search(args)`；
顶层参数可再次精确描述，动作细参仍用工具自己的 `describe` 读取。索引在首次查询时才启动，managed 子代理的权限仍由 profile 决定。

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
| `semantic` | 全选定范围语义 Top200 与 BM25 混合检索，保持原排名，FFF 常用度独立于该 action。 |
| `describe` | 返回操作说明和 schema。 |

激活后的定义会进入后续请求。精确参数以 `describe` 为准，游标只能续同一会话、操作和查询。

## 语义搜索

```js
neural_search({ action: "describe", target: "semantic" })
neural_search({ action: "semantic", params: { query: "缓存容量不足时继续完整搜索", path: "src/", model: "auto", limit: 5 } })
```

`path` 是现有文件或目录，支持相对 cwd、绝对路径及 `~/`；glob、`exclude`、FFF 过滤表达式请走 find/grep。每次对所选范围全部片段评分，候选集合独立于其他 action。`auto` 在全范围均为 prose 时使用 Bekko128，否则整次使用 LateOn token48；也可显式选择 `text` 或 `code`。

`limit` 默认 5、最多 100，仅限制排序后的返回数量，无分页游标。返回保留完整记录的排名前缀，超过 50,000 字节展示预算时标记 `outputTruncated` 并提供省略位置；JSON 传输超过 16MiB 时明确报错。分数、文件和行范围由 CLI 提供并原样透传。`scope` 是所选文件/目录，`root` 是返回路径的目录基准，单文件搜索时为其父目录。`limitReached` 表示返回数已达上限，剩余结果数量未知。

Agent 文本用 `--- path:start-end ---` 标记各片段，保留原文缩进，不逐行添加行号；codemode 的 `results[]` 保留原有字段与原始 `content`。

请求（含排队/初始化）默认超时 1800 秒，`timeoutSeconds` 为 1–3600。取消、超时、会话或 cwd 变更会终止自有 CLI 客户端组并确认清理，服务只取消对应请求，其他客户端和共享服务继续运行。失败保持原有错误语义并说明原因；缓存缺失但完整计算正常时输出明确诊断。

Linux x64 / glibc 2.39+ 下，首次安装 Metis 和后续 `pi update --extensions` 通过安装生命周期自动准备预编译运行数据，无需额外安装命令、Python 模型转换或本机编译。local 包或被跳过的安装脚本由首次 semantic 调用自动补齐，受请求取消和超时约束。

引擎、Bekko、LateOn 使用三个固定版本发布包。模型按资产身份独立缓存在 `<agentDir>/metis/neural-search/semantic/linux-x64/objects/`，普通 Metis 更新和引擎更换都复用已有模型。已有完整旧安装的匹配模型会验证后实体迁移。下载时校验发布包完整性，未变模型复用原完整性 receipt，查询热路径与 hash 计算分离。

每个运行代只含实体引擎副本与引用共享模型目录的可信 catalog；实际加载、编码、评分两模型后才原子切换 `current` 文件。旧运行代和活跃映射保留，失败沿用旧选择，链接和进程管理遵循既有合同。已有服务按原排空/idle 合同退出后使用新代。

包内 `assets/semantic/linux-x64/bin/sgrep` 是保持 PID/参数的 exec 入口。`SGREP_RUNTIME_DIR` 指向的独立可信运行包优先于包内资产，工具参数指定的程序路径会被忽略。catalog V2 保留固定模型 revision、文件集合及原有完整性验证，允许引用共享绝对模型目录；V1 远端合同保留。V2 的 `--cache-dir` 只重定位语料/parser 状态，权重留在包内；`--fresh-assets` 仅限 V1。

Metis 使用同 UID/规范 HOME 的私有共享模型服务，同代模型在所有仓库间共用；LateOn/Bekko 按需各加载一份，最多 3 请求×4 计算线程，超出有界排队。`[neuralSearch.semantic].idleTimeoutSeconds` 默认 300，接受整数 1–86400 秒，下一请求生效；工作/排队清空后计空闲，status 保持独立计时，stop 先排空。详见[核心服务](../../src/neural-search/semantic/README.md#cli-and-shared-service)。

缓存磁盘预算由全局 `[neuralSearch.semantic].cacheBudgetMiB` 设置为整数 256、512、1024，默认 512MiB，下一次语义调用读取新快照，无需为此重载。所有缓存根共享同一 HOME 峰值预算；降档 pending 表示目标档尚未生效。结果中的 `cacheBudgetRequestedMiB` 只代表本次配置请求，账本实际档位以状态接口为准。超额时完整流式计算，语料保持完整，磁盘档位与 RAM、线程、cgroup 限制各自独立。

## 原生路径/内容搜索的参数与分页

| 预算 | 限制 |
| --- | --- |
| `find` | 默认 30、每页最多 100；完整快照最多 10,000 条，超出需缩小范围。 |
| find 游标缓存 | 不同快照合计 20,000 条、200 个游标，超限淘汰最旧；共享快照不重复计数。 |
| `grep` / `multi_grep` | 默认 20、每页最多 50；每文件最多收集 200 条。 |
| `context` | 最多 20 行，重叠上下文合并。 |
| 显示 | 单行最多 500 字符，整页 2,000 行 / 50 KiB，另加限制提示。 |

find 续页使用不可变快照；内容续页遇索引更新会要求重新查询。`perFileLimitReached` 表示文件可能还有遗漏，游标止步于每文件收集上限。`outputTruncated` 表示展示可能不完整，已裁剪的行尾或正文留在原文件里，需要完整内容请缩小查询或直接读文件。

单个多行模式按原生块返回，块可能裁到 512 字节；`nativeMultilineLimited` 和截断提示表示潜在不完整，计数与实际匹配次数可能不同。多个 OR 模式含换行时请拆成单独请求。

## 原生路径与内容过滤

- `path`、`exclude` 和内容 needle 分开处理；`constraints` 是原生过滤表达式，与 shell 语法无关。精确文件查询只覆盖该文件。
- 已存在的绝对文件按字面路径处理，包括 glob 字符、逗号、反斜杠和首尾空白；其他 glob 使用模式语义。相对输入外围空白视为填充。
- 含空白的实际目录可建立独立索引；含空白的文件名/glob 和 shell 引号转义在过滤表达式里请改用“搜索所在目录再读取文件”。
- basename glob 可用 `path: "*.rs"`；直接传 `constraints` 可写 `"./*.rs"`。`exclude` 支持标量列表或数组，全范围排除确实排除整个根。
- 正则有效性先校验，无效正则按字面匹配；有效正则中的纯通配表达式、空白和 NUL 查询拒绝。`/api/users/`、连续空格与反斜杠属于内容数据，保留路径约束。

## 配置与 FFF 索引

偏好来自全局 `[neuralSearch]`，字段和默认值见[参数指南](../../metis-pi-config.md#neuralsearch)：`enabled`、`mentions`、`enableFsRootScanning`、`enableHomeDirScanning`、`warnOnHomeDirScan`、`followSymlinks`、`frecencyDbPath`、`historyDbPath`。

`mentions` 只管 `@` 补全，模型工具由独立开关控制；目录导航交给宿主。`/neural-search health` 查看索引、监听、Git 和数据库状态，`rescan` 请求重扫。文件系统根目录默认拒绝，主目录扫描允许并警告；外部路径同样规则。

主索引状态目录默认 `<agentDir>/metis/neural-search/{frecency,history}`；两项数据库路径都是目录。辅助索引按精确扫描根复用，与主数据库分开；空闲缓存最多 3 个，闲置 5 分钟释放，执行中租约可暂时超额。这些是缓存预算，进程内存另有 OS 上限。

扫描遵循符号链接、忽略和 Git 规则，监视路径变化并更新排序。扫描或监听未完整就绪会返回部分状态，此时空结果只代表本轮扫描范围；可用 rescan 重试。数据库不可用时报告原因并允许无持久化搜索，陌生数据库保持原样。

`METIS_NEURAL_SEARCH_LMDB_MAX_READERS` 仅控制底层 reader 容量，默认 1024、最小 126；变更后重启全部数据库使用者。

请求取消只停掉自己的等待，共享索引继续服务其他请求；原生同步检索的打断时机由原生层决定。会话结束释放索引；工具所有权被其他扩展接管时释放集成。更新原生库后必须重启 Pi，`/reload` 与进程内原生模块的卸载是两回事。

## 维护边界

实现、MIT 许可和来源位于 `src/neural-search/`，原生库与依赖许可位于其 `assets/`。`npm run build:neural-engine` 从源码构建，`verify:neural-engine` 校验源码、字节、ABI 与许可；prepack 校验，CI 重建。详细流程见[引擎维护指南](https://github.com/Rycen7822/metis-pi/blob/main/src/neural-search/engine/README.md)。
