# 动态全局指令

全局指令按实际的 provider 与模型 ID 选择。项目规则、祖先目录规则、skills、goal 和工具不受影响。文件与已有会话的正文也保持原样。

## 配置与匹配

`[dynamicAgents]` 默认 `enabled=false`、`notify=true`、`version=1`、`groups=[]`。要添加 array-of-tables 时，必须先删除同一表中的 `groups=[]`：

```toml
[dynamicAgents]
version = 1
enabled = true
notify = true

[[dynamicAgents.groups]]
id = "codex"
file = "./AGENTS-CODEX.md"
include = ["openai/*", "openai-codex/*"]
exclude = ["*-mini"]
```

每组要求唯一的 `id`、`file` 以及非空的 `include`。文件路径相对全局配置目录解析，也接受绝对路径。`~` 必须写成完整路径。路径中的双引号和换行会导致校验失败。文件内容必须可读且非空。文件不能与当前项目的指令来源相同。

| 规则 | 语义 |
| --- | --- |
| 含 `/` 的模式 | 匹配完整的 `provider/model.id`。 |
| 不含 `/` 的模式 | 匹配模型的完整 ID，或最后一个 `/` 之后的名称。 |
| 字符 | 区分大小写。支持字面量与可跨 `/` 的 `*`。 |
| 选择规则 | 任一 include 命中，且所有 exclude 都未命中，才算匹配。取第一个匹配的组，各组之间不合并。 |

校验覆盖全部组。未命中、功能关闭、配置或文件出错时，都回退到原生全局来源：`AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md`。出错时一定会告警。`notify=false` 只关闭正常切换时的提示。

## 生效与恢复

每次正式 run 之前，都会重读配置和文件。工具步骤共用同一份快照。run 中修改文件、切换模型或重载，都从下一次 run 开始生效。`/dynamic-agents` 显示模型、组、文件和待生效状态。`reload` 会标记刷新，并暂停旧快照的预热。这一操作不会发起模型请求。

`enabled=false` 之后，下一次 run 恢复原生指令。停用前应先恢复，或改用新会话。已产生的回复按其原样保留。

投影只替换全局指令块。普通消息、工具结果和摘要保持原样。辅助摘要沿用主 run 的快照。run 之前发生的普通压缩，沿用之前生效的指令。策略不变时复用缓存。切换策略可能使缓存前缀变冷。
