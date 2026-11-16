# Neural Search

Metis 维护本地的路径、内容与语义搜索。检索在本机执行，项目文件不离开本机。

`find`、`grep`、`multi_grep` 随包提供 Linux x64（glibc 2.31 及以上）与 Windows x64 的 FFF 原生库。该库依赖可选依赖 `ffi-rs`，安装时需保留。`semantic` 使用独立的 CPU CLI，目前仅支持 Linux x64，另需准备通过验收的运行包。缺失时会明确报错。查询路径与编译安装相互独立。Windows 更新 FFF 库之前，先退出加载它的 Pi 进程，见[兼容性](../compatibility.md)。

## 一个入口，按需加载

`neural_search` 是 deferred 的聚合工具。通过[统一的 `tool_search`](tool-discovery.md) 发现或重新搜索。在 codemode 中使用 `tools.tool_search(args)`。顶层参数可以再次精确描述。动作的细参仍用工具自己的 `describe` 读取。索引在首次查询时才启动。managed 子代理的权限仍由 profile 决定。

```js
neural_search({ action: "describe", target: "find" })
neural_search({ action: "find", params: { pattern: "profile", path: "src/", limit: 10 } })
neural_search({ action: "grep", params: { pattern: "ProfileStore", path: "src/", context: 2 } })
neural_search({ action: "multi_grep", params: { patterns: ["ProfileStore", "profile_store"], path: "src/" } })
```

| action | 用途 |
| --- | --- |
| `find` | 模糊路径搜索，支持 glob 过滤，按 Git 与常用度排序。精确路径和 glob 放在 `path` 中。 |
| `grep` | 单个模式的内容搜索。支持智能大小写、有效正则，无效正则回退为字面量。 |
| `multi_grep` | 多个字面量的 OR 搜索。可用 `constraints` 另行过滤。 |
| `semantic` | 对所选范围的全部片段做语义检索。语义路与 BM25 路各取前 200 个候选，再混合排序。FFF 的常用度不影响该动作。 |
| `describe` | 返回动作的说明与 schema。 |

激活后的定义会进入后续请求。精确参数以 `describe` 为准。游标只能用于同一会话、同一动作和同一查询的续页。

## 语义搜索

```js
neural_search({ action: "describe", target: "semantic" })
neural_search({ action: "semantic", params: { query: "缓存容量不足时继续完整搜索", path: "src/", model: "auto", limit: 5 } })
```

`path` 是已存在的文件或目录，支持相对 cwd 的路径、绝对路径，以及 `~/`。glob、`exclude` 和 FFF 过滤表达式请使用 find 或 grep。每次都会对所选范围的全部片段评分，候选集合与其他动作无关。`model: "auto"` 在全部范围都是 prose 时使用 Bekko128，否则整次使用 LateOn token48。也可显式选择 `text` 或 `code`。

`limit` 默认为 5，最多 100。它只限制排序后返回的条数，没有分页游标。返回的是完整记录的排名前缀。超过 50,000 字节的展示预算时，标记 `outputTruncated` 并给出省略位置。JSON 传输超过 16 MiB 时直接报错。分数、文件和行范围由 CLI 提供，原样透传。`scope` 是所选的文件或目录。`root` 是返回路径的基准目录，单文件搜索时为其父目录。`limitReached` 表示返回数已达上限，剩余结果的数量未知。

Agent 收到的文本用 `--- path:start-end ---` 分隔各片段，保留原文缩进，不逐行添加行号。codemode 中的 `results[]` 保留原有字段与原始 `content`。

请求（包括排队与初始化）的默认超时为 1800 秒，`timeoutSeconds` 的范围是 1 至 3600。取消、超时、会话或 cwd 变化，都会终止自有 CLI 客户端所在的进程组，并确认清理完成。服务端只取消对应的请求，其他客户端与共享服务继续运行。失败保留原有的错误语义并说明原因。缓存缺失但完整计算成功时，输出明确的诊断。

Linux x64、glibc 2.39 及以上环境中，首次安装 Metis 和之后的 `pi update --extensions` 会通过安装生命周期自动准备预编译的运行数据。无需额外的安装命令、Python 模型转换或本机编译。local 包或被跳过的安装脚本，由首次 semantic 调用自动补齐，并受请求取消与超时约束。

引擎、Bekko 和 LateOn 使用三个固定版本的发布包。模型按资产身份分别缓存在 `<agentDir>/metis/neural-search/semantic/linux-x64/objects/` 下。普通的 Metis 更新和引擎更换会复用已有模型。已有完整旧安装的匹配模型，会验证后迁移为实体文件。下载时校验发布包的完整性。未变化的模型复用原有的完整性收据，查询热路径与哈希计算分离。

每个运行代只包含实体引擎副本，以及引用共享模型目录的可信 catalog。加载、编码、评分两个模型后，才原子切换 `current` 文件。旧运行代和活跃映射保留。失败时沿用旧的选择。链接与进程管理遵循既有合同。已有服务按原有的排空或 idle 合同退出，然后使用新的运行代。

包内的 `assets/semantic/linux-x64/bin/sgrep` 是保持 PID 与参数的 exec 入口。`SGREP_RUNTIME_DIR` 指向的独立可信运行包优先于包内资产。工具参数指定的程序路径会被忽略。catalog V2 保留固定的模型 revision、文件集合与原有的完整性验证，允许引用共享的绝对模型目录。V1 远端合同保持不变。V2 的 `--cache-dir` 只重定位语料与 parser 状态，权重仍留在包内。`--fresh-assets` 仅适用于 V1。

