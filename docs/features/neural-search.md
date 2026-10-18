# Neural Search

Metis 维护的本地文件与内容搜索组件，参考 `@ff-labs/pi-fff` 0.11.0；不再依赖独立 Pi 插件的注册、配置或生命周期。底层仍使用固定版本的 FFF Rust 原生引擎及 Node/Bun 绑定，搜索在本机完成，不上传项目文件。名称不代表向量、embedding 或模型语义检索。

## 一个入口，按需加载

唯一工具为 **`neural_search`**，注册为 `deferred`。默认请求只带简短目录，不展开参数 schema；组件启用 Pi 原生 `tool_search` 发现入口，**不会自动激活 `neural_search`**。

1. 通过 `tool_search` 发现 `neural_search`，使其可以原生直接调用。
2. `action: "describe"` 配合 `target` 获取所需操作的精确参数。
3. 以 `action` / `params` 直接执行。codemode 仍是可选路径，不是必经入口。

```js
neural_search({ action: "describe", target: "find" })
neural_search({ action: "find", params: { pattern: "profile", path: "src/", limit: 10 } })
neural_search({ action: "grep", params: { pattern: "ProfileStore", path: "src/", context: 2 } })
neural_search({ action: "multi_grep", params: { patterns: ["ProfileStore", "profile_store"], constraints: "src/" } })
```

只有一个聚合工具被注册，操作参数按需读取。发现与激活后，保持激活的定义会进入后续请求；这不是每次调用后自动撤回。无原生发现入口的定制 SDK 宿主会收到提示，须加载并启用 Pi 内置 `tool_search`。不再提供旧工具名或替换内置 `find` / `grep` 的 override 模式。

| action | 能力 |
| --- | --- |
| `find` | 路径模糊查找、glob 约束、Git/常用度排序；`pattern` 用于模糊查找，精确路径或 glob 放入 `path`。 |
| `grep` | 单模式内容搜索；智能大小写，自动识别有效正则，纯文本可使用模糊回退。 |
| `multi_grep` | 多个字面量模式的 OR 搜索，保留原生匹配顺序，不需要正则拼接。 |
| `describe` | 只读取指定操作的帮助和 schema，不执行搜索或启动索引。 |

`find` / `grep` 保留 `path`、`exclude` 和有界分页；`grep` 支持 `caseSensitive`、最多20行上下文。`multi_grep` 用 `constraints` 过滤路径。返回的 cursor 是当前组件会话/操作的分页凭据，不能跨操作、会话或变更查询复用；以 `describe` 返回的参数契约为准。

## 配置与交互

只读 `<agentDir>/metis-pi.toml` 的 `[neuralSearch]`，不读项目覆盖、旧 JSON、旧环境变量或命令行开关。默认值和字段说明见 [参数指南](../../metis-pi-config.md#neuralsearch)。修改后 `/reload` 或重启。

- `enabled` 控制本组件；`mentions` 独立控制编辑器的 `@` 文件/目录补全，不激活模型工具。
- `/neural-search health` 查看索引/引擎/数据库状态；`/neural-search rescan` 请求重扫。
- 默认禁止以文件系统根目录为搜索索引根；允许主目录索引并警告，可关闭。外部路径仍须遵守同样限制。
- 主目录索引可能消耗明显 CPU/内存；目录符号链接默认跟随，可按需要关闭。辅助根和分页状态有界，会话结束释放原生资源，晚到初始化不得重建已关闭实例。
- 数据库不可用时允许无持久化搜索，并报告原因，不修改或修复陌生数据库。
- 已处理固定引擎版本中的分页偏移、OR 内容预过滤漏匹配和 Bun 符号链接选项问题。为保证结果完整，关闭了有漏匹配风险的内容索引预过滤，仍使用本地原生搜索和 mmap 缓存。目录约束使用明确的 glob，避免相同名字的文件改变目录查找结果。
- 辅助索引缓存闲置时有数量/TTL 上限；并发执行中的租约可暂时超出缓存数量，释放后立即收敛，不是进程内存硬上限。已过期的游标直接报错，不为即将拒绝的续页重新建立索引。
- 数据库路径在读取全局配置时一次解析；数据库无法打开时，重试明确移除两个数据库路径，显式配置也不会泄漏到无持久化重试中。主索引与辅助索引使用同一份固定原生策略。
- `exclude="**/*"`、`exclude="!**/*"` 等全范围排除会排除整个搜索根，不等同于没有过滤条件。正向 `path="**/*"` 则表示整个搜索根。
- 覆盖主目录的警告统一按真实路径判断，包括主目录的上级目录和符号链接别名；这只统一提醒与状态显示，不扩大原有扫描拒绝规则。
- 请求取消会立即停止该请求对索引初始化的等待，不会销毁其他请求共用的索引；晚到的辅助租约仍会释放。底层同步检索本身不能在执行中由 JS 信号即时打断；零匹配查询仍优先扫描完整候选集，内部时间预算不是硬墙钟上限。
- 首次扫描超过等待时间后可继续查询已有索引，但结果会明确提示扫描尚未完成，不能据此断言整个目录无匹配。
- `src/../src/` 等目录路径按文件系统路径归一化。含空格的实际目录使用独立索引，并在返回文本说明真实搜索根；覆盖索引不能表达该相对路径时不复用。
- 原生过滤语法按空白分词，不支持含空白的文件名/glob 过滤，也不支持 shell 引号转义；这类路径明确报错，不再伪装成“无结果”。可先搜索其实际所在目录，再用 `read` 读取确切文件。`exclude`/`constraints` 字符串仍是原生过滤表达式，不是 shell 命令。

## 从独立插件切换

在安装本次 Metis 版本时，从 Pi 的 packages 列表移除独立 `npm:@ff-labs/pi-fff`，再重载或重启，避免两套工具、补全与索引同时运行。本仓库开发不会自动卸载你的包或改写个人配置。

旧 `pi-fff.json`、`FFF_*` / `PI_FFF_*` 环境变量、`--fff-*` 参数和会话模式不被新组件自动导入。将仍需要的偏好手工放到 `[neuralSearch]`；旧文件不删除或改写。

默认状态目录是 `<agentDir>/metis/neural-search/{frecency,history}`。不自动借用、搬迁或改写旧插件及编辑器的 LMDB 数据库。如需复用已积累的排序数据，可明确设置 `frecencyDbPath` / `historyDbPath`，并自行确认其他使用者的并发访问和备份要求；它们是数据库**目录**，不是单个 SQLite 文件。

回退旧插件需要重新启用其 package 和原配置，不依赖对新组件状态做反向迁移。旧会话中已有的工具记录仍是历史，不注册旧工具的执行别名。

## 维护边界

- 入口：`extensions/neural-search.ts`。
- 自有实现、MIT 许可与来源记录：`src/neural-search/`。
- 冻结参考：`references/pi-fff/`，不随 npm 包发布，不被运行时代码导入。
- 引擎依赖：可选的 `@ff-labs/fff-node` / `@ff-labs/fff-bun` 0.11.0；平台支持由引擎二进制决定。缺少对应绑定时首次实际搜索明确报错，不影响其他 Metis 功能的安装；需要本地搜索时不要省略可选依赖。开发验收应使用当前平台的真实引擎，不能以 mock 结果替代平台运行证据。
