# 动态全局指令

全局指令按实际 provider/model ID 选择；项目规则、祖先规则、skills、goal、工具不受影响，文件与已有 session 正文也保持原样。

## 配置与匹配

`[dynamicAgents]` 默认 `enabled=false`、`notify=true`、`version=1`、`groups=[]`。添加 array-of-tables 时，同表的 `groups=[]` 必须先移除：

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

每组要求唯一 id、file 和非空 include。文件相对全局配置目录解析，也接受绝对路径；`~` 需写为完整路径，路径中的双引号和换行会导致校验失败，内容须可读非空，且与当前项目指令来源保持不同文件。

| 规则 | 语义 |
| --- | --- |
| 含 `/` 的模式 | 匹配完整 `provider/model.id`。 |
| 其余模式 | 匹配模型完整 ID，或最后一个 `/` 后的名称。 |
| 字符 | 区分大小写，支持字面量与可跨 `/` 的 `*`。 |
| 选择 | 任一 include 命中且全部 exclude 放行；取第一组，组间不合并。 |

校验覆盖全部组。未命中、关闭、配置或文件出错时，按 `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` 回到原生全局来源；出错必定告警，`notify=false` 只关闭正常切换提示。

## 生效和恢复

每次正式 run 前重读配置和文件，工具步骤共用同一快照；run 中改文件、切模型或 reload，都从下一 run 开始生效。`/dynamic-agents` 展示模型、组、文件和待生效状态，`reload` 标记刷新并暂停旧快照预热，因此不产生模型请求。

`enabled=false` 后，下一 run 恢复原生指令。停用入口前应先恢复，或改用新会话；已产生的回复语义随回复本身保留。

投影只替换全局块，普通消息、工具结果、摘要均保持原样。辅助摘要沿用主 run 快照；run 前的普通 compaction 沿用之前生效的指令。策略未变时复用缓存，切换策略可能使缓存前缀变冷。