Metis 使用同 UID、规范 HOME 下的私有共享模型服务。同一代模型在所有仓库之间共用。LateOn 与 Bekko 按需各加载一份，最多同时处理 3 个请求，每个请求 4 个计算线程。超出部分有界排队。`[neuralSearch.semantic].idleTimeoutSeconds` 默认 300，接受 1 至 86400 的整数，下一次请求生效。工作与排队清空后开始计算空闲。status 独立计时，stop 会先排空。详见[核心服务](../../src/neural-search/semantic/README.md#cli-and-shared-service)。

语义缓存的磁盘预算由全局的 `[neuralSearch.semantic].cacheBudgetMiB` 设置，可取 256、512、1024，默认 512 MiB。下一次语义调用读取新的快照，无需重载。所有缓存根共享同一 HOME 下的峰值预算。降档时 pending 表示目标档位尚未生效。结果中的 `cacheBudgetRequestedMiB` 只代表本次请求的配置。账本实际档位以状态接口为准。超额时完整流式计算，语料保持完整。磁盘档位与 RAM、线程、cgroup 限制各自独立。

## 原生路径与内容搜索的参数与分页

| 预算 | 限制 |
| --- | --- |
| `find` | 默认 30，每页最多 100。完整快照最多 10,000 条，超出需缩小范围。 |
| find 游标缓存 | 不同快照合计 20,000 条，最多 200 个游标。超限时淘汰最旧的。共享快照不重复计数。 |
| `grep`、`multi_grep` | 默认 20，每页最多 50。每个文件最多收集 200 条。 |
| `context` | 最多 20 行。重叠的上下文合并。 |
| 显示 | 单行最多 500 字符。整页 2,000 行或 50 KiB，并附带限制提示。 |

find 续页使用不可变快照。内容续页遇到索引更新时，会要求重新查询。`perFileLimitReached` 表示某个文件可能还有遗漏。游标在每文件收集上限处停止。`outputTruncated` 表示展示可能不完整。被裁剪的行尾或正文仍在原文件中。需要完整内容时，请缩小查询范围，或直接读取文件。

单个多行模式按原生块返回，块可能被裁剪到 512 字节。`nativeMultilineLimited` 与截断提示表示结果可能不完整。计数与实际匹配次数可能不同。多个含换行的 OR 模式，请拆成单独的请求。

## 原生路径与内容过滤

- `path`、`exclude` 和内容的 needle 分开处理。`constraints` 是原生过滤表达式，与 shell 语法无关。精确文件查询只覆盖该文件。
- 已存在的绝对文件按字面路径处理，包括 glob 字符、逗号、反斜杠与首尾空白。其他 glob 使用模式语义。相对路径两端的空白视为填充。
- 含空白的实际目录可以建立独立索引。含空白的文件名、glob 以及 shell 引号转义，在过滤表达式中请改用“搜索所在目录，再读取文件”的方式。
- basename glob 可用 `path: "*.rs"`。直接传入 `constraints` 时，可写 `"./*.rs"`。`exclude` 支持标量或数组。全范围排除会排除整个根目录。
- 正则先校验有效性。无效正则按字面量匹配。有效正则中的纯通配表达式、空白与 NUL 查询会被拒绝。`/api/users/`、连续空格和反斜杠属于内容数据，路径约束保持不变。

## 配置与 FFF 索引

偏好设置来自全局 `[neuralSearch]`。字段与默认值见[参数指南](../../metis-pi-config.md#neuralsearch)：`enabled`、`mentions`、`enableFsRootScanning`、`enableHomeDirScanning`、`warnOnHomeDirScan`、`followSymlinks`、`frecencyDbPath`、`historyDbPath`。

`mentions` 只控制 `@` 补全。模型工具由独立的开关控制。目录导航交给宿主。`/neural-search health` 查看索引、监听、Git 与数据库状态。`rescan` 请求重新扫描。文件系统根目录默认拒绝扫描。主目录允许扫描，但会告警。外部路径遵循同样的规则。

主索引的状态目录默认为 `<agentDir>/metis/neural-search/{frecency,history}`。两项数据库路径都是目录。辅助索引按精确扫描根复用，与主数据库分开。空闲缓存最多保留 3 个，闲置 5 分钟后释放。执行中的租约可以暂时超额。这些是缓存预算。进程内存另受操作系统的上限约束。

扫描遵循符号链接、忽略规则和 Git 规则，监视路径变化并更新排序。扫描或监听未完成就绪时，返回部分状态。此时空结果只代表本轮扫描的范围。可以用 rescan 重试。数据库不可用时报告原因，并允许无持久化的搜索。无法识别的数据库保持原样。

`METIS_NEURAL_SEARCH_LMDB_MAX_READERS` 只控制底层 reader 的容量，默认 1024，最小 126。修改后需重启所有使用数据库的进程。

请求取消只停止自己的等待，共享索引继续服务其他请求。原生同步检索何时中断，由原生层决定。会话结束时释放索引。工具的所有权被其他扩展接管时，释放集成。更新原生库后必须重启 Pi。`/reload` 与进程内原生模块的卸载不是同一件事。

## 维护边界

实现、MIT 许可与来源位于 `src/neural-search/`。原生库与依赖许可位于其 `assets/` 中。`npm run build:neural-engine` 从源码构建。`verify:neural-engine` 校验源码、字节、ABI 与许可。prepack 执行校验，CI 重新构建。详细流程见[引擎维护指南](https://github.com/Rycen7822/metis-pi/blob/main/src/neural-search/engine/README.md)。
